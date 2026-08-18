import { afterAll, afterEach, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { destroyPool } from '../../dist/chartBuild/buildChart.js';
import {
  applyFileChanges,
  buildConsistencyInitialState,
  createConsistencyProjects,
  expectConsistentArtifacts,
  UNSPLIT_THRESHOLDS,
} from './consistencyTestSupport.js';

const temporaryProjects = [];

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

afterAll(async () => {
  await destroyPool();
});

test('deleting a single file updates the merged root chart identically', async () => {
  const projects = await createConsistencyProjects(async root => {
    await writeFile(path.join(root, 'root.ts'), 'export function rootFunction() {}\n', 'utf8');
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'util.ts'), 'export function util() {}\n', 'utf8');
    await writeFile(path.join(root, 'src', 'worker.ts'), 'export function worker() {}\n', 'utf8');
  }, 'root-chart-delete', temporaryProjects);
  await buildConsistencyInitialState(projects, UNSPLIT_THRESHOLDS);

  await applyFileChanges(projects, [{ path: 'src/util.ts', delete: true }]);
  const artifacts = await expectConsistentArtifacts(projects, UNSPLIT_THRESHOLDS, ['src/util.ts']);

  expect(artifacts['chart/chart.md']).not.toContain('util');
  expect(artifacts['chart/chart.md']).toContain('worker');
  expect(artifacts['dependencyGraph.json'].files).not.toContain('src/util.ts');
});

test('deleting the last file of a directory removes its chart and index entry', async () => {
  const projects = await createConsistencyProjects(async root => {
    await mkdir(path.join(root, 'alpha'));
    await mkdir(path.join(root, 'beta'));
    await writeFile(
      path.join(root, 'alpha', 'entry.ts'),
      'export function alpha() { return 1; }\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'beta', 'entry.ts'),
      'export function beta() { return 2; }\n',
      'utf8'
    );
  }, 'prune-chart-delete', temporaryProjects);
  const thresholds = { splitAt: 1, mergeAt: 0 };
  await buildConsistencyInitialState(projects, thresholds);

  await applyFileChanges(projects, [{ path: 'alpha/entry.ts', delete: true }]);
  const artifacts = await expectConsistentArtifacts(projects, thresholds, ['alpha/entry.ts']);

  expect(artifacts['chart/alpha/chart.md']).toBeUndefined();
  expect(artifacts['chart/beta/chart.md']).toBeDefined();
  expect(artifacts['index.md']).not.toContain('.memoryanchor/chart/alpha/chart.md');
});

test('deleting a nested directory removes its whole chart subtree', async () => {
  const projects = await createConsistencyProjects(async root => {
    await writeFile(path.join(root, 'root.ts'), 'export function rootFunction() {}\n', 'utf8');
    await mkdir(path.join(root, 'src', 'app', 'components'), { recursive: true });
    await writeFile(path.join(root, 'src', 'app', 'entry.ts'), 'export function entry() {}\n', 'utf8');
    await writeFile(
      path.join(root, 'src', 'app', 'components', 'button.ts'),
      'export function button() {}\n',
      'utf8'
    );
  }, 'nested-chart-delete', temporaryProjects);
  const thresholds = { splitAt: 1, mergeAt: 0 };
  await buildConsistencyInitialState(projects, thresholds);

  await applyFileChanges(projects, [{ path: 'src/app', delete: true }]);
  const artifacts = await expectConsistentArtifacts(projects, thresholds, [
    'src/app/entry.ts',
    'src/app/components/button.ts',
  ]);

  expect(artifacts['chart/src/app/chart.md']).toBeUndefined();
  expect(artifacts['chart/src/app/components/chart.md']).toBeUndefined();
  expect(artifacts['chart/chart.md']).not.toContain('.memoryanchor/chart/src/app/chart.md');
});

