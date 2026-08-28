import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createBuildChartTestContext,
  expectedExports,
  getNodeBlock,
  fixtures,
  incrementalRelPaths,
} from './buildChartTestSupport.js';

const context = createBuildChartTestContext();

beforeAll(async () => {
  await context.setup();
});

beforeEach(async () => {
  await context.reset();
});

afterAll(async () => {
  await context.teardown();
});

test('buildChartFull includes fixture paths in the skeleton', async () => {
  await context.buildChartFull();

  const indexContent = await readFile(context.indexPath, 'utf8');
  const chartContent = await readFile(context.chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  expect(indexContent).toContain('- `.memoryanchor/chart/chart.md`');
  expect(normalizedChart).toContain('### tests/chart/test-src/');
  for (const { file } of fixtures) {
    expect(normalizedChart).toContain(`- ${file}\n`);
  }
  expect(normalizedChart).toContain('### /tests/chart/test-src/sample.c\n');
  expect(normalizedChart).not.toContain('dependencies:');
  expect(normalizedChart).not.toContain('dependencies: none');
});

test('buildChartFull logs completion and duration for every build stage', async () => {
  const originalWrite = process.stderr.write;
  const output = [];
  process.stderr.write = ((chunk) => {
    output.push(String(chunk));
    return true;
  });

  try {
    await context.buildChartFull();
  } finally {
    process.stderr.write = originalWrite;
  }

  const logs = output.join('');
  expect(logs).toMatch(/\[Stage 1\/4\] parse finished in \d+\.\d+ms/);
  expect(logs).toMatch(/\[Stage 2\/4\] reverse dependency finished in \d+\.\d+ms/);
  expect(logs).toMatch(/\[Stage 3\/4\] partition finished in \d+\.\d+ms/);
  expect(logs).toMatch(/\[Stage 4\/4\] render finished in \d+\.\d+ms/);
});

test('chart uses in-chart Tree-sitter imports and emits symbol reverse dependencies', async () => {
  const fixturesDir = path.join(context.tempDir, 'tests', 'chart', 'test-src');
  await writeFile(
    path.join(fixturesDir, 'dependency.ts'),
    'export function shared() { return 1; }\n'
  );
  await writeFile(
    path.join(fixturesDir, 'consumer.ts'),
    'import { unused } from "external-package";\nimport { shared } from "./dependency.js";\nexport function caller() { return shared(); }\n'
  );

  await context.buildChartFull();

  const chartContent = (await readFile(context.chartPath, 'utf8')).replace(/\\/g, '/');
  const skeleton = chartContent.slice(0, chartContent.indexOf('## Symbols & Callers'));
  expect(skeleton).toContain('- consumer.ts\n');
  expect(skeleton).not.toContain('consumer.ts ->');
  expect(chartContent).toContain('### /tests/chart/test-src/consumer.ts -> tests/chart/test-src/dependency.ts');
  expect(chartContent).toContain(
    '+ shared() [L1-1] <- tests/chart/test-src/consumer.ts:caller()'
  );
  expect(chartContent).not.toContain('external-package');
  expect(chartContent).not.toContain('Source code module.');
});

test('symbol-free files stay in the skeleton without empty node headings', async () => {
  const emptyPath = path.join(context.tempDir, 'tests', 'chart', 'test-src', 'empty.ts');
  try {
    await writeFile(emptyPath, '// intentionally contains no architecture symbols\n');

    await context.buildChartFull();

    const chartContent = (await readFile(context.chartPath, 'utf8')).replace(/\\/g, '/');
    expect(chartContent).toContain('- empty.ts\n');
    expect(chartContent).not.toContain('### /tests/chart/test-src/empty.ts');
  } finally {
    await rm(emptyPath, { force: true });
  }
});

test('workers attach deduplicated forward calls directly to their containing symbols', async () => {
  const sourcePath = path.join(context.tempDir, 'tests', 'chart', 'test-src', 'worker-dependencies.ts');
  try {
    await writeFile(
      sourcePath,
      'import { shared } from "./dependency.js";\n' +
        'export function caller() { shared(); shared(); }\n'
    );

    const [fileNode] = await context.batchParseFiles([{
      absolutePath: sourcePath,
      relativePath: 'tests/chart/test-src/worker-dependencies.ts'
    }]);
    const caller = fileNode.symbols.find(symbol => symbol.name === 'caller');

    expect(caller?.forwardDependencies).toEqual(['shared']);
    expect(fileNode).not.toHaveProperty('calls');
  } finally {
    await rm(sourcePath, { force: true });
  }
});

test('reverse dependency lookup isolates same-named exports by resolved file path', async () => {
  const fixturesDir = path.join(context.tempDir, 'tests', 'chart', 'test-src');
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

    await context.buildChartFull();

    const chartContent = (await readFile(context.chartPath, 'utf8')).replace(/\\/g, '/');
    const firstDependency = getNodeBlock(chartContent, 'tests/chart/test-src/dependency-a.ts');
    const secondDependency = getNodeBlock(chartContent, 'tests/chart/test-src/dependency-b.ts');
    expect(firstDependency).not.toContain('<- tests/chart/test-src/consumer.ts:caller()');
    expect(secondDependency).toContain(
      '+ shared() [L1-1] <- tests/chart/test-src/consumer.ts:caller()'
    );
    expect(secondDependency.match(/caller\(\)/g)).toHaveLength(1);
  } finally {
    await Promise.all(createdFiles.map(file =>
      rm(path.join(fixturesDir, file), { force: true })
    ));
  }
});

