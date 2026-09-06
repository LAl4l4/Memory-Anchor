import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';


import {
  ANCHOR_DIR_NAME,
  GUARDRAILS_DEFAULT_RULES as BALLAST_DEFAULT_RULES,
  GUARDRAILS_DEFAULT_TITLE as BALLAST_DEFAULT_TITLE,
  GUARDRAILS_FILE_NAME as BALLAST_FILE_NAME,
  GUARDRAILS_SPECIFIC_TITLE as BALLAST_SPECIFIC_TITLE,
} from '../../dist/constant.js';
import type { GitChange } from '../../dist/utils/captureGitChanges.js';


const originalCwd = process.cwd();

let updateManifest: typeof import('../../dist/hooks/public/sessionEndPublic.js').updateProjectState;
let sanitizeBallast: typeof import('../../dist/hooks/public/sessionEndPublic.js').sanitizeGuardrails;
let tempDir = '';
let anchorPath = '';
let ballastPath = '';

const SAMPLE_BALLAST = `${BALLAST_DEFAULT_TITLE}
${BALLAST_DEFAULT_RULES.join('\n')}

${BALLAST_SPECIFIC_TITLE}
- [ ] Never use eval() in production code.
- [ ] Always add tests for sample.ts helpers.
- [ ] Follow the initBallast.ts convention for section markers.`;

const SAMPLE_BALLAST_EXTRA_SPECIFIC = `${BALLAST_DEFAULT_TITLE}
${BALLAST_DEFAULT_RULES.join('\n')}

${BALLAST_SPECIFIC_TITLE}
- [ ] Never use eval() in production code.
- [ ] Always add tests for sample.ts helpers.
- [ ] Always add tests for sample.js helpers.`;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-sessionend-'));
  process.chdir(tempDir);
  anchorPath = path.join(tempDir, ANCHOR_DIR_NAME);
  ballastPath = path.join(anchorPath, BALLAST_FILE_NAME);
  await mkdir(anchorPath, { recursive: true });

  jest.resetModules();

  ({
    updateProjectState: updateManifest,
    sanitizeGuardrails: sanitizeBallast,
  } = await import('../../dist/hooks/public/sessionEndPublic.js'));
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function changes(...entries: Array<[GitChange['status'], string]>): GitChange[] {
  return entries.map(([status, file]) => ({ status, file }));
}

function mockProcessExit() {
  return jest.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
}

// ── updateManifest ──────────────────────────────────────────────────

test('updateManifest logs modified file to stderr', () => {
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

  updateManifest(changes(['M', 'src/index.ts']));

  expect(spy).toHaveBeenCalledWith(
    expect.stringContaining('`src/index.ts` (Modified)')
  );

  spy.mockRestore();
});

test('updateManifest logs added file to stderr', () => {
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

  updateManifest(changes(['A', 'src/new.ts']));

  expect(spy).toHaveBeenCalledWith(
    expect.stringContaining('`src/new.ts` (Added)')
  );

  spy.mockRestore();
});

test('updateManifest logs untracked file to stderr', () => {
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

  updateManifest(changes(['??', 'src/untracked.ts']));

  expect(spy).toHaveBeenCalledWith(
    expect.stringContaining('`src/untracked.ts` (Untracked)')
  );

  spy.mockRestore();
});

test('updateManifest logs multiple changes', () => {
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

  updateManifest(changes(['M', 'a.ts'], ['A', 'b.ts']));

  const callArg = spy.mock.calls[0][0];
  expect(callArg).toContain('`a.ts` (Modified)');
  expect(callArg).toContain('`b.ts` (Added)');

  spy.mockRestore();
});

test('updateManifest does NOT log when changes is null', () => {
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

  updateManifest(null);

  expect(spy).not.toHaveBeenCalled();

  spy.mockRestore();
});

test('updateManifest does NOT log when changes is empty array', () => {
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

  updateManifest([]);

  expect(spy).not.toHaveBeenCalled();

  spy.mockRestore();
});

// ── sanitizeBallast ─────────────────────────────────────────────────

test('sanitizeBallast preserves the two-section structure', async () => {
  await writeFile(ballastPath, SAMPLE_BALLAST);

  sanitizeBallast();
  const result = await readFile(ballastPath, 'utf8');

  expect(result).toContain(BALLAST_DEFAULT_TITLE);
  expect(result).toContain(BALLAST_SPECIFIC_TITLE);

  const defaultIdx = result.indexOf(BALLAST_DEFAULT_TITLE);
  const specificIdx = result.indexOf(BALLAST_SPECIFIC_TITLE);
  expect(defaultIdx).toBeLessThan(specificIdx);
});

