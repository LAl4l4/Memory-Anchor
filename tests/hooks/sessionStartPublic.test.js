import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';


import { ANCHOR_DIR_NAME, BALLAST_DEFAULT_TITLE, BALLAST_FILE_NAME, BALLAST_SPECIFIC_TITLE, CHART_FILE_NAME, MANIFEST_FILE_NAME } from '../../dist/constant.js';

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
  expect(result).toContain('[2. BALLAST (rules must follow)]');
  expect(result).toContain('No active coding constraints or lessons-learned enforced.');
  expect(result).toContain('[3. MANIFEST (module status & key decisions)]');
  expect(result).toContain('No active cross-session tasks found.');
});

test('loadMemoryCore returns chart, ballast, and manifest content when files exist', async () => {
  const backtick = '\x60';
  const ballastContent = `${BALLAST_DEFAULT_TITLE}
- [ ] Always check chart.md before accessing files.

${BALLAST_SPECIFIC_TITLE}
- [ ] Never use ${backtick}eval()${backtick} in production code.`;

  const manifestContent = `## Module Status
### auth:
- functionality: handles login/logout
- status: Stable`;
  const chartContent = '# PROJECT CHART\n\n## 1. Directory Skeleton\n- /src/index.ts';

  await writeFile(path.join(anchorPath, CHART_FILE_NAME), chartContent);
  await writeFile(path.join(anchorPath, BALLAST_FILE_NAME), ballastContent);
  await writeFile(path.join(anchorPath, MANIFEST_FILE_NAME), manifestContent);

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).toContain('[MEMORY ANCHOR: CONTEXT INJECTED]');
  expect(result).toContain(chartContent);
  expect(result).toContain(ballastContent);
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

test('loadMemoryCore injects MEMORY PRUNING task block when ballast contains [STALE]', async () => {
  const ballastContent = '- [ ] Some stale rule [STALE] *(obsolete)*';

  await writeFile(path.join(anchorPath, BALLAST_FILE_NAME), ballastContent);
  await writeFile(path.join(anchorPath, MANIFEST_FILE_NAME), '## Module Status');

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).toContain('[TRIGGERED MISSION: MEMORY PRUNING]');
  expect(result).toContain('Urgent Status: Some developer-enforced limits');
  expect(result).toContain('Your Action Required');
});

test('loadMemoryCore does NOT inject MEMORY PRUNING when ballast has no [STALE] markers', async () => {
  const ballastContent = '- [ ] Normal rule without stale marker\n- [ ] Another clean rule';

  await writeFile(path.join(anchorPath, BALLAST_FILE_NAME), ballastContent);
  await writeFile(path.join(anchorPath, MANIFEST_FILE_NAME), '## Module Status');

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).not.toContain('[TRIGGERED MISSION: MEMORY PRUNING]');
  expect(result).not.toContain('Urgent Status');
});

test('loadMemoryCore reads ballast from file but manifest falls back when manifest is missing', async () => {
  const ballastContent = '- [ ] Ballast-loaded rule';

  await writeFile(path.join(anchorPath, BALLAST_FILE_NAME), ballastContent);

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).toContain(ballastContent);
  expect(result).toContain('No active cross-session tasks found.');
});

test('loadMemoryCore reads manifest from file but ballast falls back when ballast is missing', async () => {
  const manifestContent = '## Module Status\n### core:\n- status: Stable';

  await writeFile(path.join(anchorPath, MANIFEST_FILE_NAME), manifestContent);

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
  const ballastContent = '\n\n  - [ ] Trim me  \n\n';
  const manifestContent = '\n\n  ## Module Status  \n\n';

  await writeFile(path.join(anchorPath, BALLAST_FILE_NAME), ballastContent);
  await writeFile(path.join(anchorPath, MANIFEST_FILE_NAME), manifestContent);

  const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js')
  const result = loadMemoryCore();

  expect(result).toContain('- [ ] Trim me');
  expect(result).not.toContain('  - [ ] Trim me  ');
});
