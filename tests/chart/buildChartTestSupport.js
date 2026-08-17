import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function runChildNode(args, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
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

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
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

async function seedFixtures(baseDir) {
  const fixturesDir = path.join(baseDir, 'tests', 'chart', 'test-src');
  await mkdir(fixturesDir, { recursive: true });

  for (const { file } of fixtures) {
    const source = path.join(repoRoot, 'tests', 'chart', 'test-src', file);
    const destination = path.join(fixturesDir, file);
    await copyFile(source, destination);
  }
}

function createBuildChartTestContext() {
  const context = {
    tempDir: '',
    anchorDir: '',
    indexPath: '',
    chartPath: '',
    registryPath: '',
    buildChartFull: null,
    updateChartIncrementally: null,
    destroyPool: null,
    buildChartContent: null,
    batchParseFiles: null,
    ParserWorkerPool: null,
  };

  async function cleanupAnchor() {
    if (context.anchorDir) {
      await rm(context.anchorDir, { recursive: true, force: true });
    }
  }

  context.setup = async () => {
    context.tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-chart-'));
    process.chdir(context.tempDir);
    await seedFixtures(context.tempDir);

    ({ buildChartFull: context.buildChartFull, destroyPool: context.destroyPool } =
      await import('../../dist/chartBuild/buildChart.js'));
    ({ updateChartIncrementally: context.updateChartIncrementally } =
      await import('../../dist/chartBuild/incremental.js'));
    ({ buildChartContent: context.buildChartContent } =
      await import('../../dist/chartBuild/render/chartContentBuilder.js'));
    ({ batchParseFiles: context.batchParseFiles } =
      await import('../../dist/chartBuild/parse/ASTParser.js'));
    ({ ParserWorkerPool: context.ParserWorkerPool } =
      await import('../../dist/chartBuild/parse/parserPool.js'));

    context.anchorDir = path.join(context.tempDir, '.memoryanchor');
    context.indexPath = path.join(context.anchorDir, 'index.md');
    context.chartPath = path.join(context.anchorDir, 'chart', 'chart.md');
    context.registryPath = path.join(context.anchorDir, 'dirTree.json');
  };

  context.reset = async () => {
    await cleanupAnchor();
    await seedFixtures(context.tempDir);
  };

  context.teardown = async () => {
    if (context.destroyPool) await context.destroyPool();
    await cleanupAnchor();
    process.chdir(repoRoot);
    if (context.tempDir) {
      await rm(context.tempDir, { recursive: true, force: true });
    }
  };

  return context;
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
