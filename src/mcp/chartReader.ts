import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  findDirectoryTreeNode, findPartitionForFile, fromDirectoryTreeRegistry, isChartOwner,
  type DirectoryTreeNode,
} from '../chartBuild/partition/directoryTree.js';

import { projectStateModules } from './memoryCatalog.js';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const relative = (root: string, target: string): string => path.relative(root, target).split(path.sep).join('/') || '.';

/** Paths are checked both lexically and after resolving symlinks, including artifacts. */
async function safePath(root: string, input: string): Promise<string> {
  const target = path.resolve(root, input);
  const inside = (value: string): boolean => {
    const rel = path.relative(root, value);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  if (!path.isAbsolute(input) && !inside(target)) {
    throw new Error('Path must stay inside the configured workspace.');
  }
  const resolved = await fs.realpath(target);
  if (!inside(resolved)) throw new Error('Path must stay inside the configured workspace.');
  return resolved;
}

async function readText(root: string, input: string) {
  const target = await safePath(root, input);
  if (!(await fs.stat(target)).isFile()) throw new Error('Expected a regular file.');
  const handle = await fs.open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Expected a regular file.');
    if (stat.size > MAX_TEXT_BYTES) throw new Error('File exceeds the 2 MiB read limit.');
    const content = await handle.readFile('utf8');
    if (content.includes('\0')) throw new Error('Binary files are not supported.');
    return { content, modifiedAt: stat.mtime.toISOString(), modifiedMs: stat.mtimeMs };
  } finally {
    await handle.close();
  }
}

/** Keep the exact generated block, including multiline signatures and caller annotations. */
export function extractFileArchitecture(content: string, file: string): string | null {
  let directory = '.';
  let inArchitecture = false;
  let block: string[] | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      if (block) break;
      inArchitecture = line === '## Architecture';
      continue;
    }
    if (!inArchitecture) continue;
    const heading = line.match(/^### (.+)\/$/);
    if (heading) {
      if (block) break;
      directory = heading[1];
    } else if (line.startsWith('- ')) {
      if (block) break;
      const label = directory === '.' ? `/${file}` : path.posix.basename(file);
      if (path.posix.dirname(file) === directory &&
          (line === `- ${label}` || line.startsWith(`- ${label} -> `))) block = [line];
    } else if (block) block.push(line);
  }
  return block?.join('\n').trimEnd() ?? null;
}

export class ChartReader {
  private constructor(readonly root: string) {}

  static async create(workspace: string): Promise<ChartReader> {
    const root = await fs.realpath(path.resolve(workspace));
    let anchor: string;
    try { anchor = await safePath(root, '.memoryanchor'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('No Memory Anchor workspace at the server startup directory. Initialize it with anchor init, or configure --workspace.');
      }
      throw error;
    }
    if (!(await fs.stat(anchor)).isDirectory()) throw new Error('Initialize this workspace with anchor init first.');
    return new ChartReader(root);
  }

  private async topology() {
    try {
      const registry = await readText(this.root, '.memoryanchor/dirTree.json');
      return { root: fromDirectoryTreeRegistry(JSON.parse(registry.content)), registryModifiedAt: registry.modifiedAt };
    } catch (error) {
      throw new Error(`Chart registry unavailable; initialize or refresh Memory Anchor. ${error instanceof Error ? error.message : error}`);
    }
  }

  private async chart(node: DirectoryTreeNode) {
    const chartPath = path.posix.join('.memoryanchor/chart', node.directory, 'chart.md');
    const text = await readText(this.root, chartPath);
    return {
      path: chartPath, directory: node.directory,
      scope: node.directory === '.' ? (node.isSplit ? '/' : '/**') : `${node.directory}/${node.isSplit ? '' : '**'}`,
      mode: node.isSplit ? 'shallow' : 'recursive',
      chartModifiedAt: text.modifiedAt, content: text.content,
      childCharts: node.chartChildren.map(child => ({ directory: child.directory,
        path: path.posix.join('.memoryanchor/chart', child.directory, 'chart.md') })),
    };
  }

