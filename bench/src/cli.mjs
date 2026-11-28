#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ENGINES, runAgent } from '../../MA-mini-agent/src/agent.mjs';
import { loadConfig } from '../../MA-mini-agent/src/config.mjs';
import { CLI_AGENTS, cliAvailable, runCliAgent } from './cliAgents.mjs';
import { gradeWorkspace } from './grade.mjs';
import { writeReport } from './report.mjs';
import { BENCH_ROOT, DEFAULT_GROUPS, GROUPS, REPO_ROOT, loadSuite, selectTasks } from './suite.mjs';
import { applyPatch, changedFiles, git, prepareWorkspace } from './workspace.mjs';

const HELP = `MemoryAnchor bench

  node bench/src/cli.mjs validate --suite <name> [--tasks a,b]
      Check every task: base fails the task tests, solution passes everything,
      trap passes the task tests but breaks at least one invariant.

  node bench/src/cli.mjs run --suite <name> [--tasks a,b] [--groups off,scattered,ma (add doc on request)] [--trials 3]
                             [--agent mini|claude-code|codex] [--agent-model m] [--agent-effort e]
                             [--agent-config MA-mini-agent/config.json] [--agent-engine langgraph|langgraph-multi|native]
                             [--max-turns 40] [--run-id id]
      Run the agent on every task × group × trial, grade, and write bench/runs/<run-id>/.
      mini (default) is MA-mini-agent with the API in --agent-config; --agent-engine overrides its
      agent.engine (langgraph by default, langgraph-multi for planner → coder → reviewer, native for the hand-written loop). claude-code and codex run the
      official CLI signed in on this machine (subscription), isolated from user-level config.

  node bench/src/cli.mjs report <run-dir>
      Rebuild report.md from results.jsonl.

Common: --work-dir <dir> (default: $TMPDIR/ma-bench) holds the disposable workspaces.
`;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      suite: { type: 'string' },
      tasks: { type: 'string' },
      groups: { type: 'string' },
      trials: { type: 'string' },
      agent: { type: 'string' },
      'agent-model': { type: 'string' },
      'agent-effort': { type: 'string' },
      'agent-timeout-min': { type: 'string' },
      'agent-config': { type: 'string' },
      'agent-engine': { type: 'string' },
      'max-turns': { type: 'string' },
      'run-id': { type: 'string' },
      'work-dir': { type: 'string' },
      'keep-workspaces': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return { command: positionals[0], rest: positionals.slice(1), ...values };
}

const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
const log = (msg) => process.stderr.write(`${msg}\n`);
const workRoot = (args) => path.resolve(args['work-dir'] ?? path.join(os.tmpdir(), 'ma-bench'));

function brief(grade) {
  const inv = Object.entries(grade.invariants).map(([rule, s]) => `${rule} ${s.passed}/${s.total}`).join(', ');
  return `build ${grade.buildOk ? 'ok' : 'FAILED'} · task ${grade.f2p.passed}/${grade.f2p.total} · invariants ${inv || '—'} · original ${grade.p2p.passed}/${grade.p2p.total} · ${Math.round(grade.testMs / 1000)}s`;
}

async function validate(args) {
  const suite = loadSuite(args.suite);
  const tasks = selectTasks(suite, list(args.tasks));
  const root = path.join(workRoot(args), `validate-${Date.now()}`);
  let ok = true;
  for (const task of tasks) {
    for (const variant of ['base', 'solution', 'trap']) {
      const trialDir = path.join(root, task.id, variant);
      const { ws, meta } = prepareWorkspace({ suite, task, group: 'none', trialDir });
      if (variant !== 'base') applyPatch(ws, variant === 'solution' ? task.solutionPatch : task.trapPatch);
      const grade = await gradeWorkspace({ suite, task, ws, meta });
      const invBroken = Object.values(grade.invariants).some((s) => s.passed < s.total);
      const p2pClean = grade.buildOk && !grade.regressed;
      const expected =
        variant === 'base' ? p2pClean && grade.f2p.passed < grade.f2p.total
        : variant === 'solution' ? grade.intact
        : p2pClean && grade.resolved && invBroken;
      ok &&= expected;
      log(`${expected ? '✓' : '✗'} ${task.id.padEnd(18)} ${variant.padEnd(8)} ${brief(grade)}`);
      if (!expected) {
        for (const f of [...grade.f2p.failing, ...grade.p2p.failing]) log(`    ${f}`);
        if (!grade.buildOk) log(grade.testOutputTail);
      }
    }
  }
  if (!args['keep-workspaces']) rmSync(root, { recursive: true, force: true });
  log(ok ? '\nAll tasks valid.' : '\nSome tasks are invalid; fix them before running the bench.');
  return ok ? 0 : 1;
}

