import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type BuildChartFull = typeof import('../../dist/chartBuild/buildChart.js').buildChartFull;
type DestroyPool = typeof import('../../dist/chartBuild/buildChart.js').destroyPool;
type UpdateChartIncrementally =
  typeof import('../../dist/chartBuild/incremental.js').updateChartIncrementally;
type BuildChartContent =
  typeof import('../../dist/chartBuild/render/chartContentBuilder.js').buildChartContent;
type BatchParseFiles = typeof import('../../dist/chartBuild/parse/ASTParser.js').batchParseFiles;
type ParserWorkerPoolConstructor =
  typeof import('../../dist/chartBuild/parse/parserPool.js').ParserWorkerPool;

export interface ChildProcessOutput {
  stdout: string;
  stderr: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const fixtures = [
  { file: 'sample.c' },
  { file: 'sample.py' },
  { file: 'Sample.java' },
  { file: 'sample.js' },
  { file: 'sample.ts' }
];

const fixtureRelPaths = fixtures.map(({ file }) =>
  path.posix.join('tests', 'chart', 'test-src', file)
);

const expectedExports = new Map([
  [path.posix.join('tests', 'chart', 'test-src', 'sample.c'), ['- add()']],
  [path.posix.join('tests', 'chart', 'test-src', 'sample.py'), ['- greet()']],
  [path.posix.join('tests', 'chart', 'test-src', 'sample.js'), ['+ add()']],
  [path.posix.join('tests', 'chart', 'test-src', 'sample.ts'), ['+ add(a: number, b: number): number [L1-3]']]
]);

const incrementalRelPaths = Array.from(expectedExports.keys());

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLegacyNodeBlock(chartContent: string, relPath: string): string | null {
  const matcher = new RegExp(
    `### \\/${escapeRegExp(relPath)}(?: -> [^\\n]+)?\\n([\\s\\S]*?)(?=\\n### \\/|$)`
  );
  const match = chartContent.match(matcher);
  return match ? match[1] : null;
}

function getNodeBlock(chartContent: string, relPath: string): string | null {
  const normalizedPath = relPath.replace(/\\/g, '/');
  const lines = chartContent.replace(/\\/g, '/').split('\n');
  let currentDir = '.';
  let block = null;

  for (const line of lines) {
    const directoryMatch = line.match(/^### (.+)\/$/);
    if (directoryMatch) {
      if (block) break;
      currentDir = directoryMatch[1];
      continue;
    }

    const fileMatch = line.match(/^- ([^\s]+)(?: -> .*)?$/);
    if (fileMatch) {
      if (block) break;
      const displayedPath = fileMatch[1];
      const candidate = displayedPath.startsWith('/')
        ? displayedPath.slice(1)
        : currentDir === '.'
          ? displayedPath
          : path.posix.join(currentDir, displayedPath);
      if (candidate === normalizedPath) block = [line];
      continue;
    }

    if (block) {
      if (line.startsWith('## ') || line.startsWith('### ')) break;
      if (line.startsWith('  - ') || line.startsWith('  + ') || line.startsWith('    ')) {
        block.push(line);
      }
    }
  }

  return block ? block.join('\n') : null;
}

function runChildNode(args: string[], timeoutMs = 10_000): Promise<ChildProcessOutput> {
  return new Promise<ChildProcessOutput>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Child process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Child process failed (code=${code}, signal=${signal}): ${stderr}`));
    });
  });
}

async function seedFixtures(baseDir: string): Promise<void> {
  const fixturesDir = path.join(baseDir, 'tests', 'chart', 'test-src');
  await mkdir(fixturesDir, { recursive: true });

  for (const { file } of fixtures) {
    const source = path.join(repoRoot, 'tests', 'chart', 'test-src', file);
    const destination = path.join(fixturesDir, file);
    await copyFile(source, destination);
  }
}

class BuildChartTestContext {
  tempDir = '';
  anchorDir = '';
  indexPath = '';
  chartPath = '';
  registryPath = '';
  buildChartFull!: BuildChartFull;
  updateChartIncrementally!: UpdateChartIncrementally;
  destroyPool!: DestroyPool;
  buildChartContent!: BuildChartContent;
  batchParseFiles!: BatchParseFiles;
  ParserWorkerPool!: ParserWorkerPoolConstructor;

  private async cleanupAnchor(): Promise<void> {
    if (this.anchorDir) {
      await rm(this.anchorDir, { recursive: true, force: true });
    }
  }

  async setup(): Promise<void> {
    this.tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-chart-'));
    process.chdir(this.tempDir);
    await seedFixtures(this.tempDir);

    ({ buildChartFull: this.buildChartFull, destroyPool: this.destroyPool } =
      await import('../../dist/chartBuild/buildChart.js'));
    ({ updateChartIncrementally: this.updateChartIncrementally } =
      await import('../../dist/chartBuild/incremental.js'));
    ({ buildChartContent: this.buildChartContent } =
      await import('../../dist/chartBuild/render/chartContentBuilder.js'));
    ({ batchParseFiles: this.batchParseFiles } =
      await import('../../dist/chartBuild/parse/ASTParser.js'));
    ({ ParserWorkerPool: this.ParserWorkerPool } =
      await import('../../dist/chartBuild/parse/parserPool.js'));

    this.anchorDir = path.join(this.tempDir, '.memoryanchor');
    this.indexPath = path.join(this.anchorDir, 'index.md');
    this.chartPath = path.join(this.anchorDir, 'chart', 'chart.md');
    this.registryPath = path.join(this.anchorDir, 'dirTree.json');
  }

  async reset(): Promise<void> {
    await this.cleanupAnchor();
    await seedFixtures(this.tempDir);
  }

  async teardown(): Promise<void> {
    await this.destroyPool();
    await this.cleanupAnchor();
    process.chdir(repoRoot);
    if (this.tempDir) {
      await rm(this.tempDir, { recursive: true, force: true });
    }
  }
}

function createBuildChartTestContext(): BuildChartTestContext {
  return new BuildChartTestContext();
}

export {
  createBuildChartTestContext,
  expectedExports,
  fixtureRelPaths,
  fixtures,
  getNodeBlock,
  pathToFileURL,
  repoRoot,
  runChildNode,
  incrementalRelPaths,
};