test('reverse dependencies qualify same-named callers from different files', async () => {
  const fixturesDir = path.join(context.tempDir, 'tests', 'chart', 'test-src');
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

    await context.buildChartFull();

    const chartContent = (await readFile(context.chartPath, 'utf8')).replace(/\\/g, '/');
    const dependency = getNodeBlock(
      chartContent,
      'tests/chart/test-src/dependency-caller-collision.ts'
    );
    expect(dependency).toContain(
      '+ sharedCollision() [L1-1] <- ' +
      'tests/chart/test-src/caller-one.ts:run(); ' +
      'tests/chart/test-src/caller-two.ts:run()'
    );
  } finally {
    await Promise.all(createdFiles.map(file =>
      rm(path.join(fixturesDir, file), { force: true })
    ));
  }
});

test('reverse dependencies group multiple callers from one source file', async () => {
  const fixturesDir = path.join(context.tempDir, 'tests', 'chart', 'test-src');
  const createdFiles = ['dependency-grouped-callers.ts', 'grouped-callers.ts'];
  try {
    await writeFile(
      path.join(fixturesDir, 'dependency-grouped-callers.ts'),
      'export function sharedGrouped() { return 1; }\n'
    );
    await writeFile(
      path.join(fixturesDir, 'grouped-callers.ts'),
      'import { sharedGrouped } from "./dependency-grouped-callers.js";\n' +
        'export function firstCaller() { return sharedGrouped(); }\n' +
        'export function secondCaller() { return sharedGrouped(); }\n'
    );

    await context.buildChartFull();

    const chartContent = (await readFile(context.chartPath, 'utf8')).replace(/\\/g, '/');
    const dependency = getNodeBlock(
      chartContent,
      'tests/chart/test-src/dependency-grouped-callers.ts'
    );
    expect(dependency).toContain(
      'tests/chart/test-src/grouped-callers.ts:firstCaller(), secondCaller()'
    );
    expect(dependency.match(/tests\/chart\/test-src\/grouped-callers\.ts:/g)).toHaveLength(1);
  } finally {
    await Promise.all(createdFiles.map(file =>
      rm(path.join(fixturesDir, file), { force: true })
    ));
  }
});

