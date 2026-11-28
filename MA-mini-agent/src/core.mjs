import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ToolError } from './tools/builtin.mjs';

/**
 * Pieces both engines share so a bench comparison measures the loop, not the prompt or tools:
 * system prompt, AGENTS.md loading, input validation, tool execution and output clipping.
 */

export const MAX_NUDGES = 2;
export const NUDGE_TEXT = 'Your previous response was cut off. Continue from where you stopped.';

const BASE_SYSTEM_PROMPT = `You are a coding agent working in a local repository through the tools provided.

Workspace root: {{WORKSPACE}}
All tool paths are relative to the workspace root.

How to work:
- Find and read the relevant code before editing; prefer the smallest correct change.
- Change existing files with edit_file (exact string replacement); use write_file only for new files or full rewrites.
- When the project has tests or checks, run them with run_command to verify your change.
- Do not modify or delete tests unless the task asks for it, and do not touch .git.
- When the task is complete, stop calling tools and reply with a short summary of what you changed and why.`;

export function buildSystemPrompt({ workspace, agentsMd, ma }) {
  const sections = [BASE_SYSTEM_PROMPT.replace('{{WORKSPACE}}', workspace)];
  if (agentsMd) sections.push(`# Project instructions (AGENTS.md)\n\n${agentsMd}`);
  if (ma?.instructions) sections.push(`# MCP server instructions: memory-anchor\n\n${ma.instructions}`);
  if (ma?.context) sections.push(`# Session context (injected by the MemoryAnchor SessionStart hook)\n\n${ma.context}`);
  return sections.join('\n\n');
}

export function resolveWorkspace(workspace, task) {
  const root = path.resolve(workspace);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Workspace is not a directory: ${root}`);
  if (!task?.trim()) throw new Error('Task prompt is empty.');
  return root;
}

/** System prompt and first user message, identical for both engines. */
export function preparePrompts({ config, root, task, ma }) {
  const agentsMdPath = path.join(root, 'AGENTS.md');
  const agentsMd = config.agent.loadAgentsMd && existsSync(agentsMdPath) ? readFileSync(agentsMdPath, 'utf8').trim() : '';
  const system = buildSystemPrompt({ workspace: root, agentsMd, ma });
  const userText = ma?.promptAppendix ? `${task.trim()}\n\n${ma.promptAppendix}` : task.trim();
  return { system, userText };
}

/** Minimal JSON-schema check: required keys and top-level primitive types. Catches truncated tool calls. */
export function validateInput(schema, input) {
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

export function clip(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n[... ${text.length - maxChars} characters omitted ...]\n${text.slice(-tail)}`;
}

export function preview(value, max = 200) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Run one tool call, record it and emit `tool_result`. Never throws: failures become error results
 * the model sees. `call` is {id, name, input, parseError?}.
 */
export async function executeToolCall(call, { toolMap, root, config, recorder }) {
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
  recorder.emit({
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
  return { id: call.id, content, isError };
}

/** Record a normalized model turn and emit `model_turn`. */
export function recordModelTurn(recorder, turn, started) {
  recorder.recordTurn(turn);
  recorder.emit({
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
}

/**
 * What to do after a model turn, shared by both loops.
 * @returns {{action: 'tools'|'nudge'|'stop', status?: string}}
 */
export function decideNext(turn, { turns, nudges, maxTurns }) {
  if (turn.stopReason === 'refusal') return { action: 'stop', status: 'refused' };
  if (turn.toolCalls.length === 0) {
    const cutOff = turn.stopReason === 'max_tokens' || turn.stopReason === 'pause';
    if (cutOff && nudges < MAX_NUDGES && turns < maxTurns) return { action: 'nudge' };
    return { action: 'stop', status: cutOff ? 'truncated' : 'completed' };
  }
  if (turns >= maxTurns) return { action: 'stop', status: 'max_turns' };
  return { action: 'tools' };
}

/** Shape of result.json, shared so bench grading and reporting do not care which engine ran. */
export function buildResult({ status, errorMessage, finalText, engine, provider, model, root, ma, recorder }) {
  return {
    status,
    ...(errorMessage ? { error: errorMessage } : {}),
    finalText,
    engine,
    provider,
    model,
    workspace: root,
    memoryAnchor: ma ? ma.summary() : { enabled: false },
    ...recorder.summary(),
  };
}
