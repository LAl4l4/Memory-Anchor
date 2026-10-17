import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GUARDRAILS_MAX_BYTES, LEGACY_GUARDRAILS_RULES } from '../../dist/constant.js';
import { buildMemoryCore } from '../../dist/hooks/public/memoryCore.js';

let workspace = '';
let anchorDir = '';
beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-context-'));
  anchorDir = path.join(workspace, '.memoryanchor');
  await mkdir(anchorDir);
});
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

test('missing memory files yield concise MCP guidance without placeholder sections', () => {
  const result = buildMemoryCore(workspace);
  expect(result).toContain('[MEMORY ANCHOR: CONTEXT INJECTED]');
  expect(result).toContain('get_chart({path})');
  expect(result).toContain('get_file({path})');
  expect(result).toContain('If MCP is unavailable');
  expect(result).not.toContain('index.md');
  expect(result).not.toContain('No active');
  expect(result).not.toContain('[GUARDRAILS');
});

test('session injects only repository rules and does not mutate legacy memory', async () => {
  const guardrails = `# Default Guardrails (do not modify)\n${LEGACY_GUARDRAILS_RULES.join('\n')}\n- [ ] Custom rule in default section.\n\n# Repository-specific Guardrails\n- [ ] Keep project constraint.\n`;
  await writeFile(path.join(anchorDir, 'guardrails.md'), guardrails);
  await mkdir(path.join(anchorDir, 'chart'));
  await writeFile(path.join(anchorDir, 'chart', 'chart.md'), 'ROOT-CHART-MARKER');
  await writeFile(path.join(anchorDir, 'index.md'), 'INDEX-MARKER');
  await writeFile(path.join(anchorDir, 'project-state.md'), 'MODULE-STATUS-MARKER');
  await writeFile(path.join(anchorDir, 'decisions.md'), 'DECISIONS-MARKER');
  const result = buildMemoryCore(workspace);
  expect(result).toContain('Custom rule in default section.');
  expect(result).toContain('Keep project constraint.');
  expect(result).not.toContain('Default Guardrails');
  for (const rule of LEGACY_GUARDRAILS_RULES) expect(result).not.toContain(rule);
  for (const marker of ['ROOT-CHART-MARKER', 'INDEX-MARKER']) {
    expect(result).not.toContain(marker);
  }
  expect(result).not.toContain('MODULE-STATUS-MARKER');
  expect(result).toContain('(whole document)');
  expect(result).toContain('DECISIONS-MARKER');
  expect(await readFile(path.join(anchorDir, 'guardrails.md'), 'utf8')).toBe(guardrails);
});

test('native session hook uses the shared compact renderer', async () => {
  const originalCwd = process.cwd();
  try {
    process.chdir(workspace);
    jest.resetModules();
    const { loadMemoryCore } = await import('../../dist/hooks/public/sessionStartPublic.js');
    expect(loadMemoryCore()).toBe(buildMemoryCore(workspace));
  } finally { process.chdir(originalCwd); }
});

test('oversized repository rules are injected in full with an advisory notice', async () => {
  const rule = `- [ ] ${'x'.repeat(GUARDRAILS_MAX_BYTES)}`;
  await writeFile(path.join(anchorDir, 'guardrails.md'), rule);
  const result = buildMemoryCore(workspace);
  expect(result).toContain(rule);
  expect(result).toContain('[MEMORY MAINTENANCE NOTICE]');
  expect(result).toContain('do not require action during the current task');
});

test('legacy stale markers remain advisory', async () => {
  await writeFile(path.join(anchorDir, 'guardrails.md'), '- [ ] Rule [STALE]');
  expect(buildMemoryCore(workspace)).toContain('legacy [STALE] markers');
});

test('large state injects only module names while decisions and budget notices remain', async () => {
  const state = `## Module Status\n### Parser\n${'m'.repeat(20000)}`;
  const decisions = `# Key Decisions\n${'d'.repeat(20000)}`;
  await writeFile(path.join(anchorDir, 'project-state.md'), state);
  await writeFile(path.join(anchorDir, 'decisions.md'), decisions);
  const result = buildMemoryCore(workspace);
  expect(result).not.toContain(state);
  expect(result).toContain('- "Parser"');
  expect(result).toContain(decisions);
  expect(result).toContain('project-state.md Module Status:');
});

test('decisions are injected independently when state is missing', async () => {
  await writeFile(path.join(anchorDir, 'decisions.md'), '- Independent decision');
  const result = buildMemoryCore(workspace);
  expect(result).toContain('- Independent decision');
  expect(result).not.toContain('[PROJECT STATE');
});

test('chart directory exposes one chart level and bounds large directories', async () => {
  const { createDirectoryTree, rebuildChartTree, toDirectoryTreeRegistry } = await import('../../dist/chartBuild/partition/directoryTree.js');
  const tree = createDirectoryTree(['.', 'src', 'src/deep', 'tests']);
  tree.isSplit = true;
  rebuildChartTree(tree);
  await writeFile(path.join(anchorDir, 'dirTree.json'), JSON.stringify(toDirectoryTreeRegistry(tree)));
  let result = buildMemoryCore(workspace);
  expect(result).toContain('- "src"');
  expect(result).not.toContain('src/deep');
  tree.isSplit = false;
  rebuildChartTree(tree);
  await writeFile(path.join(anchorDir, 'dirTree.json'), JSON.stringify(toDirectoryTreeRegistry(tree)));
  expect(buildMemoryCore(workspace)).not.toContain('- "src"');
  await writeFile(path.join(anchorDir, 'project-state.md'), '## Module Status\n' + Array.from({length: 80}, (_, i) => `### Module ${i}\n- notes: private detail`).join('\n'));
  result = buildMemoryCore(workspace);
  expect(result).toContain('60 more entries');
  expect(result).not.toContain('private detail');
  const { compactDirectory } = await import('../../dist/mcp/memoryCatalog.js');
  expect(compactDirectory(['x'.repeat(2000)], 'get_project_state({})').length).toBeLessThan(1600);
});
