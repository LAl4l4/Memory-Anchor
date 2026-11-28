import { HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { tool as lcTool } from '@langchain/core/tools';
import { Annotation, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { resolveProviderConfig } from '../config.mjs';
import {
  buildResult,
  decideNext,
  executeToolCall,
  MAX_NUDGES,
  NUDGE_TEXT,
  preparePrompts,
  recordModelTurn,
  resolveWorkspace,
} from '../core.mjs';
import { startMemoryAnchor } from '../memoryAnchor.mjs';
import { builtinTools } from '../tools/builtin.mjs';
import { RunRecorder } from '../trace.mjs';
import { createChatModel, foldInvalidToolCalls } from './models.mjs';

/**
 * LangGraph engine. Same prompts, tools, trace and result.json as the native engine; the loop is a
 * StateGraph and model I/O goes through LangChain chat models:
 *
 *   START → agent ─┬─ tools → agent      (tool calls, run one at a time in order)
 *                  ├─ nudge → agent      (cut off by the output limit, up to MAX_NUDGES)
 *                  └─ END                (completed | truncated | refused | max_turns)
 */

const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  nudges: Annotation({ reducer: (_, next) => next, default: () => 0 }),
  route: Annotation({ reducer: (_, next) => next, default: () => 'agent' }),
  status: Annotation({ reducer: (_, next) => next, default: () => 'error' }),
  finalText: Annotation({ reducer: (prev, next) => next || prev, default: () => '' }),
  /** tool_call id → argument parse error for the latest model turn. */
  parseErrors: Annotation({ reducer: (_, next) => next, default: () => ({}) }),
});

/** Tool definitions for bindTools. Execution goes through executeToolCall, not the LangChain wrapper. */
export function toLangChainTools(tools) {
  return tools.map((t) =>
    lcTool(async () => {
      throw new Error('Tools are executed by the tools node.');
    }, { name: t.name, description: t.description, schema: t.inputSchema }),
  );
}

/**
 * One tool-using agent as a compiled graph. `budget()` returns {turns, maxTurns} for the stop decision;
 * by default it is the whole run's model-call count against agent.maxTurns. The multi-agent engine
 * passes a per-role budget and a recorder that tags events with the role.
 */
export function buildGraph({ model, toolMap, root, config, recorder, system, budget }) {
  const systemMessage = new SystemMessage(system);
  const limits = budget ?? (() => ({ turns: recorder.turns, maxTurns: config.agent.maxTurns }));

  async function agentNode(state) {
    const started = Date.now();
    const message = await model.runnable.invoke([systemMessage, ...state.messages]);
    const turn = model.toTurn(message);
    foldInvalidToolCalls(message);
    recordModelTurn(recorder, turn, started);
    const next = decideNext(turn, { ...limits(), nudges: state.nudges });
    return {
      messages: [message],
      // Calls whose arguments failed to parse are answered with that error by the tools node.
      parseErrors: Object.fromEntries(turn.toolCalls.filter((c) => c.parseError).map((c) => [c.id, c.parseError])),
      finalText: turn.text,
      route: next.action === 'stop' ? END : next.action,
      ...(next.status ? { status: next.status } : {}),
    };
  }

  // Run tool calls in order: edits and commands may depend on each other.
  async function toolsNode(state) {
    const last = state.messages.at(-1);
    const out = [];
    for (const call of last.tool_calls ?? []) {
      const parseError = state.parseErrors[call.id];
      const res = await executeToolCall(
        { id: call.id, name: call.name, input: call.args ?? {}, ...(parseError ? { parseError } : {}) },
        { toolMap, root, config, recorder },
      );
      out.push(new ToolMessage({ tool_call_id: res.id, content: res.content, status: res.isError ? 'error' : 'success' }));
    }
    return { messages: out };
  }

  function nudgeNode(state) {
    return { messages: [new HumanMessage(NUDGE_TEXT)], nudges: state.nudges + 1 };
  }

  return new StateGraph(AgentState)
    .addNode('agent', agentNode)
    .addNode('tools', toolsNode)
    .addNode('nudge', nudgeNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', (state) => state.route, { tools: 'tools', nudge: 'nudge', [END]: END })
    .addEdge('tools', 'agent')
    .addEdge('nudge', 'agent')
    .compile();
}

export async function runLangGraphAgent({ config, workspace, task, traceFile, onEvent }) {
  const root = resolveWorkspace(workspace, task);
  const chat = createChatModel(resolveProviderConfig(config));
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
      engine: 'langgraph',
      provider: chat.name,
      model: chat.model,
      workspace: root,
      memoryAnchor: Boolean(ma),
      tools: tools.map((t) => t.name),
      systemChars: system.length,
      task: task.trim(),
    });

    const model = { runnable: chat.bind(toLangChainTools(tools)), toTurn: chat.toTurn };
    const graph = buildGraph({ model, toolMap, root, config, recorder, system });
    // Each model turn is at most two supersteps (agent + tools/nudge); leave headroom so maxTurns,
    // not the recursion limit, ends the run.
    const recursionLimit = 2 * (config.agent.maxTurns + MAX_NUDGES) + 5;
    const final = await graph.invoke({ messages: [new HumanMessage(userText)] }, { recursionLimit });
    status = final.status;
    finalText = final.finalText;
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

  const result = buildResult({ status, errorMessage, finalText, engine: 'langgraph', provider: chat.name, model: chat.model, root, ma, recorder });
  emit({ type: 'run_end', status, durationMs: result.durationMs, turns: result.turns, usage: result.usage });
  return result;
}
