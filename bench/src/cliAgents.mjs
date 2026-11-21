// Run an official coding-agent CLI (Claude Code or Codex) as the bench agent.
// The CLI uses the account it is already signed in with on this machine; nothing here reads
// or copies credentials. Each run is isolated from user-level instructions, MCP servers,
// plugins and memories so that groups differ only in the knowledge the harness puts in the workspace.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLI_AGENTS = ['claude-code', 'codex'];

/** Bench defaults when --agent-model / --agent-effort are not given (Codex otherwise uses ~/.codex/config.toml). */
export const CODEX_DEFAULTS = { model: 'gpt-6.2-sol', effort: 'low' };

// Host/session variables (e.g. from the Claude desktop app) and API keys that would switch the CLI
// from the signed-in subscription to API billing, or leak a key into model-run commands.
const STRIP_ENV = /^(CLAUDE_CODE_|CLAUDECODE$|ANTHROPIC_|OPENAI_API_KEY$|OPENAI_BASE_URL$|CODEX_API_KEY$|DEEPSEEK_API_KEY$)/;

function childEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !STRIP_ENV.test(key)));
}

function claudeArgs({ ws, prompt, group, model, maxTurns }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    // project + local only: skips ~/.claude/CLAUDE.md, user hooks, user-enabled plugins.
    '--setting-sources', 'project,local',
    '--strict-mcp-config',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--no-chrome',
    '--max-turns', String(maxTurns),
  ];
  if (group === 'ma') args.push('--mcp-config', path.join(ws, '.mcp.json'));
  if (model) args.push('--model', model);
  return args;
}

/** Top-level `model`, `model_reasoning_effort` and MCP server names from the user's Codex config. */
export function codexUserConfig() {
  const file = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { mcpServers: [], model: null, effort: null };
  }
  const top = text.split(/^\[/m)[0];
  const value = (key) => (top.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm')) ?? [])[1] ?? null;
  const mcpServers = [...new Set([...text.matchAll(/^\[mcp_servers\.("?)([^\]".]+)\1\]/gm)].map((m) => m[2]))];
  return { mcpServers, model: value('model'), effort: value('model_reasoning_effort') };
}

function codexArgs({ ws, prompt, group, model, effort, maRoot }) {
  // `--ignore-user-config` would also drop project hooks and -c MCP servers, so the user config is
  // loaded and everything that could carry user knowledge or side effects is switched off instead.
  const user = codexUserConfig();
  const args = [
    'exec', '--json',
    '--disable', 'memories', '--disable', 'plugins', '--disable', 'apps',
    '--ignore-rules',
    '-c', 'notify=[]',
    // Standard tier, never the user's priority tier (it burns quota faster).
    '-c', 'service_tier="default"',
    '--ephemeral',
    '-s', 'workspace-write',
    '--skip-git-repo-check',
    '-C', ws,
  ];
  for (const name of user.mcpServers) args.push('-c', `mcp_servers.${name}.enabled=false`);
  if (group === 'ma') {
    args.push(
      '-c', `mcp_servers.memory-anchor.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.memory-anchor.args=${JSON.stringify([path.join(maRoot, 'dist', 'cli.js'), 'mcp', '--workspace', ws])}`,
      '-c', `mcp_servers.memory-anchor.enabled=true`,
      '-c', `projects.${JSON.stringify(ws)}.trust_level="trusted"`,
      // The workspace hooks were written by the harness (anchor init-codex), so they are trusted.
      '--dangerously-bypass-hook-trust',
    );
  }
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
  args.push(prompt);
  return args;
}

