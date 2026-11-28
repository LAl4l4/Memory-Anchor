import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * MemoryAnchor wiring that mirrors a native harness integration (Claude Code's):
 *   SessionStart hook stdout → system prompt
 *   UserPromptSubmit hook stdout → appended to the task prompt (optional)
 *   memory-anchor MCP server → get_chart / get_file / get_memory / recall_memory / write_memory tools
 *   Stop hook → incremental chart refresh after the run
 * Hooks run from <root>/dist so the bench measures the local build, not a global install.
 */

function hookPath(root, name) {
  return path.join(root, 'dist', 'hooks', 'claude', `${name}.js`);
}

function runNode(script, args, { cwd, timeoutMs }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.end('{}');
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, exitCode: code, timedOut, stdout, stderr: stderr.trim(), ms: Date.now() - started });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, timedOut: false, stdout, stderr: error.message, ms: Date.now() - started });
    });
  });
}

/** Hooks log progress to stderr; keep it only when the hook failed. */
function failureDetail(res) {
  if (res.ok) return {};
  const stderr = res.stderr.replace(/\x1b\[[0-9;]*m/g, '').slice(-2000);
  return { exitCode: res.exitCode, timedOut: res.timedOut, stderr };
}

function mcpResultText(result) {
  return (result.content ?? [])
    .map((part) => (part.type === 'text' ? part.text : `[${part.type} content]`))
    .join('\n');
}

/** Files a MemoryAnchor query looked at, so the trace can credit MCP lookups as retrieval. */
function mcpMeta(name, args) {
  const target = typeof args?.path === 'string' ? args.path.replace(/^\.\//, '') : undefined;
  if (name === 'get_file' && target) {
    return { maFiles: [target], ...(args.include_source ? { read: [target] } : {}) };
  }
  if (name === 'get_chart') return { maCharts: [target ?? '.'] };
  if (name === 'get_memory') return { maState: [args?.id ?? args?.kind ?? '*'] };
  if (name === 'recall_memory') return { maState: [`recall:${args?.query ?? ''}`] };
  return {};
}

export async function startMemoryAnchor({ settings, workspace, emit }) {
  const root = settings.root;
  const cli = path.join(root, 'dist', 'cli.js');
  if (!existsSync(cli) || !existsSync(hookPath(root, 'session-start'))) {
    throw new Error(`MemoryAnchor build not found under ${root}/dist. Run \`npm run build\` in ${root} first.`);
  }
  const initialized = existsSync(path.join(workspace, '.memoryanchor'));
  if (!initialized) {
    emit({ type: 'warning', message: `${workspace} has no .memoryanchor/ — run \`anchor init\` there or MemoryAnchor will add little context.` });
  }

  const state = {
    root,
    initialized,
    context: '',
    contextBytes: 0,
    promptAppendix: '',
    instructions: '',
    tools: [],
    hooks: {},
  };

  if (settings.sessionStartHook) {
    const res = await runNode(hookPath(root, 'session-start'), [], { cwd: workspace, timeoutMs: settings.hookTimeoutMs });
    state.hooks.sessionStart = { ok: res.ok, ms: res.ms, bytes: Buffer.byteLength(res.stdout), ...failureDetail(res) };
    if (res.ok) {
      state.context = res.stdout.trim();
      state.contextBytes = Buffer.byteLength(state.context);
    }
    emit({ type: 'ma_hook', hook: 'SessionStart', ...state.hooks.sessionStart });
  }

  if (settings.promptHook) {
    const res = await runNode(hookPath(root, 'user-prompt'), [], { cwd: workspace, timeoutMs: settings.hookTimeoutMs });
    state.hooks.userPrompt = { ok: res.ok, ms: res.ms, bytes: Buffer.byteLength(res.stdout) };
    if (res.ok) state.promptAppendix = res.stdout.trim();
    emit({ type: 'ma_hook', hook: 'UserPromptSubmit', ...state.hooks.userPrompt });
  }

  let client = null;
  if (settings.mcp) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', '--workspace', workspace],
      cwd: workspace,
      stderr: 'pipe',
    });
    client = new Client({ name: 'ma-mini-agent', version: '0.1.0' });
    const started = Date.now();
    await client.connect(transport);
    const { tools } = await client.listTools();
    state.instructions = client.getInstructions?.() ?? '';
    state.tools = tools.map((tool) => ({
      name: tool.name,
      kind: 'mcp',
      description: `[memory-anchor MCP] ${tool.description ?? ''}`.trim(),
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      async run(input) {
        const result = await client.callTool({ name: tool.name, arguments: input });
        return { output: mcpResultText(result) || '(empty result)', isError: Boolean(result.isError), meta: mcpMeta(tool.name, input) };
      },
    }));
    emit({ type: 'ma_mcp', tools: state.tools.map((t) => t.name), ms: Date.now() - started });
  }

  return {
    ...state,
    /** Run the Stop hook (incremental chart refresh) — call once after the agent finishes. */
    async stop() {
      if (!settings.stopHook) return null;
      const res = await runNode(hookPath(root, 'stop'), [], { cwd: workspace, timeoutMs: settings.hookTimeoutMs });
      const summary = { ok: res.ok, ms: res.ms, ...failureDetail(res) };
      state.hooks.stop = summary;
      emit({ type: 'ma_hook', hook: 'Stop', ...summary });
      return summary;
    },
    async close() {
      if (client) await client.close().catch(() => {});
    },
    summary() {
      return {
        enabled: true,
        root,
        initialized,
        contextBytes: state.contextBytes,
        promptHook: Boolean(state.promptAppendix),
        mcpTools: state.tools.map((t) => t.name),
        hooks: state.hooks,
      };
    },
  };
}
