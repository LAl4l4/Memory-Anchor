import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';


import {
  ANCHOR_DIR_NAME,
  BALLAST_DEFAULT_RULES,
  BALLAST_DEFAULT_TITLE,
  BALLAST_FILE_NAME,
  BALLAST_SPECIFIC_TITLE,
} from '../dist/constant.js';


const originalCwd = process.cwd();

let updateManifest;
let cleanBallastRules;
let sanitizeBallast;
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
    updateManifest,
    cleanBallastRules,
    sanitizeBallast,
  } = await import('../dist/hooks/public/sessionEndPublic.js'));
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function changes(...entries) {
  return entries.map(([status, file]) => ({ status, file }));
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

// ── cleanBallastRules ───────────────────────────────────────────────

test('cleanBallastRules marks matching code-file rules with [STALE]', async () => {
  await writeFile(ballastPath, SAMPLE_BALLAST);

  cleanBallastRules(changes(['M', 'src/tests/sample.ts']));

  const updated = await readFile(ballastPath, 'utf8');
  expect(updated).toContain('[STALE]');
  expect(updated).toContain('Always add tests for sample.ts helpers');
  expect(updated).toContain('Never use eval()'); // eval rule untouched — unrelated file
  expect(updated).not.toContain('Never use eval() [STALE]');
});

test('cleanBallastRules does NOT mark [STALE] when the rule already has one', async () => {
  const content = SAMPLE_BALLAST.replace(
    '- [ ] Always add tests for sample.ts helpers.',
    '- [ ] Always add tests for sample.ts helpers. [STALE] *(already stale)*'
  );
  await writeFile(ballastPath, content);

  const before = await readFile(ballastPath, 'utf8');
  cleanBallastRules(changes(['M', 'src/tests/sample.ts']));
  const after = await readFile(ballastPath, 'utf8');

  expect(after).toBe(before);
});

test('cleanBallastRules skips blacklisted files (AGENTS.md, README.md)', async () => {
  await writeFile(ballastPath, SAMPLE_BALLAST);

  cleanBallastRules(changes(['M', 'AGENTS.md']));

  const updated = await readFile(ballastPath, 'utf8');
  expect(updated).not.toContain('[STALE]');
});

test('cleanBallastRules skips non-code files', async () => {
  await writeFile(ballastPath, SAMPLE_BALLAST);

  cleanBallastRules(changes(['M', 'docs/readme.txt']));

  const updated = await readFile(ballastPath, 'utf8');
  expect(updated).not.toContain('[STALE]');
});

test('cleanBallastRules is no-op when ballast.md does not exist', () => {
  expect(() => cleanBallastRules(changes(['M', 'src/foo.ts']))).not.toThrow();
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

test('sanitizeBallast is no-op when ballast.md does not exist', () => {
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(() => sanitizeBallast()).not.toThrow();
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

// ── runSessionEnd (end-to-end via mocked chart + real git) ──────────

function initGitRepo(cwd) {
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
  jest.unstable_mockModule('../dist/chartBuild/build-chart.js', () => ({
    destroyPool: jest.fn(async () => {}),
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
    buildChartFull: jest.fn(async () => {}),
  }));

  jest.spyOn(process, 'exit').mockImplementation(() => {});

  const sessionEndModule = await import('../dist/hooks/public/sessionEndPublic.js');
  const buildChart = await import('../dist/chartBuild/build-chart.js');

  await sessionEndModule.runSessionEnd();

  expect(buildChart.updatePartitionedChartIncrementally).toHaveBeenCalledTimes(1);
  const arg = buildChart.updatePartitionedChartIncrementally.mock.calls[0][0];
  expect(arg).toContain('src/foo.ts');
  expect(buildChart.destroyPool).toHaveBeenCalledTimes(1);
  expect(process.exit).toHaveBeenCalledWith(0);

  const ballast = await readFile(ballastPath, 'utf8');
  expect(ballast).toContain(BALLAST_DEFAULT_TITLE);
  expect(ballast).toContain(BALLAST_SPECIFIC_TITLE);

  process.exit.mockRestore();
});

test('runSessionEnd skips chart update when no git changes (clean repo)', async () => {
  initGitRepo(tempDir);

  await writeFile(ballastPath, SAMPLE_BALLAST);

  // 提交掉，防止ballast污染changes
  execSync('echo ".memoryanchor/" > .gitignore', {cwd: tempDir})
  execSync('git add .gitignore && git commit -m "ignore"', {cwd: tempDir})

  jest.resetModules();
  jest.unstable_mockModule('../dist/chartBuild/build-chart.js', () => ({
    destroyPool: jest.fn(async () => {}),
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
    buildChartFull: jest.fn(async () => {}),
  }));

  jest.spyOn(process, 'exit').mockImplementation(() => {});

  const sessionEndModule = await import('../dist/hooks/public/sessionEndPublic.js');
  const buildChart = await import('../dist/chartBuild/build-chart.js');

  await sessionEndModule.runSessionEnd();

  expect(buildChart.updatePartitionedChartIncrementally).not.toHaveBeenCalled();
  expect(buildChart.destroyPool).toHaveBeenCalledTimes(1);
  expect(process.exit).toHaveBeenCalledWith(0);

  process.exit.mockRestore();
});

test('runSessionEnd skips chart update when no git repo exists', async () => {
  await mkdir(anchorPath, { recursive: true });
  await writeFile(ballastPath, SAMPLE_BALLAST);

  jest.resetModules();
  jest.unstable_mockModule('../dist/chartBuild/build-chart.js', () => ({
    destroyPool: jest.fn(async () => {}),
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
    buildChartFull: jest.fn(async () => {}),
  }));

  jest.spyOn(process, 'exit').mockImplementation(() => {});

  const sessionEndModule = await import('../dist/hooks/public/sessionEndPublic.js');
  const buildChart = await import('../dist/chartBuild/build-chart.js');

  await sessionEndModule.runSessionEnd();

  expect(buildChart.updatePartitionedChartIncrementally).not.toHaveBeenCalled();
  expect(buildChart.destroyPool).toHaveBeenCalledTimes(1);
  expect(process.exit).toHaveBeenCalledWith(0);

  process.exit.mockRestore();
});
