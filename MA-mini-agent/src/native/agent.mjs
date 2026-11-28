import { resolveProviderConfig } from '../config.mjs';
import {
  buildResult,
  decideNext,
  executeToolCall,
  NUDGE_TEXT,
  preparePrompts,
  recordModelTurn,
  resolveWorkspace,
} from '../core.mjs';
import { startMemoryAnchor } from '../memoryAnchor.mjs';
import { builtinTools } from '../tools/builtin.mjs';
import { RunRecorder } from '../trace.mjs';
import { createProvider } from './providers/index.mjs';

/** Hand-written engine: a plain while loop over the providers in ./providers (fetch / @anthropic-ai/sdk). */
export async function runNativeAgent({ config, workspace, task, traceFile, onEvent }) {
  const root = resolveWorkspace(workspace, task);
  const provider = createProvider(resolveProviderConfig(config));
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
    const { system, userText } = preparePrompts({ config, root, task, ma });

    emit({
      type: 'run_start',
      engine: 'native',
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
      recordModelTurn(recorder, turn, started);
      return turn;
    };

    let turn = await callModel(() => session.start(userText));
    let nudges = 0;

    while (true) {
      if (turn.text) finalText = turn.text;
      const next = decideNext(turn, { turns: recorder.turns, nudges, maxTurns: config.agent.maxTurns });
      if (next.action === 'stop') {
        status = next.status;
        break;
      }
      if (next.action === 'nudge') {
        nudges += 1;
        turn = await callModel(() => session.nudge(NUDGE_TEXT));
        continue;
      }
      // Run tool calls in order: edits and commands may depend on each other.
      const results = [];
      for (const call of turn.toolCalls) results.push(await executeToolCall(call, { toolMap, root, config, recorder }));
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

  const result = buildResult({ status, errorMessage, finalText, engine: 'native', provider: provider.name, model: provider.model, root, ma, recorder });
  emit({ type: 'run_end', status, durationMs: result.durationMs, turns: result.turns, usage: result.usage });
  return result;
}
