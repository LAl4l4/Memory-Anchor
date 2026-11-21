#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAgent } from './agent.mjs';
import { AGENT_ROOT, loadConfig } from './config.mjs';

const HELP = `ma-mini-agent — minimal coding agent for measuring MemoryAnchor

Usage:
  node MA-mini-agent/src/cli.mjs -w <workspace> (-p "<task>" | -f <task.md>) [options]

Options:
  -w, --workspace <dir>   Repository the agent works in (default: current directory)
  -p, --prompt <text>     Task prompt
  -f, --prompt-file <f>   Read the task prompt from a file
  -c, --config <file>     Config file (default: MA-mini-agent/config.json or $MA_AGENT_CONFIG)
      --provider <name>   Override config.provider (openai | anthropic | mock)
      --model <id>        Override the selected provider's model
      --ma / --no-ma      Enable / disable MemoryAnchor (hooks + MCP)
      --prompt-hook       Also append the MemoryAnchor UserPromptSubmit reminder
      --no-stop-hook      Skip the MemoryAnchor Stop hook (chart refresh) after the run
      --max-turns <n>     Model call limit (default from config, 40)
      --no-commands       Do not expose run_command
  -o, --out <dir>         Where to write trace.jsonl and result.json (default: MA-mini-agent/runs/<timestamp>)
  -q, --quiet             Only print the final answer and result path
  -h, --help              Show this help
`;

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    allowNegative: true,
    options: {
      workspace: { type: 'string', short: 'w' },
      prompt: { type: 'string', short: 'p' },
      'prompt-file': { type: 'string', short: 'f' },
      config: { type: 'string', short: 'c' },
      provider: { type: 'string' },
      model: { type: 'string' },
      ma: { type: 'boolean' },
      'prompt-hook': { type: 'boolean' },
      'stop-hook': { type: 'boolean' },
      'max-turns': { type: 'string' },
      commands: { type: 'boolean' },
      out: { type: 'string', short: 'o' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return values;
}

function cliOverrides(args) {
  const overrides = { agent: {}, memoryAnchor: {} };
  if (args.provider) overrides.provider = args.provider;
  if (args.ma !== undefined) overrides.memoryAnchor.enabled = args.ma;
  if (args['prompt-hook'] !== undefined) overrides.memoryAnchor.promptHook = args['prompt-hook'];
  if (args['stop-hook'] !== undefined) overrides.memoryAnchor.stopHook = args['stop-hook'];
  if (args.commands !== undefined) overrides.agent.allowCommands = args.commands;
  if (args['max-turns']) {
    const n = Number.parseInt(args['max-turns'], 10);
    if (!Number.isFinite(n) || n < 1) throw new Error('--max-turns must be a positive integer');
    overrides.agent.maxTurns = n;
  }
  return overrides;
}

const dim = (s) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const short = (v, n = 120) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function printEvent(event) {
  switch (event.type) {
    case 'run_start':
      process.stderr.write(dim(`▶ ${event.provider}/${event.model}  MA=${event.memoryAnchor ? 'on' : 'off'}  tools=${event.tools.length}  system=${event.systemChars} chars\n`));
      break;
    case 'ma_hook':
      process.stderr.write(dim(`  [MA] ${event.hook} ${event.ok ? 'ok' : 'FAILED'} ${event.ms}ms${event.bytes !== undefined ? ` ${event.bytes}B` : ''}${event.stderr ? ` — ${short(event.stderr)}` : ''}\n`));
      break;
    case 'ma_mcp':
      process.stderr.write(dim(`  [MA] MCP tools: ${event.tools.join(', ')} (${event.ms}ms)\n`));
      break;
    case 'model_turn':
      if (event.text) process.stderr.write(`\n${event.text.trim()}\n`);
      process.stderr.write(dim(`  turn ${event.turn} · ${event.stopReason} · in ${event.usage.input} out ${event.usage.output}${event.usage.cacheRead ? ` cache ${event.usage.cacheRead}` : ''} · ${event.ms}ms\n`));
      break;
    case 'tool_result':
      process.stderr.write(`  ${event.isError ? '✗' : '→'} ${event.name} ${dim(short(event.input))}${event.isError ? `\n    ${short(event.preview, 200)}` : ''}\n`);
      break;
    case 'warning':
      process.stderr.write(`  ! ${event.message}\n`);
      break;
    case 'error':
      process.stderr.write(`  ✗ ${event.message}\n`);
      break;
    default:
      break;
  }
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const task = args['prompt-file'] ? readFileSync(args['prompt-file'], 'utf8') : args.prompt;
  if (!task) {
    process.stderr.write(`Missing task: pass -p "<task>" or -f <file>.\n\n${HELP}`);
    return 2;
  }

  const config = loadConfig(args.config, cliOverrides(args));
  if (args.model) config.providers[config.provider] = { ...config.providers[config.provider], model: args.model };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(args.out ?? path.join(AGENT_ROOT, 'runs', stamp));
  mkdirSync(outDir, { recursive: true });

  const result = await runAgent({
    config,
    workspace: args.workspace ?? process.cwd(),
    task,
    traceFile: path.join(outDir, 'trace.jsonl'),
    onEvent: args.quiet ? undefined : printEvent,
  });
  writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);

  if (args.quiet && result.finalText) process.stdout.write(`${result.finalText.trim()}\n`);
  const u = result.usage;
  process.stderr.write(
    `\n■ ${result.status}${result.error ? ` (${result.error})` : ''} · ${result.turns} turns · ${result.toolCalls} tool calls · ` +
      `in ${u.input} out ${u.output} cache ${u.cacheRead} · ${(result.durationMs / 1000).toFixed(1)}s\n` +
      `  files read ${result.files.read.length}, written ${result.files.written.length} · result: ${path.join(outDir, 'result.json')}\n`,
  );
  return result.status === 'completed' ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  },
);