test('deleting a provider file drops importer edges while the provider chart survives', async () => {
  const projects = await createConsistencyProjects(async root => {
    await mkdir(path.join(root, 'providers'));
    await mkdir(path.join(root, 'consumers'));
    await writeFile(
      path.join(root, 'providers', 'shared.ts'),
      'export function shared() { return 1; }\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'providers', 'other.ts'),
      'export function other() { return 2; }\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'consumers', 'alpha.ts'),
      'import { shared } from "../providers/shared.js";\n' +
        'export function alpha() { return shared(); }\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'consumers', 'beta.ts'),
      'import { shared } from "../providers/shared.js";\n' +
        'export function beta() { return shared(); }\n',
      'utf8'
    );
  }, 'provider-file-delete', temporaryProjects);
  const thresholds = { splitAt: 1, mergeAt: 0 };
  await buildConsistencyInitialState(projects, thresholds);

  await applyFileChanges(projects, [{ path: 'providers/shared.ts', delete: true }]);
  const artifacts = await expectConsistentArtifacts(projects, thresholds, ['providers/shared.ts']);

  const providersChart = artifacts['chart/providers/chart.md'];
  expect(providersChart).not.toContain('shared()');
  expect(providersChart).toContain('other()');
  expect(artifacts['chart/consumers/chart.md']).not.toContain('-> ../providers/shared.ts');
});

test('deleting a provider directory removes its chart and drops importer edges', async () => {
  const projects = await createConsistencyProjects(async root => {
    await mkdir(path.join(root, 'providers'));
    await mkdir(path.join(root, 'consumers'));
    await writeFile(
      path.join(root, 'providers', 'shared.ts'),
      'export function shared() { return 1; }\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'providers', 'other.ts'),
      'export function other() { return 2; }\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'consumers', 'alpha.ts'),
      'import { shared } from "../providers/shared.js";\n' +
        'export function alpha() { return shared(); }\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'consumers', 'beta.ts'),
      'import { shared } from "../providers/shared.js";\n' +
        'export function beta() { return shared(); }\n',
      'utf8'
    );
  }, 'provider-dir-delete', temporaryProjects);
  const thresholds = { splitAt: 1, mergeAt: 0 };
  await buildConsistencyInitialState(projects, thresholds);

  await applyFileChanges(projects, [{ path: 'providers', delete: true }]);
  const artifacts = await expectConsistentArtifacts(projects, thresholds, [
    'providers/shared.ts',
    'providers/other.ts',
  ]);

  expect(artifacts['chart/providers/chart.md']).toBeUndefined();
  expect(artifacts['chart/consumers/chart.md']).not.toContain('-> ../providers/');
  expect(artifacts['index.md']).not.toContain('.memoryanchor/chart/providers/chart.md');
});

test('deleting a caller file drops its reverse annotations from target charts', async () => {
  const projects = await createConsistencyProjects(async root => {
    await mkdir(path.join(root, 'providers'));
    await mkdir(path.join(root, 'consumers'));
    await writeFile(
      path.join(root, 'providers', 'shared.ts'),
      'export function shared() { return 1; }\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'consumers', 'alpha.ts'),
      'import { shared } from "../providers/shared.js";\n' +
        'export function alpha() { return shared(); }\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'consumers', 'beta.ts'),
      'import { shared } from "../providers/shared.js";\n' +
        'export function beta() { return shared(); }\n',
      'utf8'
    );
  }, 'caller-file-delete', temporaryProjects);
  const thresholds = { splitAt: 1, mergeAt: 0 };
  await buildConsistencyInitialState(projects, thresholds);

  await applyFileChanges(projects, [{ path: 'consumers/alpha.ts', delete: true }]);
  const artifacts = await expectConsistentArtifacts(projects, thresholds, ['consumers/alpha.ts']);

  const providersChart = artifacts['chart/providers/chart.md'];
  expect(providersChart).not.toContain('consumers/alpha.ts:alpha()');
  expect(providersChart).toContain('consumers/beta.ts:beta()');
  expect(artifacts['chart/consumers/chart.md']).not.toContain('alpha');
});

test('deleting files across multiple directories in one batch stays consistent', async () => {
  const projects = await createConsistencyProjects(async root => {
    await writeFile(path.join(root, 'root.ts'), 'export function rootFunction() {}\n', 'utf8');
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, 'lib'));
    await writeFile(path.join(root, 'src', 'a.ts'), 'export function srcA() {}\n', 'utf8');
    await writeFile(path.join(root, 'src', 'b.ts'), 'export function srcB() {}\n', 'utf8');
    await writeFile(path.join(root, 'lib', 'c.ts'), 'export function libC() {}\n', 'utf8');
    await writeFile(path.join(root, 'lib', 'd.ts'), 'export function libD() {}\n', 'utf8');
  }, 'multi-dir-batch-delete', temporaryProjects);
  const thresholds = { splitAt: 1, mergeAt: 0 };
  await buildConsistencyInitialState(projects, thresholds);

  await applyFileChanges(projects, [
    { path: 'src/a.ts', delete: true },
    { path: 'lib/c.ts', delete: true },
  ]);
  const artifacts = await expectConsistentArtifacts(projects, thresholds, [
    'src/a.ts',
    'lib/c.ts',
  ]);

  expect(artifacts['chart/src/chart.md']).not.toContain('srcA');
  expect(artifacts['chart/src/chart.md']).toContain('srcB');
  expect(artifacts['chart/lib/chart.md']).not.toContain('libC');
  expect(artifacts['chart/lib/chart.md']).toContain('libD');
});