test('sanitizeBallast keeps all default rules intact', async () => {
  await writeFile(ballastPath, SAMPLE_BALLAST);

  sanitizeBallast();
  const result = await readFile(ballastPath, 'utf8');

  for (const rule of BALLAST_DEFAULT_RULES) {
    expect(result).toContain(rule);
  }
});

test('sanitizeBallast keeps specific rules intact', async () => {
  await writeFile(ballastPath, SAMPLE_BALLAST);

  sanitizeBallast();
  const result = await readFile(ballastPath, 'utf8');

  expect(result).toContain('Never use eval() in production code.');
  expect(result).toContain('Always add tests for sample.ts helpers.');
});

test('sanitizeBallast deduplicates duplicate rules', async () => {
  await writeFile(ballastPath, SAMPLE_BALLAST_EXTRA_SPECIFIC);

  sanitizeBallast();
  const result = await readFile(ballastPath, 'utf8');

  const matches = result.match(/Always add tests for sample\.ts helpers\./g);
  expect(matches).toHaveLength(1);
});

test('sanitizeBallast normalizes non-standard rule formats to - [ ]', async () => {
  const messy = `${BALLAST_DEFAULT_TITLE}
${BALLAST_DEFAULT_RULES.join('\n')}

${BALLAST_SPECIFIC_TITLE}
* Use tabs
1. Use semicolons
[ ] Use strict mode`;

  await writeFile(ballastPath, messy);

  sanitizeBallast();
  const result = await readFile(ballastPath, 'utf8');

  expect(result).toContain('- [ ] Use tabs');
  expect(result).toContain('- [ ] Use semicolons');
  expect(result).toContain('- [ ] Use strict mode');
  expect(result).not.toContain('* Use tabs');
  expect(result).not.toContain('1. Use semicolons');
  expect(result).not.toMatch(/- \[ \] \* Use tabs/);
});

test('sanitizeBallast normalizes unrecognized lines into - [ ] rules', async () => {
  const withJunk = `${BALLAST_DEFAULT_TITLE}
${BALLAST_DEFAULT_RULES.join('\n')}

${BALLAST_SPECIFIC_TITLE}
- [ ] Specific rule 1

some random text

- [ ] Specific rule 2`;

  await writeFile(ballastPath, withJunk);

  sanitizeBallast();
  const result = await readFile(ballastPath, 'utf8');

  expect(result).toContain('Specific rule 1');
  expect(result).toContain('Specific rule 2');
  expect(result).toContain('- [ ] some random text');
});

