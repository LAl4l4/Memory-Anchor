import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const originalCwd = process.cwd();

let buildChartFull;
let updateChartIncrementally;
let destroyPool;
let buildChartContent;
let ParserWorkerPool;
let tempDir = '';
let anchorDir = '';
let indexPath = '';
let chartPath = '';
let registryPath = '';

const fixtures = [
  { file: 'sample.c' },
  { file: 'sample.py' },
  { file: 'Sample.java' },
  { file: 'sample.js' },
  { file: 'sample.ts' }
];

const fixtureRelPaths = fixtures.map(({ file }) =>
  path.posix.join('tests', 'test-src', file)
);

const expectedExports = new Map([
  [path.posix.join('tests', 'test-src', 'sample.c'), ['- function add()']],
  [path.posix.join('tests', 'test-src', 'sample.py'), ['- function greet()']],
  [path.posix.join('tests', 'test-src', 'sample.js'), ['- export function add()']],
  [path.posix.join('tests', 'test-src', 'sample.ts'), ['- export function add()']]
]);
const incrementalRelPaths = Array.from(expectedExports.keys());

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNodeBlock(chartContent, relPath) {
  const matcher = new RegExp(
    `### \\/${escapeRegExp(relPath)}\\n([\\s\\S]*?)(?=\\n### \\/|$)`
  );
  const match = chartContent.match(matcher);
  return match ? match[1] : null;
}

async function cleanupAnchor() {
  if (!anchorDir) {
    return;
  }
  await rm(anchorDir, { recursive: true, force: true });
}

async function seedFixtures(baseDir) {
  const fixturesDir = path.join(baseDir, 'tests', 'test-src');
  await mkdir(fixturesDir, { recursive: true });

  for (const { file } of fixtures) {
    const source = path.join(repoRoot, 'tests', 'test-src', file);
    const destination = path.join(fixturesDir, file);
    await copyFile(source, destination);
  }
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-chart-'));
  process.chdir(tempDir);
  await seedFixtures(tempDir);

  ({ buildChartFull, updateChartIncrementally, destroyPool } = await import('../dist/chartBuild/build-chart.js'));
  ({ buildChartContent } = await import('../dist/chartBuild/chartBuildHelper/chartContentBuilder.js'));
  ({ ParserWorkerPool } = await import('../dist/chartBuild/chartBuildHelper/parserPool.js'));

  anchorDir = path.join(tempDir, '.memoryanchor');
  indexPath = path.join(anchorDir, 'index.md');
  chartPath = path.join(anchorDir, 'chart', 'chart.md');
  registryPath = path.join(anchorDir, 'dirTree.json');
});

beforeEach(async () => {
  await cleanupAnchor();
  await seedFixtures(tempDir);
});

