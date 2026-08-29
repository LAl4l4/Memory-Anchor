import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';


import {
  ANCHOR_DIR_NAME,
  CHART_FILE_NAME,
  GUARDRAILS_DEFAULT_TITLE,
  GUARDRAILS_FILE_NAME,
  GUARDRAILS_MAX_BYTES,
  GUARDRAILS_SPECIFIC_TITLE,
  PROJECT_STATE_FILE_NAME,
  PROJECT_STATE_MODULE_STATUS_MAX_BYTES,
} from '../../dist/constant.js';

const originalCwd = process.cwd();

let tempDir = '';
let anchorPath = '';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-sessionstart-'));
  process.chdir(tempDir);
  anchorPath = path.join(tempDir, ANCHOR_DIR_NAME);
  await mkdir(anchorPath, { recursive: true });
  jest.resetModules() // 只清缓存，不引
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('loadMemoryCore returns fallback strings when anchor files are absent', async () => {
  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).toContain('[MEMORY ANCHOR: CONTEXT INJECTED]');
  expect(result).toContain('[1. CHART (project structure & architectural symbols)]');
  expect(result).toContain('No project chart available.');
  expect(result).toContain('[2. GUARDRAILS (rules must follow)]');
  expect(result).toContain('No active coding constraints or lessons-learned enforced.');
  expect(result).toContain('[3. PROJECT STATE (module status & key decisions)]');
  expect(result).toContain('No active cross-session tasks found.');
});

test('loadMemoryCore returns chart, guardrails, and project-state content when files exist', async () => {
  const backtick = '\x60';
  const guardrailsContent = `${GUARDRAILS_DEFAULT_TITLE}
- [ ] Always check chart.md before accessing files.

${GUARDRAILS_SPECIFIC_TITLE}
- [ ] Never use ${backtick}eval()${backtick} in production code.`;

  const manifestContent = `## Module Status
### auth:
- functionality: handles login/logout
- status: Stable`;
  const chartContent = '# PROJECT CHART\n\n## 1. Directory Skeleton\n- /src/index.ts';

  await writeFile(path.join(anchorPath, CHART_FILE_NAME), chartContent);
  await writeFile(path.join(anchorPath, GUARDRAILS_FILE_NAME), guardrailsContent);
  await writeFile(path.join(anchorPath, PROJECT_STATE_FILE_NAME), manifestContent);

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).toContain('[MEMORY ANCHOR: CONTEXT INJECTED]');
  expect(result).toContain(chartContent);
  expect(result).toContain(guardrailsContent);
  expect(result).toContain(manifestContent);
  expect(result).not.toContain('No active coding constraints');
  expect(result).not.toContain('No active cross-session tasks found.');
  expect(result).not.toContain('No project chart available.');
});

test('loadMemoryCore always injects index rules and additionally injects the root chart', async () => {
  const indexContent = '# Project Chart Index\n\nindex-only-marker';
  const rootChartContent = `# PROJECT CHART

path:
.memoryanchor/chart/chart.md

root-chart-marker`;
  const chartDirectory = path.join(anchorPath, 'chart');
  await mkdir(chartDirectory, { recursive: true });
  await writeFile(path.join(anchorPath, CHART_FILE_NAME), indexContent);
  await writeFile(path.join(chartDirectory, 'chart.md'), rootChartContent);

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).toContain('[INDEX ROUTING RULES — ALWAYS INJECTED]');
  expect(result).toContain(indexContent);
  expect(result).toContain('[ROOT CHART ALREADY INJECTED — DO NOT READ IT AGAIN]');
  expect(result).toContain(rootChartContent);
});

test('loadMemoryCore injects MEMORY PRUNING task block when guardrails contain [STALE]', async () => {
  const guardrailsContent = '- [ ] Some stale rule [STALE] *(obsolete)*';

  await writeFile(path.join(anchorPath, GUARDRAILS_FILE_NAME), guardrailsContent);
  await writeFile(path.join(anchorPath, PROJECT_STATE_FILE_NAME), '## Module Status');

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).toContain('[TRIGGERED MISSION: MEMORY PRUNING]');
  expect(result).toContain('Urgent Status: Some developer-enforced limits');
  expect(result).toContain('Your Action Required');
});

