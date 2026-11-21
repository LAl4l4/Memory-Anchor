import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveProviderConfig } from './config.mjs';
import { startMemoryAnchor } from './memoryAnchor.mjs';
import { createProvider } from './providers/index.mjs';
import { builtinTools, ToolError } from './tools/builtin.mjs';
import { RunRecorder } from './trace.mjs';

const MAX_NUDGES = 2;

const BASE_SYSTEM_PROMPT = `You are a coding agent working in a local repository through the tools provided.

Workspace root: {{WORKSPACE}}
All tool paths are relative to the workspace root.

How to work:
- Find and read the relevant code before editing; prefer the smallest correct change.
- Change existing files with edit_file (exact string replacement); use write_file only for new files or full rewrites.
- When the project has tests or checks, run them with run_command to verify your change.
- Do not modify or delete tests unless the task asks for it, and do not touch .git.
- When the task is complete, stop calling tools and reply with a short summary of what you changed and why.`;

function buildSystemPrompt({ workspace, agentsMd, ma }) {
  const sections = [BASE_SYSTEM_PROMPT.replace('{{WORKSPACE}}', workspace)];
  if (agentsMd) sections.push(`# Project instructions (AGENTS.md)\n\n${agentsMd}`);
  if (ma?.instructions) sections.push(`# MCP server instructions: memory-anchor\n\n${ma.instructions}`);
  if (ma?.context) sections.push(`# Session context (injected by the MemoryAnchor SessionStart hook)\n\n${ma.context}`);
  return sections.join('\n\n');
}

/** Minimal JSON-schema check: required keys and top-level primitive types. Catches truncated tool calls. */
function validateInput(schema, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'Tool input must be a JSON object.';
  for (const key of schema?.required ?? []) {
    if (!(key in input)) return `Missing required parameter "${key}".`;
  }
  for (const [key, value] of Object.entries(input)) {
    const expected = schema?.properties?.[key]?.type;
    if (!expected || value === undefined || value === null) continue;
    const actual = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    const ok = expected === actual || (expected === 'number' && actual === 'integer');
    if (!ok) return `Parameter "${key}" must be ${expected}, got ${actual}.`;
  }
  return null;
}

function clip(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n[... ${text.length - maxChars} characters omitted ...]\n${text.slice(-tail)}`;
}

function preview(value, max = 200) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Run one task to completion.
 * @returns {Promise<object>} result with status, final text, usage and the retrieval/edit trace.
 *   status ∈ completed | max_turns | refused | truncated | error
 */
export async function runAgent({ config, workspace, task, traceFile, onEvent }) {
  const root = path.resolve(workspace);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Workspace is not a directory: ${root}`);
  if (!task?.trim()) throw new Error('Task prompt is empty.');

  const providerSettings = resolveProviderConfig(config);
  const provider = createProvider(providerSettings);
  const recorder = new RunRecorder({ traceFile, onEvent });
  const emit = (event) => recorder.emit(event);

  let ma = null;
  let status = 'error';
  let finalText = '';
  let errorMessage;

  try {
    if (config.memoryAnchor.enabled) ma = await startMemoryAnchor({ settings: config.memoryAnchor, workspace: root, emit });

    const tools = [...builtinTools(config), ...(ma?.tools ?? [])];
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const agentsMdPath = path.join(root, 'AGENTS.md');
    const agentsMd = config.agent.loadAgentsMd && existsSync(agentsMdPath) ? readFileSync(agentsMdPath, 'utf8').trim() : '';
    const system = buildSystemPrompt({ workspace: root, agentsMd, ma });
    const userText = ma?.promptAppendix ? `${task.trim()}\n\n${ma.promptAppendix}` : task.trim();

    emit({
      type: 'run_start',
      provider: provider.name,
      model: provider.model,
      workspace: root,
      memoryAnchor: Boolean(ma),
      tools: tools.map((t) => t.name),
      systemChars: system.length,
      task: task.trim(),
    });

    const session = provider.createSession({ system, tools });
    const callModel = async (fn) => {
      const started = Date.now();
      const turn = await fn();
      recorder.recordTurn(turn);
      emit({
        type: 'model_turn',
        turn: recorder.turns,
        ms: Date.now() - started,
        stopReason: turn.stopReason,
        rawStopReason: turn.rawStopReason,
        text: turn.text,
        toolCalls: turn.toolCalls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
        usage: turn.usage,
        ...(turn.stopDetails ? { stopDetails: turn.stopDetails } : {}),
      });
      return turn;
    };

    let turn = await callModel(() => session.start(userText));
    let nudges = 0;

    while (true) {
      if (turn.text) finalText = turn.text;

      if (turn.stopReason === 'refusal') {
        status = 'refused';
        break;
      }

      if (turn.toolCalls.length === 0) {
        const cutOff = turn.stopReason === 'max_tokens' || turn.stopReason === 'pause';
        if (cutOff && nudges < MAX_NUDGES && recorder.turns < config.agent.maxTurns) {
          nudges += 1;
          turn = await callModel(() => session.nudge('Your previous response was cut off. Continue from where you stopped.'));
          continue;
        }
        status = cutOff ? 'truncated' : 'completed';
        break;
      }

      if (recorder.turns >= config.agent.maxTurns) {
        status = 'max_turns';
        break;
      }

      // Run tool calls in order: edits and commands may depend on each other.
      const results = [];
      for (const call of turn.toolCalls) {
        const started = Date.now();
        const tool = toolMap.get(call.name);
        let output;
        let isError = false;
        let meta = {};
        try {
          if (call.parseError) throw new ToolError(call.parseError);
          if (!tool) throw new ToolError(`Unknown tool "${call.name}". Available: ${[...toolMap.keys()].join(', ')}`);
          const invalid = validateInput(tool.inputSchema, call.input);
          if (invalid) throw new ToolError(invalid);
          const res = await tool.run(call.input, { workspace: root, config });
          output = res.output;
          isError = Boolean(res.isError);
          meta = res.meta ?? {};
        } catch (error) {
          isError = true;
          output = error instanceof ToolError ? `Error: ${error.message}` : `Error: tool crashed: ${error.message}`;
        }
        const content = clip(String(output ?? ''), config.agent.maxToolOutputChars);
        recorder.recordTool(call.name, isError, meta);
        emit({
          type: 'tool_result',
          turn: recorder.turns,
          step: recorder.toolCalls,
          id: call.id,
          name: call.name,
          input: call.input,
          isError,
          ms: Date.now() - started,
          outputChars: String(output ?? '').length,
          preview: preview(content),
          meta,
        });
        results.push({ id: call.id, content, isError });
      }

      turn = await callModel(() => session.continue(results));
    }
  } catch (error) {
    status = 'error';
    errorMessage = error.message;
    emit({ type: 'error', message: error.message, stack: error.stack });
  } finally {
    if (ma) {
      await ma.stop().catch((error) => emit({ type: 'error', message: `Stop hook failed: ${error.message}` }));
      await ma.close();
    }
  }

  const result = {
    status,
    ...(errorMessage ? { error: errorMessage } : {}),
    finalText,
    provider: provider.name,
    model: provider.model,
    workspace: root,
    memoryAnchor: ma ? ma.summary() : { enabled: false },
    ...recorder.summary(),
  };
  emit({ type: 'run_end', status, durationMs: result.durationMs, turns: result.turns, usage: result.usage });
  return result;
}
