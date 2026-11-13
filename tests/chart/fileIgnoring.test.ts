import { afterAll, afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildChartFull, destroyPool } from '../../dist/chartBuild/buildChart.js';
import { updatePartitionedChartIncrementally } from '../../dist/chartBuild/incremental.js';
import { updatePartitionedChartsIncrementally } from '../../dist/chartBuild/partition/incrementalPartitioner.js';
import { listProjectFiles, isIgnored } from '../../dist/chartBuild/shared/utils.js';
import { IgnorePolicy } from '../../dist/utils/ignorePolicy.js';
import { acknowledgeGitChanges, captureGitChanges } from '../../dist/utils/captureGitChanges.js';

const originalCwd = process.cwd();
let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-ignore-'));
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => { await destroyPool(); });

async function write(file: string, content = 'export function value() { return 1; }\n') {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, 'utf8');
}

function files(directory = root, recursive = true): string[] {
  return [...listProjectFiles(directory, recursive, root).values()].flat().sort();
}

async function graph(): Promise<string> {
  return readFile(path.join(root, '.memoryanchor', 'dependencyGraph.json'), 'utf8');
}

function commit() {
  execFileSync('git', ['add', '--all'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '-qm', 'fixture', '--allow-empty'], { cwd: root });
}

test('scans without Git using root/nested Git rules and additional Anchor rules', async () => {
  await write('.gitignore', '# comment\ncache/\n*.tmp\n/root-only.ts\n*.skip.ts\n');
  await write('src/.gitignore', '!keep.skip.ts\n/local.ts\n');
  await write('.memoryanchorignore', 'fixtures/*\n!fixtures/keep.ts\n**/*.generated.ts\n\\#literal.ts\n');
  const paths = ['cache/hidden.ts', 'cachefile.ts', 'a.tmp', 'root-only.ts',
    'src/root-only.ts', 'src/drop.skip.ts', 'src/keep.skip.ts', 'src/local.ts',
    'src/nested/local.ts', 'fixtures/drop.ts', 'fixtures/keep.ts',
    'src/model.generated.ts', '#literal.ts'];
  for (const file of paths) await write(file);

  const expected = ['cachefile.ts', 'fixtures/keep.ts', 'src/keep.skip.ts',
    'src/nested/local.ts', 'src/root-only.ts'].sort();
  expect(files()).toEqual(expected);
  expect(files(path.join(root, 'src'), false)).toEqual(['keep.skip.ts', 'root-only.ts']);
  expect(isIgnored('src/drop.skip.ts', root)).toBe(true);
  expect(isIgnored('src/keep.skip.ts', root)).toBe(false);
});

test('negations cannot cross ignored parents, Git exclusions, or built-in exclusions', async () => {
  await write('.gitignore', 'blocked/\nprivate.ts\n');
  await write('blocked/.gitignore', '!keep.ts\n');
  await write('.memoryanchorignore', '!blocked/keep.ts\n!private.ts\n!dist/\n');
  for (const file of ['blocked/keep.ts', 'private.ts', 'dist/output.ts', 'src/main.ts']) await write(file);
  expect(files()).toEqual(['src/main.ts']);
  const policy = new IgnorePolicy(root);
  expect(policy.isIgnored(path.join(root, 'blocked', 'keep.ts'))).toBe(true);
});

test('full builds and incremental subtree renders omit ignored files and dependency targets', async () => {
  await write('.gitignore', 'src/hidden.ts\n');
  await write('.memoryanchorignore', 'src/extra.ts\n');
  await write('src/main.ts', "import { hidden } from './hidden';\nexport function main() { return hidden(); }\n");
  await write('src/hidden.ts', 'export function hidden() { return 1; }\n');
  await write('src/extra.ts', 'export function extra() { return 1; }\n');
  await buildChartFull();
  const indexed = JSON.parse(await graph());
  expect(indexed.files).toEqual(['src/main.ts']);
  expect(Object.keys(indexed.reverseDependencies)).toHaveLength(0);
  const chartPath = path.join(root, '.memoryanchor', 'chart', 'chart.md');
  const before = await readFile(chartPath, 'utf8');
  expect(before).not.toContain('/hidden.ts');
  expect(before).not.toContain('/extra.ts');

  await write('src/main.ts', 'export function updated() { return 2; }\n');
  await write('src/hidden.ts', 'export function stillHidden() { return 2; }\n');
  await expect(updatePartitionedChartsIncrementally(['src/main.ts', 'src/hidden.ts'], {
    projectRoot: root,
  })).resolves.toBe(true);
  const incrementalChart = await readFile(chartPath, 'utf8');
  expect(incrementalChart).toContain('updated');
  expect(incrementalChart).not.toContain('stillHidden');
  const incrementalGraph = await graph();
  await buildChartFull();
  expect(await readFile(chartPath, 'utf8')).toBe(incrementalChart);
  expect(await graph()).toBe(incrementalGraph);
});

test('adding, editing and removing ignore rules rebuilds existing charts and graph', async () => {
  await write('src/main.ts');
  await buildChartFull();
  expect(await graph()).toContain('src/main.ts');
  // Empty input is deliberate: rule changes need not be visible in Git.
  await write('.memoryanchorignore', 'src/\n');
  await updatePartitionedChartIncrementally([]);
  expect(await graph()).not.toContain('src/main.ts');
  await write('.memoryanchorignore', 'other/\n');
  await updatePartitionedChartIncrementally([]);
  expect(await graph()).toContain('src/main.ts');
  await write('.gitignore', 'src/\n');
  await updatePartitionedChartIncrementally([]);
  expect(await graph()).not.toContain('src/main.ts');
  await rm(path.join(root, '.gitignore'));
  await rm(path.join(root, '.memoryanchorignore'));
  await updatePartitionedChartIncrementally([]);
  expect(await graph()).toContain('src/main.ts');
});

test('hooks detect a Git-ignored Anchor rule file and settle after successful refresh', async () => {
  execFileSync('git', ['init', '-q'], { cwd: root });
  await write('.gitignore', '.memoryanchor/\n.memoryanchorignore\n');
  await write('.memoryanchorignore', 'other/\n');
  await write('src/main.ts');
  await buildChartFull();
  commit();
  expect(captureGitChanges()).toBeNull();

  await write('.memoryanchorignore', 'src/\n');
  const changes = captureGitChanges()!;
  expect(changes).toEqual([{ status: 'M', file: '.memoryanchorignore' }]);
  expect(captureGitChanges()).toEqual(changes);
  await updatePartitionedChartIncrementally(changes.map(change => change.file));
  acknowledgeGitChanges(changes);
  expect(await graph()).not.toContain('src/main.ts');
  expect(captureGitChanges()).toBeNull();
});

test('new self-ignoring nested rules are detected in an incrementally added directory', async () => {
  execFileSync('git', ['init', '-q'], { cwd: root });
  await write('.gitignore', '.memoryanchor/\n');
  await write('main.ts');
  await buildChartFull();
  await write('feature/new.ts');
  await updatePartitionedChartIncrementally(['feature/new.ts']);
  commit();
  await write('feature/.gitignore', '*\n');
  const changes = captureGitChanges()!;
  expect(changes).toEqual([{ status: 'M', file: 'feature/.gitignore' }]);
  await updatePartitionedChartIncrementally(changes.map(change => change.file));
  acknowledgeGitChanges(changes);
  expect(await graph()).not.toContain('feature/new.ts');
  await rm(path.join(root, 'feature', '.gitignore'));
  await updatePartitionedChartIncrementally([]);
  expect(await graph()).toContain('feature/new.ts');
});
