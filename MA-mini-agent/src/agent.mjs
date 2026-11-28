export const ENGINES = ['langgraph', 'langgraph-multi', 'native'];
export const DEFAULT_ENGINE = 'langgraph';

/**
 * Run one task to completion with the engine in `config.agent.engine`:
 *   langgraph (default) — src/langgraph: LangGraph StateGraph + LangChain chat models
 *   langgraph-multi     — src/langgraph/multi.mjs: planner → coder → reviewer subgraphs on the same stack
 *   native              — src/native: hand-written loop and providers
 * Each engine is imported only when selected, so one engine's dependencies never load for the other.
 * @returns {Promise<object>} result with status, final text, usage and the retrieval/edit trace.
 *   status ∈ completed | max_turns | refused | truncated | error
 */
export async function runAgent(options) {
  const engine = options.config.agent.engine ?? DEFAULT_ENGINE;
  if (engine === 'langgraph') {
    const { runLangGraphAgent } = await import('./langgraph/agent.mjs');
    return runLangGraphAgent(options);
  }
  if (engine === 'langgraph-multi') {
    const { runMultiAgent } = await import('./langgraph/multi.mjs');
    return runMultiAgent(options);
  }
  if (engine === 'native') {
    const { runNativeAgent } = await import('./native/agent.mjs');
    return runNativeAgent(options);
  }
  throw new Error(`Unknown engine "${engine}". Use one of: ${ENGINES.join(', ')}`);
}
