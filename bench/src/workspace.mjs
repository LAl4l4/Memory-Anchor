import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './suite.mjs';

const GIT_IDENTITY = ['-c', 'user.email=bench@localhost', '-c', 'user.name=bench'];

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024, ...options });
}

export function git(cwd, args) {
  return run('git', [...GIT_IDENTITY, ...args], { cwd }).toString();
}

function listFiles(root, rel = '') {
  if (!existsSync(path.join(root, rel))) return [];
  const out = [];
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, child));
    else out.push(child);
  }
  return out;
}

/** Invariant knowledge lines, one per line in the suite file; blank lines and # comments ignored. */
export function readInvariantLines(suite) {
  return readFileSync(suite.knowledge.invariantLines, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * AGENTS.md text for a group.
 *   doc:       the full uncompressed AGENTS.md (invariant knowledge included)
 *   off:       the same file with every invariant line removed
 *   scattered: same as off; the knowledge lives in loose notes around the repo instead
 *   ma:  the compact AGENTS.md a MemoryAnchor user keeps (invariants live in .memoryanchor/)
 */
export function agentsMdFor(suite, group) {
  const lines = readInvariantLines(suite);
  if (group === 'ma') {
    const compact = readFileSync(suite.knowledge.agentsCompact, 'utf8');
    const leaked = lines.filter((line) => compact.includes(line));
    if (leaked.length) throw new Error(`AGENTS.compact.md contains invariant lines:\n${leaked.join('\n')}`);
    return compact;
  }
  const full = readFileSync(suite.knowledge.agentsFull, 'utf8');
  const fullLines = full.split('\n');
  const missing = lines.filter((line) => !fullLines.some((l) => l.trim() === line));
  if (missing.length) throw new Error(`AGENTS.full.md is missing invariant lines:\n${missing.join('\n')}`);
  if (group === 'doc') return full;
  const drop = new Set(lines);
  return fullLines.filter((l) => !drop.has(l.trim())).join('\n');
}

function javaClassName(testRoot, rel) {
  return path.relative(testRoot, rel).replace(/\.java$/, '').split(path.sep).join('.');
}

/**
 * Build a fresh workspace for one trial:
 *   export source → overlay → snapshot original tests → hide task tests → group knowledge → git baseline.
 * Agent-visible files live in <trialDir>/ws; grading metadata lives in <trialDir>/meta.
 */
// Hook commands written by `anchor init-*` call the globally installed package; point them at this
// repository's dist/ so the bench measures the MemoryAnchor version under development.
const HOOK_FILES = {
  'memoryanchor-claude-pre': 'claude/session-start.js',
  'memoryanchor-claude-stop': 'claude/stop.js',
  'memoryanchor-claude-post': 'claude/session-end.js',
  'memoryanchor-codex-pre': 'codex/session-start.js',
  'memoryanchor-codex-stop': 'codex/stop.js',
  'memoryanchor-codex-post': 'codex/session-end.js',
};

function pinHooks(ws, maRoot) {
  for (const rel of ['.claude/settings.json', '.codex/hooks.json']) {
    const file = path.join(ws, rel);
    if (!existsSync(file)) continue;
    let text = readFileSync(file, 'utf8');
    for (const [bin, script] of Object.entries(HOOK_FILES)) {
      const hook = path.join(maRoot, 'dist', 'hooks', script);
      if (!existsSync(hook)) throw new Error(`Missing ${hook}; run npm run build`);
      text = text.replaceAll(`"${bin}"`, JSON.stringify(`"${process.execPath}" "${hook}"`));
    }
    writeFileSync(file, text);
  }
}

/**
 * agent: 'mini' (MA-mini-agent), 'claude-code' or 'codex'. It decides which `anchor init-*` the ma group
 * runs and whether a CLAUDE.md importing AGENTS.md is added (Claude Code reads CLAUDE.md, not AGENTS.md).
 */
export function prepareWorkspace({ suite, task, group, trialDir, maRoot = REPO_ROOT, agent = 'mini' }) {
  const ws = path.join(trialDir, 'ws');
  const meta = path.join(trialDir, 'meta');
  rmSync(trialDir, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  mkdirSync(meta, { recursive: true });

  const archive = run('git', ['-C', suite.source.repo, 'archive', suite.source.ref, ...suite.source.paths]);
  run('tar', ['-x', '-C', ws], { input: archive });
  if (suite.overlayDir) cpSync(suite.overlayDir, ws, { recursive: true });
  for (const script of listFiles(ws).filter((f) => f.endsWith('mvnw') || f.endsWith('gradlew'))) {
    run('chmod', ['+x', path.join(ws, script)]);
  }

  const testRoot = path.join(ws, suite.testSourceRoot);
  cpSync(testRoot, path.join(meta, 'original-tests'), { recursive: true });
  const originalTestClasses = listFiles(testRoot)
    .filter((f) => /Tests?\.java$/.test(f))
    .map((f) => javaClassName(testRoot, path.join(testRoot, f)));

  for (const hidden of task.hide) rmSync(path.join(ws, hidden), { force: true });

  // 'none' (used by validate) skips knowledge so task checks do not depend on it.
  if (group !== 'none') writeFileSync(path.join(ws, 'AGENTS.md'), agentsMdFor(suite, group));

  if (group === 'scattered') {
    if (!suite.knowledge.scatteredDir) throw new Error('suite.json has no knowledge.scattered directory');
    for (const file of listFiles(suite.knowledge.scatteredDir)) {
      const target = path.join(ws, file);
      if (existsSync(target)) throw new Error(`scattered note would overwrite a repo file: ${file}`);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(suite.knowledge.scatteredDir, file), target);
    }
  }

  let maInit = null;
  if (group === 'ma') {
    const started = Date.now();
    const init = agent === 'codex' ? 'init-codex' : 'init-claude';
    const out = run(process.execPath, [path.join(maRoot, 'dist', 'cli.js'), init], { cwd: ws }).toString();
    pinHooks(ws, maRoot);
    const memoryDir = path.join(ws, '.memoryanchor');
    for (const file of listFiles(suite.knowledge.memoryDir)) {
      cpSync(path.join(suite.knowledge.memoryDir, file), path.join(memoryDir, file));
    }
    maInit = { ms: Date.now() - started, charts: (out.match(/\((\d+) charts?\)/) ?? [])[1] ?? null };
  }

  // A Claude Code user without MemoryAnchor imports AGENTS.md from CLAUDE.md (init-claude does this for ma).
  if (agent === 'claude-code' && group !== 'none' && !existsSync(path.join(ws, 'CLAUDE.md'))) {
    writeFileSync(path.join(ws, 'CLAUDE.md'), '@AGENTS.md\n');
  }

  git(ws, ['init', '-q']);
  git(ws, ['add', '-A']);
  git(ws, ['commit', '-q', '-m', 'bench baseline']);

  const info = { suite: suite.name, task: task.id, group, agent, originalTestClasses, hidden: task.hide, maInit };
  writeFileSync(path.join(meta, 'prepare.json'), `${JSON.stringify(info, null, 2)}\n`);
  return { ws, meta, info };
}

/** Apply a reference patch (solution or trap) to a prepared workspace. */
export function applyPatch(ws, patchFile) {
  run('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: ws });
}

export function changedFiles(ws) {
  const out = git(ws, ['status', '--porcelain', '--untracked-files=all']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter((file) => !file.startsWith('.memoryanchor/'));
}