test('sanitizeGuardrails is no-op when guardrails.md does not exist', () => {
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(() => sanitizeBallast()).not.toThrow();
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

// ── runSessionEnd (end-to-end via mocked chart + real git) ──────────

function initGitRepo(cwd: string): void {
  execSync('git init', { cwd });
  execSync('git config user.email "test@test.com"', { cwd });
  execSync('git config user.name "Test"', { cwd });
}

test('runSessionEnd orchestrates full pipeline when git changes exist', async () => {
  initGitRepo(tempDir);

  await mkdir(path.join(tempDir, 'src'), { recursive: true });
  await writeFile(path.join(tempDir, 'src', 'foo.ts'), 'export const foo = 1;');
  execSync('git add src/foo.ts && git commit -m "init"', { cwd: tempDir });

  await writeFile(ballastPath, SAMPLE_BALLAST);
  await writeFile(path.join(tempDir, 'src', 'foo.ts'), 'export const foo = 2;');

  jest.resetModules();
  jest.unstable_mockModule('../../dist/chartBuild/buildChart.js', () => ({
    destroyPool: jest.fn(async () => {}),
  }));
  jest.unstable_mockModule('../../dist/chartBuild/incremental.js', () => ({
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
  }));

  const exitSpy = mockProcessExit();

  const sessionEndModule = await import('../../dist/hooks/public/sessionEndPublic.js');
  const buildChart = await import('../../dist/chartBuild/buildChart.js');
  const incremental = await import('../../dist/chartBuild/incremental.js');

  await sessionEndModule.runSessionEnd();

  const updateIncrementally = incremental.updatePartitionedChartIncrementally as jest.MockedFunction<
    typeof incremental.updatePartitionedChartIncrementally
  >;
  expect(updateIncrementally).toHaveBeenCalledTimes(1);
  const arg = updateIncrementally.mock.calls[0][0];
  expect(arg).toContain('src/foo.ts');
  expect(buildChart.destroyPool).toHaveBeenCalledTimes(1);
  expect(exitSpy).toHaveBeenCalledWith(0);

  const ballast = await readFile(ballastPath, 'utf8');
  expect(ballast).toContain(BALLAST_DEFAULT_TITLE);
  expect(ballast).toContain(BALLAST_SPECIFIC_TITLE);
  expect(ballast).toBe(SAMPLE_BALLAST);

  exitSpy.mockRestore();
});

test('runSessionEnd skips chart update when no git changes (clean repo)', async () => {
  initGitRepo(tempDir);

  await writeFile(ballastPath, SAMPLE_BALLAST);

  // 提交掉，防止ballast污染changes
  execSync('echo ".memoryanchor/" > .gitignore', {cwd: tempDir})
  execSync('git add .gitignore && git commit -m "ignore"', {cwd: tempDir})

  jest.resetModules();
  jest.unstable_mockModule('../../dist/chartBuild/buildChart.js', () => ({
    destroyPool: jest.fn(async () => {}),
  }));
  jest.unstable_mockModule('../../dist/chartBuild/incremental.js', () => ({
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
  }));

  const exitSpy = mockProcessExit();

  const sessionEndModule = await import('../../dist/hooks/public/sessionEndPublic.js');
  const buildChart = await import('../../dist/chartBuild/buildChart.js');
  const incremental = await import('../../dist/chartBuild/incremental.js');

  await sessionEndModule.runSessionEnd();

  expect(incremental.updatePartitionedChartIncrementally).not.toHaveBeenCalled();
  expect(buildChart.destroyPool).toHaveBeenCalledTimes(1);
  expect(exitSpy).toHaveBeenCalledWith(0);

  exitSpy.mockRestore();
});

test('runSessionEnd skips chart update when no git repo exists', async () => {
  await mkdir(anchorPath, { recursive: true });
  await writeFile(ballastPath, SAMPLE_BALLAST);

  jest.resetModules();
  jest.unstable_mockModule('../../dist/chartBuild/buildChart.js', () => ({
    destroyPool: jest.fn(async () => {}),
  }));
  jest.unstable_mockModule('../../dist/chartBuild/incremental.js', () => ({
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
  }));

  const exitSpy = mockProcessExit();

  const sessionEndModule = await import('../../dist/hooks/public/sessionEndPublic.js');
  const buildChart = await import('../../dist/chartBuild/buildChart.js');
  const incremental = await import('../../dist/chartBuild/incremental.js');

  await sessionEndModule.runSessionEnd();

  expect(incremental.updatePartitionedChartIncrementally).not.toHaveBeenCalled();
  expect(buildChart.destroyPool).toHaveBeenCalledTimes(1);
  expect(exitSpy).toHaveBeenCalledWith(0);

  exitSpy.mockRestore();
});


test('runSessionEnd retries an untracked deletion after refresh failure and acknowledges success', async () => {
  initGitRepo(tempDir);
  const update = jest.fn<() => Promise<void>>();
  update.mockResolvedValue(undefined);
  jest.resetModules();
  jest.unstable_mockModule('../../dist/chartBuild/buildChart.js', () => ({
    destroyPool: jest.fn(async () => {}),
  }));
  jest.unstable_mockModule('../../dist/chartBuild/incremental.js', () => ({
    updatePartitionedChartIncrementally: update,
  }));
  const exitSpy = mockProcessExit();
  try {
    const hook = await import('../../dist/hooks/public/sessionEndPublic.js');
    await writeFile('retry.ts', 'export const value = 1;');
    await hook.runSessionEnd();
    await rm('retry.ts');
    update.mockClear();
    update.mockRejectedValueOnce(new Error('refresh failed'));
    await expect(hook.runSessionEnd()).rejects.toThrow('refresh failed');
    expect(update).toHaveBeenLastCalledWith(['retry.ts']);
    await hook.runSessionEnd();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(['retry.ts']);
    await hook.runSessionEnd();
    expect(update).toHaveBeenCalledTimes(2);
  } finally {
    exitSpy.mockRestore();
  }
});