test('deleting a virtual child branch under a split ancestor removes its chart', async () => {
  const benchSource = Array.from(
    { length: 36 },
    (_, index) => `export function benchFunction${index}() { return ${index}; }`
  ).join('\n');
  const projects = await createConsistencyProjects(async root => {
    const benchDir = path.join(root, 'bench');
    await mkdir(path.join(benchDir, 'demo-crosschart', 'alpha'), { recursive: true });
    await mkdir(path.join(benchDir, 'another-crosschart'), { recursive: true });
    await writeFile(path.join(benchDir, 'entry.ts'), `${benchSource}\n`, 'utf8');
    await writeFile(
      path.join(benchDir, 'demo-crosschart', 'alpha', 'entry.ts'),
      'export function alpha() { return 1; }\n',
      'utf8'
    );
    await writeFile(
      path.join(benchDir, 'another-crosschart', 'entry.ts'),
      'export function another() { return 3; }\n',
      'utf8'
    );
    await writeFile(path.join(root, 'root.ts'), 'export function rootFunction() {}\n', 'utf8');
  }, 'virtual-branch-delete', temporaryProjects);

  const initial = await buildConsistencyInitialState(projects, UNSPLIT_THRESHOLDS);
  const bench = initial.root.children.find(node => node.directory === 'bench');
  // Keep the surviving bench branch above splitAt after deletion. Full builds
  // intentionally start from source state and do not reuse the old registry.
  const thresholds = { splitAt: 1000, mergeAt: 0 };
  await buildConsistencyInitialState(projects, thresholds, initial);

  await applyFileChanges(projects, [{ path: 'bench/demo-crosschart', delete: true }]);
  const artifacts = await expectConsistentArtifacts(projects, thresholds, [
    'bench/demo-crosschart/alpha/entry.ts',
  ]);

  expect(artifacts['chart/bench/demo-crosschart/chart.md']).toBeUndefined();
  expect(artifacts['chart/bench/another-crosschart/chart.md']).toBeDefined();
  expect(artifacts['chart/bench/chart.md']).not.toContain('demo-crosschart');
  expect(artifacts['index.md']).not.toContain('.memoryanchor/chart/bench/demo-crosschart/chart.md');
});

const frontendWorkspace = async root => {
  await mkdir(path.join(root, 'Frontend'));
  for (let index = 0; index < 10; index += 1) {
    await writeFile(
      path.join(root, 'Frontend', `file${index}.ts`),
      `export function frontendFunction${index}() { return ${index}; }\n`,
      'utf8'
    );
  }
  await writeFile(path.join(root, 'root.ts'), 'export function rootFunction() {}\n', 'utf8');
};

test('deleting files inside a split frontier keeps the frontier chart', async () => {
  const projects = await createConsistencyProjects(frontendWorkspace, 'frontier-keep', temporaryProjects);
  const initial = await buildConsistencyInitialState(projects, UNSPLIT_THRESHOLDS);
  // Keep the root split after deleting two files without depending on a prior
  // registry state in the full-build side of this comparison.
  const thresholds = { splitAt: 650, mergeAt: 600 };
  await buildConsistencyInitialState(projects, thresholds, initial);

  await applyFileChanges(projects, [
    { path: 'Frontend/file0.ts', delete: true },
    { path: 'Frontend/file1.ts', delete: true },
  ]);
  const artifacts = await expectConsistentArtifacts(projects, thresholds, [
    'Frontend/file0.ts',
    'Frontend/file1.ts',
  ]);

  expect(artifacts['chart/chart.md']).toBeDefined();
  expect(artifacts['chart/chart.md']).not.toContain('frontendFunction2');
  expect(artifacts['chart/Frontend/chart.md']).toBeDefined();
  expect(artifacts['chart/Frontend/chart.md']).not.toContain('frontendFunction0');
  expect(artifacts['chart/Frontend/chart.md']).not.toContain('frontendFunction1');
  expect(artifacts['chart/Frontend/chart.md']).toContain('frontendFunction9');
});