  async getProjectState(module?: string) {
    const text = await readText(this.root, '.memoryanchor/project-state.md');
    const modules = projectStateModules(text.content);
    const base = { path: '.memoryanchor/project-state.md', modifiedAt: text.modifiedAt };
    if (module === undefined) return { ...base, modules: modules.map(item => item.name) };
    const matches = modules.filter(item => item.name === module);
    if (!matches.length) throw new Error('Unknown module; call get_project_state({}) for available names.');
    if (matches.length > 1) throw new Error('Duplicate module headings; use unique names in project-state.md.');
    return { ...base, module, content: matches[0].content };
  }

  async getChart(input: string) {
    const target = await safePath(this.root, input);
    if (!(await fs.stat(target)).isDirectory()) throw new Error('get_chart requires a directory path.');
    const requestedPath = relative(this.root, target);
    const topology = await this.topology();
    const owner = findPartitionForFile(topology.root, path.posix.join(requestedPath, '__chart_query__'));
    if (owner) return { requestedPath, registryModifiedAt: topology.registryModifiedAt,
      freshness: 'unknown', chart: await this.chart(owner) };
    const node = findDirectoryTreeNode(topology.root, requestedPath);
    if (!node) throw new Error('Directory is absent from the chart registry; it may be excluded or need a refresh.');
    // A split wrapper can have no direct files, hence no chart of its own.
    const children: DirectoryTreeNode[] = [];
    const visit = (current: DirectoryTreeNode): void => {
      if (isChartOwner(current)) children.push(current);
      else current.children.forEach(visit);
    };
    node.children.forEach(visit);
    return { requestedPath, registryModifiedAt: topology.registryModifiedAt,
      freshness: 'unknown', chart: null,
      childCharts: children.map(child => ({ directory: child.directory,
        path: path.posix.join('.memoryanchor/chart', child.directory, 'chart.md') })) };
  }

  async getFile(input: string, options: { include_source?: boolean; start_line?: number; end_line?: number } = {}) {
    const target = await safePath(this.root, input);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('get_file requires a regular file path.');
    const requestedPath = relative(this.root, target);
    const topology = await this.topology();
    const owner = findPartitionForFile(topology.root, requestedPath);
    const chart = owner ? await this.chart(owner) : null;
    const architecture = chart ? extractFileArchitecture(chart.content,
      path.posix.relative(owner!.directory, requestedPath)) : null;
    let source;
    if (!options.include_source && (options.start_line !== undefined || options.end_line !== undefined)) {
      throw new Error('Line ranges require include_source: true.');
    }
    if (options.include_source) {
      const text = await readText(this.root, requestedPath);
      const lines = text.content.split(/\r?\n/);
      if (lines[lines.length - 1] === '') lines.pop();
      const start = options.start_line ?? 1;
      const end = options.end_line ?? Math.min(start + 199, Math.max(1, lines.length));
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start >= 500 || start > Math.max(1, lines.length)) {
        throw new Error('Use a valid 1-based inclusive range of at most 500 lines.');
      }
      const actualEnd = Math.min(end, lines.length);
      source = { startLine: start, endLine: actualEnd, totalLines: lines.length,
        hasMore: actualEnd < lines.length, content: lines.slice(start - 1, actualEnd).join('\n'),
        sourceModifiedAt: text.modifiedAt };
    }
    return { requestedPath, chartPath: chart?.path ?? null, chartDirectory: owner?.directory ?? null,
      architecture, indexed: architecture !== null,
      notice: architecture === null ? 'No chart entry; this file may be new, excluded, or require a refresh.' : undefined,
      registryModifiedAt: topology.registryModifiedAt, chartModifiedAt: chart?.chartModifiedAt ?? null,
      sourceModifiedAt: stat.mtime.toISOString(),
      freshness: chart && stat.mtimeMs > Date.parse(chart.chartModifiedAt) ? 'possibly_stale' : 'unknown', source };
  }
}
