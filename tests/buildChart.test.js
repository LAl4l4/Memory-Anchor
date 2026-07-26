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
let batchParseFiles;
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
  [path.posix.join('tests', 'test-src', 'sample.c'), ['- add()']],
  [path.posix.join('tests', 'test-src', 'sample.py'), ['- greet()']],
  [path.posix.join('tests', 'test-src', 'sample.js'), ['+ add()']],
  [path.posix.join('tests', 'test-src', 'sample.ts'), ['+ add(a: number, b: number): number [L1-3]']]
]);
const incrementalRelPaths = Array.from(expectedExports.keys());

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNodeBlock(chartContent, relPath) {
  const matcher = new RegExp(
    `### \\/${escapeRegExp(relPath)}(?: -> [^\\n]+)?\\n([\\s\\S]*?)(?=\\n### \\/|$)`
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
  ({ batchParseFiles } = await import('../dist/chartBuild/chartBuildHelper/ASTParser.js'));
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

  expect(indexContent).toContain('### .memoryanchor/chart/chart.md');
  expect(normalizedChart).toContain('### tests/test-src/');
  for (const { file } of fixtures) {
    expect(normalizedChart).toContain(`- ${file}\n`);
  }
  expect(normalizedChart).toContain('### /tests/test-src/sample.c\n');
  expect(normalizedChart).not.toContain('dependencies:');
  expect(normalizedChart).not.toContain('none');
});

test('chart uses in-chart Tree-sitter imports and emits symbol reverse dependencies', async () => {
  const fixturesDir = path.join(tempDir, 'tests', 'test-src');
  await writeFile(
    path.join(fixturesDir, 'dependency.ts'),
    'export function shared() { return 1; }\n'
  );
  await writeFile(
    path.join(fixturesDir, 'consumer.ts'),
    'import { unused } from "external-package";\nimport { shared } from "./dependency.js";\nexport function caller() { return shared(); }\n'
  );

  await buildChartFull();

  const chartContent = (await readFile(chartPath, 'utf8')).replace(/\\/g, '/');
  expect(chartContent).toContain('### /tests/test-src/consumer.ts -> tests/test-src/dependency.ts');
  expect(chartContent).toContain(
    '+ shared() [L1-1] <- tests/test-src/consumer.ts:caller()'
  );
  expect(chartContent).not.toContain('external-package');
  expect(chartContent).not.toContain('Source code module.');
});

test('workers attach deduplicated forward calls directly to their containing symbols', async () => {
  const sourcePath = path.join(tempDir, 'tests', 'test-src', 'worker-dependencies.ts');
  try {
    await writeFile(
      sourcePath,
      'import { shared } from "./dependency.js";\n' +
        'export function caller() { shared(); shared(); }\n'
    );

    const [fileNode] = await batchParseFiles([{
      absolutePath: sourcePath,
      relativePath: 'tests/test-src/worker-dependencies.ts'
    }]);
    const caller = fileNode.symbols.find(symbol => symbol.name === 'caller');

    expect(caller?.forwardDependencies).toEqual(['shared']);
    expect(fileNode).not.toHaveProperty('calls');
  } finally {
    await rm(sourcePath, { force: true });
  }
});

test('reverse dependency lookup isolates same-named exports by resolved file path', async () => {
  const fixturesDir = path.join(tempDir, 'tests', 'test-src');
  const createdFiles = ['dependency-a.ts', 'dependency-b.ts', 'consumer.ts'];
  try {
    await writeFile(
      path.join(fixturesDir, 'dependency-a.ts'),
      'export function shared() { return "a"; }\n'
    );
    await writeFile(
      path.join(fixturesDir, 'dependency-b.ts'),
      'export function shared() { return "b"; }\n'
    );
    await writeFile(
      path.join(fixturesDir, 'consumer.ts'),
      'import { shared as selected } from "./dependency-b.js";\n' +
        'export function caller() { selected(); selected(); }\n'
    );

    await buildChartFull();

    const chartContent = (await readFile(chartPath, 'utf8')).replace(/\\/g, '/');
    const firstDependency = getNodeBlock(chartContent, 'tests/test-src/dependency-a.ts');
    const secondDependency = getNodeBlock(chartContent, 'tests/test-src/dependency-b.ts');
    expect(firstDependency).not.toContain('<- tests/test-src/consumer.ts:caller()');
    expect(secondDependency).toContain(
      '+ shared() [L1-1] <- tests/test-src/consumer.ts:caller()'
    );
    expect(secondDependency.match(/caller\(\)/g)).toHaveLength(1);
  } finally {
    await Promise.all(createdFiles.map(file =>
      rm(path.join(fixturesDir, file), { force: true })
    ));
  }
});

test('reverse dependencies qualify same-named callers from different files', async () => {
  const fixturesDir = path.join(tempDir, 'tests', 'test-src');
  const createdFiles = [
    'caller-one.ts',
    'caller-two.ts',
    'dependency-caller-collision.ts'
  ];
  try {
    await writeFile(
      path.join(fixturesDir, 'dependency-caller-collision.ts'),
      'export function sharedCollision() { return 1; }\n'
    );
    for (const callerFile of ['caller-one.ts', 'caller-two.ts']) {
      await writeFile(
        path.join(fixturesDir, callerFile),
        'import { sharedCollision } from "./dependency-caller-collision.js";\n' +
          'export function run() { return sharedCollision(); }\n'
      );
    }

    await buildChartFull();

    const chartContent = (await readFile(chartPath, 'utf8')).replace(/\\/g, '/');
    const dependency = getNodeBlock(
      chartContent,
      'tests/test-src/dependency-caller-collision.ts'
    );
    expect(dependency).toContain(
      '+ sharedCollision() [L1-1] <- ' +
      'tests/test-src/caller-one.ts:run(); ' +
      'tests/test-src/caller-two.ts:run()'
    );
  } finally {
    await Promise.all(createdFiles.map(file =>
      rm(path.join(fixturesDir, file), { force: true })
    ));
  }
});