afterAll(async () => {
  await destroyPool();
  await cleanupAnchor();
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('buildChartFull includes fixture paths in the skeleton', async () => {
  await buildChartFull();

  const indexContent = await readFile(indexPath, 'utf8');
  const chartContent = await readFile(chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  expect(indexContent).toContain('### Root');
  expect(indexContent).toContain('.memoryanchor/chart/chart.md');
  expect(normalizedChart).toContain('### tests/test-src/');
  for (const { file } of fixtures) {
    expect(normalizedChart).toContain(`- ${file}:`);
  }
});

test('ParserWorkerPool queues the full batch while lazily bounding workers', async () => {
  const localPool = new ParserWorkerPool();
  try {
    await localPool.init(3);
    expect(localPool.activeWorkerCount).toBe(0);

    const requests = Array.from({ length: 40 }, (_, index) => ({
      absolutePath: path.join(tempDir, 'tests', 'test-src', 'sample.ts'),
      relativePath: `tests/test-src/sample-${index}.ts`,
      lang: 'typescript'
    }));
    const parsed = Promise.all(requests.map(request => localPool.parse(
      request.absolutePath,
      request.relativePath,
      request.lang
    )));

    // All 40 tasks are accepted immediately, but only 3 worker slots exist.
    expect(localPool.activeWorkerCount).toBe(3);
    expect(localPool.peakOutstandingTaskCount).toBe(40);

    await expect(parsed).resolves.toHaveLength(40);
    expect(localPool.activeWorkerCount).toBe(3);
  } finally {
    await localPool.destroy();
  }
});

test('chart parse cache reuses symbols without reading the file twice', async () => {
  const relativePath = 'tests/test-src/sample.ts';
  const groups = new Map([['tests/test-src', [relativePath]]]);
  const parseCache = new Map();
  const first = await buildChartContent(groups, tempDir, parseCache);
  await rm(path.join(tempDir, relativePath));

  const second = await buildChartContent(groups, tempDir, parseCache);

  expect(parseCache).toHaveProperty('size', 1);
  expect(second).toBe(first);
});

test('buildChartContent renders its requested heading directly', async () => {
  const relativePath = 'tests/test-src/sample.ts';
  const groups = new Map([['tests/test-src', [relativePath]]]);

  const chart = await buildChartContent(
    groups,
    tempDir,
    new Map(),
    'CHART AT .memoryanchor/chart/tests/test-src/chart.md',
  );

  expect(chart).toMatch(/^# CHART AT \.memoryanchor\/chart\/tests\/test-src\/chart\.md\n/);
});

test('updateChartIncrementally preserves fixture architecture nodes', async () => {
  await buildChartFull();
  await updateChartIncrementally(incrementalRelPaths);

  const chartContent = await readFile(chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  for (const relPath of incrementalRelPaths) {
    expect(normalizedChart).toContain(`### /${relPath}`);
  }

  for (const [relPath, expectedLines] of expectedExports.entries()) {
    const nodeBlock = getNodeBlock(normalizedChart, relPath);
    expect(nodeBlock).not.toBeNull();

    for (const expectedLine of expectedLines) {
      expect(nodeBlock).toContain(expectedLine);
    }
  }

  const registryRaw = await readFile(registryPath, 'utf8');
  const registry = JSON.parse(registryRaw);
  expect(registry.directory).toBe('.');
  expect(registry.thisDirectoryChars).toBeGreaterThan(0);
});

test('updateChartIncrementally edits the matching partition and updates chars', async () => {
  await buildChartFull();
  const registryBefore = JSON.parse(await readFile(registryPath, 'utf8'));
  const changedFile = path.join(tempDir, 'tests', 'test-src', 'sample.ts');
  await writeFile(
    changedFile,
    'export function add(a: number, b: number): number { return a + b; }\n' +
      'export function newlyAdded(): string { return "new"; }\n'
  );

  await updateChartIncrementally(['tests/test-src/sample.ts']);

  const chartContent = await readFile(chartPath, 'utf8');
  const registryAfter = JSON.parse(await readFile(registryPath, 'utf8'));
  expect(chartContent).toContain('- export function newlyAdded()');
  expect(registryAfter.thisDirectoryChars).toBeGreaterThan(
    registryBefore.thisDirectoryChars
  );
});

test('updateChartIncrementally removes a deleted file from its partition', async () => {
  await buildChartFull();
  const deletedRelativePath = 'tests/test-src/sample.js';
  await rm(path.join(tempDir, deletedRelativePath));

  await updateChartIncrementally([deletedRelativePath]);

  const chartContent = await readFile(chartPath, 'utf8');
  expect(chartContent).not.toContain('- sample.js:');
  expect(chartContent).not.toContain('### /tests/test-src/sample.js');
});

test('buildChartFull ignores build directories at any depth', async () => {
  const ignoredDirs = [
    path.join(tempDir, 'build'),
    path.join(tempDir, 'packages', 'foo', 'build'),
    path.join(tempDir, 'src', 'build')
  ];
  for (const dir of ignoredDirs) {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'ignored.ts'),
      'export function shouldBeHidden() {}\n'
    );
  }

  await buildChartFull();

  const chartContent = await readFile(chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  expect(normalizedChart).not.toContain('build/ignored.ts');
  expect(normalizedChart).not.toContain('packages/foo/build/ignored.ts');
  expect(normalizedChart).not.toContain('src/build/ignored.ts');
  expect(normalizedChart).not.toContain('shouldBeHidden');
});

test('updateChartIncrementally skips files inside build directories', async () => {
  await buildChartFull();

  const ignored = [
    'build/ignored.ts',
    'packages/foo/build/ignored.ts',
    'src/build/ignored.ts'
  ];
  const realFile = 'tests/test-src/real.ts';
  for (const rel of ignored) {
    const abs = path.join(tempDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, 'export function shouldBeHidden() {}\n');
  }
  await writeFile(
    path.join(tempDir, realFile),
    'export function shouldShow() {}\n'
  );

  await updateChartIncrementally([...ignored, realFile]);

  const chartContent = await readFile(chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  for (const rel of ignored) {
    expect(normalizedChart).not.toContain(`### /${rel}`);
    expect(normalizedChart).not.toContain(`- /${rel}:`);
  }
  expect(normalizedChart).not.toContain('shouldBeHidden');

  const registryRaw = await readFile(registryPath, 'utf8');
  const registry = JSON.parse(registryRaw);
  expect(registry.directory).toBe('.');
});