test('loadMemoryCore does NOT inject MEMORY PRUNING when guardrails have no [STALE] markers', async () => {
  const guardrailsContent = '- [ ] Normal rule without stale marker\n- [ ] Another clean rule';

  await writeFile(path.join(anchorPath, GUARDRAILS_FILE_NAME), guardrailsContent);
  await writeFile(path.join(anchorPath, PROJECT_STATE_FILE_NAME), '## Module Status');

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).not.toContain('[TRIGGERED MISSION: MEMORY PRUNING]');
  expect(result).not.toContain('Urgent Status');
});

test('loadMemoryCore requests guardrails compaction when they exceed their byte limit', async () => {
  await writeFile(
    path.join(anchorPath, GUARDRAILS_FILE_NAME),
    `- [ ] ${'x'.repeat(GUARDRAILS_MAX_BYTES)}`,
  );
  await writeFile(path.join(anchorPath, PROJECT_STATE_FILE_NAME), '## Module Status\n### core');

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js');
  const result = loadMemoryCore();

  expect(result).toContain('[TRIGGERED MISSION: MEMORY COMPACTION]');
  expect(result).toContain('Shorten `guardrails.md`');
  expect(result).toContain(`limit: ${GUARDRAILS_MAX_BYTES} bytes`);
});

test('loadMemoryCore limits only the project-state Module Status section', async () => {
  const oversizedModules = `## Module Status\n${'m'.repeat(PROJECT_STATE_MODULE_STATUS_MAX_BYTES)}`;
  await writeFile(path.join(anchorPath, GUARDRAILS_FILE_NAME), '- [ ] Small rule');
  await writeFile(
    path.join(anchorPath, PROJECT_STATE_FILE_NAME),
    `${oversizedModules}\n\n## Key Decisions\n- compact decision`,
  );

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js');
  const result = loadMemoryCore();

  expect(result).toContain('[TRIGGERED MISSION: MEMORY COMPACTION]');
  expect(result).toContain('Shorten only the `## Module Status` section');
  expect(result).toContain(`limit: ${PROJECT_STATE_MODULE_STATUS_MAX_BYTES} bytes`);
});

test('loadMemoryCore ignores an oversized Key Decisions section', async () => {
  await writeFile(path.join(anchorPath, GUARDRAILS_FILE_NAME), '- [ ] Small rule');
  await writeFile(
    path.join(anchorPath, PROJECT_STATE_FILE_NAME),
    `## Module Status\n### core\n- status: Stable\n\n## Key Decisions\n- ${'d'.repeat(PROJECT_STATE_MODULE_STATUS_MAX_BYTES + 1)}`,
  );

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js');
  const result = loadMemoryCore();

  expect(result).not.toContain('[TRIGGERED MISSION: MEMORY COMPACTION]');
});

test('loadMemoryCore reads guardrails from file but project state falls back when missing', async () => {
  const guardrailsContent = '- [ ] Guardrails-loaded rule';

  await writeFile(path.join(anchorPath, GUARDRAILS_FILE_NAME), guardrailsContent);

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).toContain(guardrailsContent);
  expect(result).toContain('No active cross-session tasks found.');
});

test('loadMemoryCore reads project state from file but guardrails fall back when missing', async () => {
  const manifestContent = '## Module Status\n### core:\n- status: Stable';

  await writeFile(path.join(anchorPath, PROJECT_STATE_FILE_NAME), manifestContent);

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).toContain('No active coding constraints or lessons-learned enforced.');
  expect(result).toContain(manifestContent);
});

test('loadMemoryCore result is wrapped in MEMORY ANCHOR delimiter markers', async () => {
  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result.startsWith('\n==================================================')).toBe(true);
  expect(result.endsWith('==================================================\n')).toBe(true);
});

test('loadMemoryCore trims whitespace from file content', async () => {
  const guardrailsContent = '\n\n  - [ ] Trim me  \n\n';
  const manifestContent = '\n\n  ## Module Status  \n\n';

  await writeFile(path.join(anchorPath, GUARDRAILS_FILE_NAME), guardrailsContent);
  await writeFile(path.join(anchorPath, PROJECT_STATE_FILE_NAME), manifestContent);

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).toContain('- [ ] Trim me');
  expect(result).not.toContain('  - [ ] Trim me  ');
});
