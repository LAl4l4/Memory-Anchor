/**
 * Offline scripted provider for smoke-testing the loop, tools, and MemoryAnchor wiring
 * without spending tokens. Each script step is {tools: [{name, input}]} or {text}.
 */
export function createMockProvider(settings) {
  const script = settings.script ?? [{ text: 'Mock run finished.' }];
  return {
    name: 'mock',
    model: 'mock',
    createSession() {
      let step = 0;
      let callCount = 0;
      const history = [];
      const next = () => {
        const entry = script[Math.min(step, script.length - 1)];
        step += 1;
        const toolCalls = (entry.tools ?? []).map((t) => ({ id: `mock_${(callCount += 1)}`, name: t.name, input: t.input ?? {} }));
        const turn = {
          text: entry.text ?? '',
          toolCalls,
          stopReason: toolCalls.length ? 'tool_use' : 'end',
          rawStopReason: toolCalls.length ? 'tool_use' : 'end_turn',
          servedBy: 'mock',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        history.push({ role: 'assistant', turn });
        return turn;
      };
      return {
        async start(userText) {
          history.push({ role: 'user', content: userText });
          return next();
        },
        async continue(results) {
          history.push({ role: 'tool', results });
          return next();
        },
        async nudge(text) {
          history.push({ role: 'user', content: text });
          return next();
        },
        history: () => history,
      };
    },
  };
}