/** Workspace-relative paths of existing files mentioned in a shell command (for read diagnostics). */
function filesInCommand(ws, command) {
  const out = [];
  for (const raw of String(command).split(/[\s|;&<>()]+/)) {
    const tok = raw.replace(/^['"]|['"]$/g, '').replace(/:\d+(-\d+)?$/, '');
    if (!tok || tok.startsWith('-') || tok.length > 300) continue;
    const abs = path.resolve(ws, tok);
    if (!abs.startsWith(ws + path.sep)) continue;
    try {
      if (statSync(abs).isFile()) out.push(path.relative(ws, abs));
    } catch {
      // not a file
    }
  }
  return out;
}

class Tally {
  constructor(ws) {
    this.ws = ws;
    // macOS temp dirs live under /var, a symlink to /private/var; agents may report either form.
    try {
      this.realWs = realpathSync(ws);
    } catch {
      this.realWs = ws;
    }
    this.toolCounts = {};
    this.toolCalls = 0;
    this.toolErrors = 0;
    this.read = new Set();
    this.written = new Set();
    this.inspections = [];
    this.commands = [];
  }

  rel(p) {
    if (!p) return null;
    const abs = path.resolve(this.ws, p);
    for (const root of [this.ws, this.realWs]) {
      if (abs.startsWith(root + path.sep)) return path.relative(root, abs);
    }
    return p;
  }

  tool(name) {
    this.toolCalls += 1;
    this.toolCounts[name] = (this.toolCounts[name] ?? 0) + 1;
  }

  inspect(p, via) {
    const rel = this.rel(p);
    if (!rel) return;
    if (!this.read.has(rel)) this.inspections.push({ path: rel, via });
    this.read.add(rel);
  }

  command(cmd) {
    this.commands.push(String(cmd).slice(0, 500));
    for (const f of filesInCommand(this.ws, cmd)) this.inspect(f, 'command');
  }

  files() {
    return { read: [...this.read], written: [...this.written] };
  }
}

/** Claude Code stream-json → common result fields. */
function parseClaude(events, ws) {
  const t = new Tally(ws);
  const messageIds = new Set();
  let final = null;
  let init = null;
  for (const e of events) {
    if (e.type === 'system' && e.subtype === 'init') init = e;
    if (e.type === 'result') final = e;
    if (e.type === 'assistant') {
      if (e.message?.id) messageIds.add(e.message.id);
      for (const block of e.message?.content ?? []) {
        if (block.type !== 'tool_use') continue;
        const input = block.input ?? {};
        t.tool(block.name);
        if (['Read', 'NotebookRead'].includes(block.name)) t.inspect(input.file_path, block.name);
        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.name) && input.file_path) t.written.add(t.rel(input.file_path));
        if (block.name === 'Bash') t.command(input.command);
        if (/get_file$/.test(block.name) && input.path) t.inspect(input.path, 'get_file');
      }
    }
    if (e.type === 'user') {
      for (const block of e.message?.content ?? []) if (block.type === 'tool_result' && block.is_error) t.toolErrors += 1;
    }
  }
  const u = final?.usage ?? {};
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const status = !final ? 'error' : final.subtype === 'success' && !final.is_error ? 'completed' : final.subtype === 'error_max_turns' ? 'max_turns' : 'error';
  return {
    status,
    ...(status === 'error' ? { error: final ? `${final.subtype}${final.api_error_status ? ` (${final.api_error_status})` : ''}` : 'no result event' } : {}),
    finalText: final?.result ?? '',
    model: init?.model ?? null,
    turns: final?.num_turns ?? messageIds.size,
    usage: { input: (u.input_tokens ?? 0) + cacheRead + cacheWrite, output: u.output_tokens ?? 0, cacheRead, cacheWrite },
    costUsd: final?.total_cost_usd ?? null,
    memoryAnchor: init ? { mcp: (init.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`) } : null,
    tally: t,
  };
}

/** Codex exec --json → common result fields. Codex does not report model calls, so turns = tool calls + 1. */
function parseCodex(events, ws) {
  const t = new Tally(ws);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let finalText = '';
  let failed = null;
  let completed = false;
  for (const e of events) {
    if (e.type === 'turn.completed') {
      completed = true;
      usage.input += e.usage?.input_tokens ?? 0;
      usage.cacheRead += e.usage?.cached_input_tokens ?? 0;
      usage.output += e.usage?.output_tokens ?? 0;
    }
    if (e.type === 'turn.failed' || e.type === 'error') failed = e.error?.message ?? e.message ?? e.type;
    if (e.type !== 'item.completed') continue;
    const item = e.item ?? {};
    if (item.type === 'agent_message') finalText = item.text ?? finalText;
    if (item.type === 'command_execution') {
      t.tool('command');
      if (item.exit_code !== 0) t.toolErrors += 1;
      t.command(item.command);
    }
    if (item.type === 'file_change') {
      t.tool('file_change');
      for (const c of item.changes ?? []) t.written.add(t.rel(c.path));
    }
    if (item.type === 'mcp_tool_call') {
      t.tool(`${item.server}.${item.tool}`);
      if (item.status === 'failed') t.toolErrors += 1;
      const args = typeof item.arguments === 'string' ? safeJson(item.arguments) : item.arguments;
      if (item.tool === 'get_file' && args?.path) t.inspect(args.path, 'get_file');
    }
    if (item.type === 'web_search') t.tool('web_search');
  }
  const status = failed ? 'error' : completed ? 'completed' : 'error';
  return {
    status,
    ...(status === 'error' ? { error: failed ?? 'no turn.completed event' } : {}),
    finalText,
    model: null,
    turns: t.toolCalls + 1,
    usage,
    costUsd: null,
    memoryAnchor: null,
    tally: t,
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Run one task with a CLI agent. Writes the raw JSONL event stream to traceFile and returns a result
 * shaped like MA-mini-agent's runAgent result so grading and reporting stay the same.
 */
export async function runCliAgent({ kind, ws, prompt, group, traceFile, maRoot, model, effort, maxTurns = 60, timeoutMs = 45 * 60_000 }) {
  if (!CLI_AGENTS.includes(kind)) throw new Error(`Unknown CLI agent ${kind}`);
  const command = kind === 'claude-code' ? 'claude' : 'codex';
  if (kind === 'codex') {
    model ??= CODEX_DEFAULTS.model;
    effort ??= CODEX_DEFAULTS.effort;
  }
  const args = kind === 'claude-code' ? claudeArgs({ ws, prompt, group, model, maxTurns }) : codexArgs({ ws, prompt, group, model, effort, maRoot });
  const started = Date.now();
  const trace = createWriteStream(traceFile);
  const events = [];
  let stderr = '';
  let buffer = '';
  let timedOut = false;

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ws, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      trace.write(chunk);
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('{')) {
          const event = safeJson(line);
          if (event) events.push(event);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Cannot start ${command}: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const tail = buffer.trim();
  if (tail.startsWith('{')) {
    const event = safeJson(tail);
    if (event) events.push(event);
  }
  await new Promise((resolve) => trace.end(resolve));

  const parsed = kind === 'claude-code' ? parseClaude(events, ws) : parseCodex(events, ws);
  const { tally, ...rest } = parsed;
  let status = rest.status;
  let error = rest.error;
  if (timedOut) {
    status = 'error';
    error = `timed out after ${Math.round(timeoutMs / 60000)} min`;
  } else if (status === 'error' && !error) {
    error = `exit ${exitCode}`;
  }
  return {
    ...rest,
    status,
    ...(error ? { error, stderrTail: stderr.trim().split('\n').slice(-15).join('\n') } : {}),
    provider: kind,
    model: rest.model ?? model ?? 'default',
    ...(kind === 'codex' ? { effort } : {}),
    workspace: ws,
    exitCode,
    durationMs: Date.now() - started,
    toolCalls: tally.toolCalls,
    toolErrors: tally.toolErrors,
    toolCounts: tally.toolCounts,
    files: tally.files(),
    inspections: tally.inspections,
    commands: tally.commands,
  };
}

export function cliAvailable(kind) {
  const bin = kind === 'claude-code' ? 'claude' : 'codex';
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => existsSync(path.join(dir, bin)));
}