async function run(args) {
  const suite = loadSuite(args.suite);
  const tasks = selectTasks(suite, list(args.tasks));
  const groups = list(args.groups) ?? DEFAULT_GROUPS;
  for (const g of groups) if (!GROUPS.includes(g)) throw new Error(`Unknown group ${g}`);
  const trials = Number.parseInt(args.trials ?? '3', 10);
  const agentKind = args.agent ?? 'mini';
  if (agentKind !== 'mini' && !CLI_AGENTS.includes(agentKind)) throw new Error(`Unknown agent ${agentKind}; use mini, ${CLI_AGENTS.join(', ')}`);
  if (agentKind !== 'mini' && !cliAvailable(agentKind)) throw new Error(`${agentKind} CLI not found on PATH`);
  const agentEngine = args['agent-engine'];
  if (agentEngine && agentKind !== 'mini') throw new Error('--agent-engine only applies to --agent mini');
  if (agentEngine && !ENGINES.includes(agentEngine)) throw new Error(`Unknown --agent-engine ${agentEngine}; use ${ENGINES.join(', ')}`);
  const runId = args['run-id'] ?? `${suite.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = path.join(BENCH_ROOT, 'runs', runId);
  const wsRoot = path.join(workRoot(args), runId);
  mkdirSync(runDir, { recursive: true });
  const resultsFile = path.join(runDir, 'results.jsonl');
  writeFileSync(
    path.join(runDir, 'run.json'),
    `${JSON.stringify({ suite: suite.name, source: suite.source, agent: agentKind, ...(agentKind === 'mini' ? { agentEngine: agentEngine ?? null } : {}), agentModel: args['agent-model'] ?? null, tasks: tasks.map((t) => t.id), groups, trials, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  const total = tasks.length * groups.length * trials;
  let done = 0;
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const task of tasks) {
      // Rotate group order per trial so no group always runs first.
      const order = groups.map((_, i) => groups[(i + trial - 1) % groups.length]);
      for (const group of order) {
        done += 1;
        const label = `[${done}/${total}] ${task.id} / ${group} / t${trial}`;
        const trialDir = path.join(wsRoot, task.id, group, `t${trial}`);
        const outDir = path.join(runDir, 'trials', task.id, group, `t${trial}`);
        mkdirSync(outDir, { recursive: true });
        log(`${label}: preparing workspace`);
        const { ws, meta, info } = prepareWorkspace({ suite, task, group, trialDir, agent: agentKind });

        let agent;
        if (agentKind === 'mini') {
          const config = loadConfig(args['agent-config'], {
            memoryAnchor: { enabled: group === 'ma', promptHook: false },
            agent: {
              ...(agentEngine ? { engine: agentEngine } : {}),
              ...(args['max-turns'] ? { maxTurns: Number.parseInt(args['max-turns'], 10) } : {}),
            },
          });
          log(`${label}: agent running (${config.agent.engine} · ${config.provider}/${config.providers?.[config.provider]?.model ?? ''})`);
          agent = await runAgent({ config, workspace: ws, task: task.prompt, traceFile: path.join(outDir, 'trace.jsonl') });
        } else {
          log(`${label}: agent running (${agentKind}${args['agent-model'] ? `/${args['agent-model']}` : ''})`);
          agent = await runCliAgent({
            kind: agentKind,
            ws,
            prompt: task.prompt,
            group,
            traceFile: path.join(outDir, 'trace.jsonl'),
            maRoot: REPO_ROOT,
            model: args['agent-model'],
            effort: args['agent-effort'],
            ...(args['max-turns'] ? { maxTurns: Number.parseInt(args['max-turns'], 10) } : {}),
            ...(args['agent-timeout-min'] ? { timeoutMs: Number.parseFloat(args['agent-timeout-min']) * 60_000 } : {}),
          });
        }
        writeFileSync(path.join(outDir, 'agent-result.json'), `${JSON.stringify(agent, null, 2)}\n`);
        const changed = changedFiles(ws);
        git(ws, ['add', '--intent-to-add', '--all']); // include files the agent created
        writeFileSync(path.join(outDir, 'diff.patch'), git(ws, ['diff', 'HEAD', '--', '.', ':(exclude).memoryanchor']));

        log(`${label}: grading (agent ${agent.status}, ${agent.turns} turns)`);
        const grade = await gradeWorkspace({ suite, task, ws, meta });
        const { finalText, ...agentSummary } = agent;
        const row = {
          task: task.id,
          group,
          trial,
          agent: { ...agentSummary, finalText: finalText?.slice(0, 2000) },
          changedFiles: changed,
          maInit: info.maInit,
          grade,
        };
        appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
        log(`${label}: ${grade.intact ? 'INTACT' : grade.resolved ? 'resolved, not intact' : 'unresolved'} · ${brief(grade)}`);

        rmSync(path.join(ws, 'Backend', 'target'), { recursive: true, force: true });
        if (!args['keep-workspaces']) rmSync(trialDir, { recursive: true, force: true });
      }
    }
  }
  const report = writeReport(runDir);
  process.stdout.write(`\n${report}\nResults: ${runDir}\n`);
  return 0;
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(HELP);
    return args.command ? 0 : 2;
  }
  if (args.command === 'report') {
    const dir = path.resolve(args.rest[0] ?? '');
    if (!existsSync(path.join(dir, 'results.jsonl'))) throw new Error(`No results.jsonl in ${dir}`);
    process.stdout.write(writeReport(dir));
    return 0;
  }
  if (!args.suite) throw new Error('--suite is required');
  if (args.command === 'validate') return validate(args);
  if (args.command === 'run') return run(args);
  throw new Error(`Unknown command ${args.command}`);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(2);
  },
);