test('reverse dependencies distinguish duplicate caller names within one file', async () => {
  const fixturesDir = path.join(context.tempDir, 'tests', 'chart', 'test-src');
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

    await context.buildChartFull();

    const chartContent = (await readFile(context.chartPath, 'utf8')).replace(/\\/g, '/');
    const dependency = getNodeBlock(
      chartContent,
      'tests/chart/test-src/dependency-same-file.ts'
    );
    expect(dependency.match(/tests\/chart\/test-src\/same-file-callers\.ts:/g)).toHaveLength(1);
    const qualifiedCallers = dependency.match(/run\(\)\[L\d+-\d+@\d+\]/g);
    expect(qualifiedCallers).toHaveLength(2);
    expect(new Set(qualifiedCallers).size).toBe(2);
  } finally {
    await Promise.all(createdFiles.map(file =>
      rm(path.join(fixturesDir, file), { force: true })
    ));
  }
});

test('forward dependencies resolve parseable files outside the rendered chart', async () => {
  await mkdir(path.join(context.tempDir, 'src'), { recursive: true });
  await writeFile(path.join(context.tempDir, 'shared.ts'), 'export function shared() { return 1; }\n');
  await writeFile(
    path.join(context.tempDir, 'src', 'consumer.ts'),
    'import { shared } from "../shared.js";\nexport function caller() { return shared(); }\n'
  );

  const chart = await context.buildChartContent(
    new Map([['src', ['src/consumer.ts']]]),
    context.tempDir,
  );

  expect(chart).toContain('### /src/consumer.ts -> shared.ts');
  expect(chart).not.toContain('### /shared.ts');
  expect(chart).not.toContain('<- caller()');

  await rm(path.join(context.tempDir, 'shared.ts'));
  await rm(path.join(context.tempDir, 'src'), { recursive: true, force: true });
});

test('buildChartContent accepts precomputed repository dependency paths', async () => {
  await mkdir(path.join(context.tempDir, 'src'), { recursive: true });
  await writeFile(path.join(context.tempDir, 'shared.ts'), 'export function shared() { return 1; }\n');
  await writeFile(
    path.join(context.tempDir, 'src', 'consumer.ts'),
    'import { shared } from "../shared.js";\nexport function caller() { return shared(); }\n'
  );

  const chart = await context.buildChartContent(
    new Map([['src', ['src/consumer.ts']]]),
    context.tempDir,
    new Map(),
    'PROJECT CHART',
    [],
    new Set(['shared.ts', 'src/consumer.ts'])
  );

  expect(chart).toContain('### /src/consumer.ts -> shared.ts');

  await rm(path.join(context.tempDir, 'shared.ts'));
  await rm(path.join(context.tempDir, 'src'), { recursive: true, force: true });
});

test('incremental updates rebuild reverse dependencies for the complete chart whitelist', async () => {
  const fixturesDir = path.join(context.tempDir, 'tests', 'chart', 'test-src');
  await writeFile(
    path.join(fixturesDir, 'dependency.ts'),
    'export function shared() { return 1; }\n'
  );
  await writeFile(
    path.join(fixturesDir, 'consumer.ts'),
    'import { shared } from "./dependency.js";\nexport function caller() { return shared(); }\n'
  );
  await context.buildChartFull();

  await writeFile(
    path.join(fixturesDir, 'consumer.ts'),
    'import { shared } from "./dependency.js";\nexport function caller() { return 2; }\n'
  );
  await context.updateChartIncrementally(['tests/chart/test-src/consumer.ts']);

  const chartContent = (await readFile(context.chartPath, 'utf8')).replace(/\\/g, '/');
  expect(chartContent).toContain('### /tests/chart/test-src/consumer.ts -> tests/chart/test-src/dependency.ts');
  expect(chartContent).not.toContain('+ shared() [L1-1] <- caller()');
});

test('exports include source signatures while internal symbols retain only location', async () => {
  const fixturesDir = path.join(context.tempDir, 'tests', 'chart', 'test-src');
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

  await context.buildChartFull();

  const chartContent = await readFile(context.chartPath, 'utf8');
  expect(chartContent).toContain(
    '+ publish(value: string, count: number): Promise<boolean> [L2-4]'
  );
  expect(chartContent).toContain('- helper() [L7-7]');
  expect(chartContent).not.toContain('helper(value: boolean)');
  expect(chartContent).not.toContain('Public entry point.');
  expect(chartContent).not.toContain('Internal helper.');
});