test('reverse dependencies distinguish duplicate caller names within one file', async () => {
  const fixturesDir = path.join(tempDir, 'tests', 'test-src');
  const createdFiles = ['same-file-callers.ts', 'dependency-same-file.ts'];
  try {
    await writeFile(
      path.join(fixturesDir, 'dependency-same-file.ts'),
      'export function sharedSameFile() { return 1; }\n'
    );
    await writeFile(
      path.join(fixturesDir, 'same-file-callers.ts'),
      'import { sharedSameFile } from "./dependency-same-file.js";\n' +
        'class Alpha {\n' +
        '  run() { return sharedSameFile(); }\n' +
        '}\n' +
        'class Beta {\n' +
        '  run() { return sharedSameFile(); }\n' +
        '}\n'
    );

    await buildChartFull();

    const chartContent = (await readFile(chartPath, 'utf8')).replace(/\\/g, '/');
    const dependency = getNodeBlock(
      chartContent,
      'tests/test-src/dependency-same-file.ts'
    );
    const qualifiedCallers = dependency.match(
      /tests\/test-src\/same-file-callers\.ts:run\(\)\[L\d+-\d+@\d+\]/g
    );
    expect(qualifiedCallers).toHaveLength(2);
    expect(new Set(qualifiedCallers).size).toBe(2);
  } finally {
    await Promise.all(createdFiles.map(file =>
      rm(path.join(fixturesDir, file), { force: true })
    ));
  }
});

test('forward dependencies resolve parseable files outside the rendered chart', async () => {
  await mkdir(path.join(tempDir, 'src'), { recursive: true });
  await writeFile(path.join(tempDir, 'shared.ts'), 'export function shared() { return 1; }\n');
  await writeFile(
    path.join(tempDir, 'src', 'consumer.ts'),
    'import { shared } from "../shared.js";\nexport function caller() { return shared(); }\n'
  );

  const chart = await buildChartContent(
    new Map([['src', ['src/consumer.ts']]]),
    tempDir,
  );

  expect(chart).toContain('### /src/consumer.ts -> shared.ts');
  expect(chart).not.toContain('### /shared.ts');
  expect(chart).not.toContain('<- caller()');

  await rm(path.join(tempDir, 'shared.ts'));
  await rm(path.join(tempDir, 'src'), { recursive: true, force: true });
});

test('buildChartContent accepts precomputed repository dependency paths', async () => {
  await mkdir(path.join(tempDir, 'src'), { recursive: true });
  await writeFile(path.join(tempDir, 'shared.ts'), 'export function shared() { return 1; }\n');
  await writeFile(
    path.join(tempDir, 'src', 'consumer.ts'),
    'import { shared } from "../shared.js";\nexport function caller() { return shared(); }\n'
  );

  const chart = await buildChartContent(
    new Map([['src', ['src/consumer.ts']]]),
    tempDir,
    new Map(),
    'PROJECT CHART',
    [],
    new Set(['shared.ts', 'src/consumer.ts'])
  );

  expect(chart).toContain('### /src/consumer.ts -> shared.ts');

  await rm(path.join(tempDir, 'shared.ts'));
  await rm(path.join(tempDir, 'src'), { recursive: true, force: true });
});

test('incremental updates rebuild reverse dependencies for the complete chart whitelist', async () => {
  const fixturesDir = path.join(tempDir, 'tests', 'test-src');
  await writeFile(
    path.join(fixturesDir, 'dependency.ts'),
    'export function shared() { return 1; }\n'
  );
  await writeFile(
    path.join(fixturesDir, 'consumer.ts'),
    'import { shared } from "./dependency.js";\nexport function caller() { return shared(); }\n'
  );
  await buildChartFull();

  await writeFile(
    path.join(fixturesDir, 'consumer.ts'),
    'import { shared } from "./dependency.js";\nexport function caller() { return 2; }\n'
  );
  await updateChartIncrementally(['tests/test-src/consumer.ts']);

  const chartContent = (await readFile(chartPath, 'utf8')).replace(/\\/g, '/');
  expect(chartContent).toContain('### /tests/test-src/consumer.ts -> tests/test-src/dependency.ts');
  expect(chartContent).not.toContain('+ shared() [L1-1] <- caller()');
});

test('exports include source signatures while internal symbols retain only location', async () => {
  const fixturesDir = path.join(tempDir, 'tests', 'test-src');
  await writeFile(
    path.join(fixturesDir, 'signature.ts'),
    '/** Public entry point. Extra implementation detail. */\n' +
      'export function publish(value: string, count: number): Promise<boolean> {\n' +
      '  return Promise.resolve(value.length === count);\n' +
      '}\n' +
      '\n' +
      '/** Internal helper. */\n' +
      'function helper(value: boolean): string { return String(value); }\n'
  );

  await buildChartFull();

  const chartContent = await readFile(chartPath, 'utf8');
  expect(chartContent).toContain(
    '+ publish(value: string, count: number): Promise<boolean> [L2-4]'
  );
  expect(chartContent).toContain('- helper() [L7-7]');
  expect(chartContent).not.toContain('helper(value: boolean)');
  expect(chartContent).not.toContain('Public entry point.');
  expect(chartContent).not.toContain('Internal helper.');
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
  expect(chartContent).toContain('+ newlyAdded(): string');
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
