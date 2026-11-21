import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(BENCH_ROOT, '..');
/** Every group, in report order. `doc` (everything packed into AGENTS.md) is an upper-bound reference, run on request. */
export const GROUPS = ['off', 'scattered', 'doc', 'ma'];
export const DEFAULT_GROUPS = ['off', 'scattered', 'ma'];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

/** Load a suite by name (bench/suites/<name>) or by path, with all of its tasks. */
export function loadSuite(nameOrPath) {
  const dir = existsSync(nameOrPath) ? path.resolve(nameOrPath) : path.join(BENCH_ROOT, 'suites', nameOrPath);
  const suiteFile = path.join(dir, 'suite.json');
  if (!existsSync(suiteFile)) throw new Error(`No suite.json in ${dir}`);
  const config = readJson(suiteFile);
  const tasksDir = path.join(dir, 'tasks');
  const tasks = readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(tasksDir, entry.name, 'task.json')))
    .map((entry) => {
      const taskDir = path.join(tasksDir, entry.name);
      const task = readJson(path.join(taskDir, 'task.json'));
      return {
        ...task,
        id: task.id ?? entry.name,
        dir: taskDir,
        hide: task.hide ?? [],
        f2p: task.f2p ?? [],
        invariants: task.invariants ?? {},
        testsDir: path.join(taskDir, 'tests'),
        solutionPatch: path.join(taskDir, 'solution.patch'),
        trapPatch: path.join(taskDir, 'trap.patch'),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const resolve = (p) => path.resolve(dir, p);
  return {
    dir,
    ...config,
    overlayDir: config.overlay ? resolve(config.overlay) : null,
    knowledge: {
      agentsFull: resolve(config.knowledge.agentsFull),
      agentsCompact: resolve(config.knowledge.agentsCompact),
      memoryDir: resolve(config.knowledge.memoryDir),
      invariantLines: resolve(config.knowledge.invariantLines),
      scatteredDir: config.knowledge.scattered ? resolve(config.knowledge.scattered) : null,
    },
    tasks,
  };
}

export function selectTasks(suite, ids) {
  if (!ids?.length) return suite.tasks;
  const wanted = new Set(ids);
  const picked = suite.tasks.filter((t) => wanted.has(t.id));
  const missing = [...wanted].filter((id) => !picked.some((t) => t.id === id));
  if (missing.length) throw new Error(`Unknown task(s): ${missing.join(', ')}`);
  return picked;
}
