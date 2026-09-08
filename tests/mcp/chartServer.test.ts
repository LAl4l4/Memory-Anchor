import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ChartReader, extractFileArchitecture } from '../../dist/mcp/chartReader.js';
import { createDirectoryTree, rebuildChartTree, toDirectoryTreeRegistry } from '../../dist/chartBuild/partition/directoryTree.js';

let workspace: string;
let reader: ChartReader;
const chart = '# Architecture: src\n\n## Architecture\n- /index.ts -> lib/a file.ts\n  + start() [L1-3]\n\n### lib/\n- a file.ts\n  + run(\n      value: string\n    ): void [L1-3] <- src/index.ts:start()\n- other.ts\n  - privateThing() [L1-2]\n';

async function put(file: string, content: string) {
  const target = path.join(workspace, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'anchor-mcp-'));
  await put('src/lib/a file.ts', 'export function run(\n  value: string\n) {}\n');
  await put('src/lib/other.ts', 'function privateThing() {}\n');
  await put('src/index.ts', 'export function start() {}\n');
  await put('README.md', '# Demo\n');
  const tree = createDirectoryTree(['.', 'src', 'src/lib', 'wrapper/pkg']);
  tree.isSplit = true;
  tree.children.find(child => child.directory === 'wrapper')!.isSplit = true;
  rebuildChartTree(tree);
  await put('wrapper/pkg/index.ts', 'export const x = 1;\n');
  await put('.memoryanchor/dirTree.json', JSON.stringify(toDirectoryTreeRegistry(tree)));
  await put('.memoryanchor/chart/chart.md', '# Architecture: root\n\n## Architecture\n- /README.md\n');
  await put('.memoryanchor/chart/src/chart.md', chart);
  await put('.memoryanchor/chart/wrapper/pkg/chart.md', '# Architecture: wrapper/pkg\n\n## Architecture\n- /index.ts\n');
  reader = await ChartReader.create(workspace);
});

afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

test('routes root, recursive descendants, absolute paths and file-less split wrappers', async () => {
  expect((await reader.getChart('.')).chart?.directory).toBe('.');
  const result = await reader.getChart(path.join(workspace, 'src/lib'));
  expect(result.chart?.directory).toBe('src');
  expect(result.chart?.scope).toBe('src/**');
  expect(result.chart?.content).toBe(chart);
  expect(await reader.getChart('wrapper')).toMatchObject({ chart: null,
    childCharts: [{ directory: 'wrapper/pkg', path: '.memoryanchor/chart/wrapper/pkg/chart.md' }] });
});

test('extracts just the requested file, preserving multiline signatures and spaced filenames', async () => {
  const result = await reader.getFile('src/lib/a file.ts');
  expect(result.indexed).toBe(true);
  expect(result.architecture).toContain('value: string');
  expect(result.architecture).toContain('<- src/index.ts:start()');
  expect(result.architecture).not.toContain('privateThing');
  expect(result.source).toBeUndefined();
  expect(extractFileArchitecture(chart, 'lib/a')).toBeNull();
  expect((await reader.getFile('src/index.ts')).architecture).toContain('-> lib/a file.ts');
});

test('reads bounded source ranges, reports absent entries, and rejects invalid ranges', async () => {
  expect((await reader.getFile('src/lib/a file.ts', { include_source: true, start_line: 2, end_line: 2 })).source)
    .toMatchObject({ content: '  value: string', startLine: 2, endLine: 2, totalLines: 3, hasMore: true });
  await put('src/new.ts', 'new source\n');
  expect(await reader.getFile('src/new.ts', { include_source: true })).toMatchObject({ indexed: false,
    architecture: null, source: { content: 'new source' } });
  await expect(reader.getFile('src/index.ts', { start_line: 1 })).rejects.toThrow('include_source');
  await expect(reader.getFile('src/index.ts', { include_source: true, end_line: 501 })).rejects.toThrow('500');
  await expect(reader.getFile('src/index.ts', { include_source: true, start_line: 10 })).rejects.toThrow('range');
});

test('reloads chart artifacts and flags only evidence of possible staleness', async () => {
  const chartPath = path.join(workspace, '.memoryanchor/chart/src/chart.md');
  await utimes(chartPath, new Date(0), new Date(0));
  expect((await reader.getFile('src/index.ts')).freshness).toBe('possibly_stale');
  await put('.memoryanchor/chart/src/chart.md', chart.replace('start()', 'changed()'));
  expect((await reader.getFile('src/index.ts')).architecture).toContain('changed()');
  expect((await reader.getChart('src')).freshness).toBe('unknown');
  await put('.memoryanchor/dirTree.json', 'broken json');
  await expect(reader.getChart('src')).rejects.toThrow('registry unavailable');
});

test('rejects traversal and symlink escapes for both input and chart artifacts', async () => {
  await expect(reader.getChart('..')).rejects.toThrow('inside');
  await symlink(os.tmpdir(), path.join(workspace, 'outside'));
  await expect(reader.getChart('outside')).rejects.toThrow('inside');
  await rm(path.join(workspace, '.memoryanchor/chart/src/chart.md'));
  await symlink(process.execPath, path.join(workspace, '.memoryanchor/chart/src/chart.md'));
  await expect(reader.getChart('src')).rejects.toThrow('inside');
});

test('rejects wrong path kinds, missing files, oversized and binary source', async () => {
  await expect(reader.getFile('src')).rejects.toThrow('regular file');
  await expect(reader.getChart('README.md')).rejects.toThrow('directory');
  await expect(reader.getFile('missing.ts')).rejects.toThrow();
  await put('src/binary.ts', '\0binary');
  await expect(reader.getFile('src/binary.ts', { include_source: true })).rejects.toThrow('Binary');
  await put('src/large.ts', 'x'.repeat(2 * 1024 * 1024 + 1));
  await expect(reader.getFile('src/large.ts', { include_source: true })).rejects.toThrow('2 MiB');
});

test('real CLI stdio supports initialize, list, calls, error recovery and clean shutdown', async () => {
  const before = await readFile(path.join(workspace, '.memoryanchor/dirTree.json'), 'utf8');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve('dist/cli.js'), 'mcp', '--workspace', workspace], stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['get_chart', 'get_file']);
    const result = await client.callTool({ name: 'get_file', arguments: { path: 'src/index.ts', include_source: true } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('start()');
    expect((await client.callTool({ name: 'get_chart', arguments: { path: '..' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'get_file', arguments: { path: 'src/index.ts', start_line: -1 } })).isError).toBe(true);
    expect((await client.callTool({ name: 'get_chart', arguments: {} })).isError).not.toBe(true);
  } finally { await client.close(); }
  expect(stderr).toBe('');
  expect(await readFile(path.join(workspace, '.memoryanchor/dirTree.json'), 'utf8')).toBe(before);
}, 15000);