test('deleting files merges a split frontier back into the parent chart', async () => {
  const projects = await createConsistencyProjects(frontendWorkspace, 'frontier-merge', temporaryProjects);
  const initial = await buildConsistencyInitialState(projects, UNSPLIT_THRESHOLDS);
  const thresholds = {
    splitAt: initial.root.thisDirectoryChars - 20,
    mergeAt: initial.root.thisDirectoryChars - 120,
  };
  await buildConsistencyInitialState(projects, thresholds, initial);

  const deletedFiles = [];
  for (let index = 0; index < 5; index += 1) deletedFiles.push(`Frontend/file${index}.ts`);
  await applyFileChanges(projects, deletedFiles.map(relativePath => ({
    path: relativePath,
    delete: true,
  })));
  const artifacts = await expectConsistentArtifacts(projects, thresholds, deletedFiles);

  expect(artifacts['chart/chart.md']).toBeDefined();
  expect(artifacts['chart/Frontend/chart.md']).toBeUndefined();
  expect(artifacts['chart/chart.md']).toContain('frontendFunction5');
  expect(artifacts['chart/chart.md']).not.toContain('frontendFunction0');
});

test('deleting the last root-level file removes the root chart', async () => {
  const projects = await createConsistencyProjects(async root => {
    await writeFile(path.join(root, 'root.ts'), 'export function rootFunction() {}\n', 'utf8');
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'worker.ts'), 'export function worker() {}\n', 'utf8');
  }, 'root-chart-prune', temporaryProjects);
  const thresholds = { splitAt: 1, mergeAt: 0 };
  await buildConsistencyInitialState(projects, thresholds);

  await applyFileChanges(projects, [{ path: 'root.ts', delete: true }]);
  const artifacts = await expectConsistentArtifacts(projects, thresholds, ['root.ts']);

  expect(artifacts['chart/chart.md']).toBeUndefined();
  expect(artifacts['chart/src/chart.md']).toBeDefined();
  expect(artifacts['index.md']).not.toContain('.memoryanchor/chart/chart.md');
  expect(artifacts['index.md']).toContain('.memoryanchor/chart/src/chart.md');
});

test('moving a file between directories in one batch stays consistent', async () => {
  const projects = await createConsistencyProjects(async root => {
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, 'lib'));
    await writeFile(path.join(root, 'src', 'a.ts'), 'export function srcA() {}\n', 'utf8');
    await writeFile(path.join(root, 'src', 'b.ts'), 'export function srcB() {}\n', 'utf8');
    await writeFile(path.join(root, 'lib', 'd.ts'), 'export function libD() {}\n', 'utf8');
  }, 'move-between-dirs', temporaryProjects);
  const thresholds = { splitAt: 1, mergeAt: 0 };
  await buildConsistencyInitialState(projects, thresholds);

  await applyFileChanges(projects, [
    { path: 'src/a.ts', delete: true },
    { path: 'lib/a.ts', content: 'export function movedA() {}\n' },
  ]);
  const artifacts = await expectConsistentArtifacts(projects, thresholds, ['src/a.ts', 'lib/a.ts']);

  expect(artifacts['chart/src/chart.md']).not.toContain('srcA');
  expect(artifacts['chart/lib/chart.md']).toContain('movedA');
  expect(artifacts['chart/lib/chart.md']).toContain('libD');
});

test('deleting every source file empties the chart output identically', async () => {
  const projects = await createConsistencyProjects(async root => {
    await writeFile(path.join(root, 'root.ts'), 'export function rootFunction() {}\n', 'utf8');
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'worker.ts'), 'export function worker() {}\n', 'utf8');
  }, 'empty-workspace', temporaryProjects);
  await buildConsistencyInitialState(projects, UNSPLIT_THRESHOLDS);

  await applyFileChanges(projects, [
    { path: 'root.ts', delete: true },
    { path: 'src/worker.ts', delete: true },
  ]);
  const artifacts = await expectConsistentArtifacts(projects, UNSPLIT_THRESHOLDS, [
    'root.ts',
    'src/worker.ts',
  ]);

  expect(Object.keys(artifacts).filter(key => key.startsWith('chart/'))).toEqual(['chart/chart.md']);
  expect(artifacts['chart/chart.md']).not.toContain('rootFunction');
});
