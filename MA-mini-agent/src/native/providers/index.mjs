import { createAnthropicProvider } from './anthropic.mjs';
import { createMockProvider } from './mock.mjs';
import { createOpenAIProvider } from './openai.mjs';

const FACTORIES = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
  mock: createMockProvider,
};

/**
 * Provider contract:
 *   createSession({system, tools}) → { start(text), continue(results), nudge(text), history() }
 *   each call resolves to a Turn: { text, toolCalls[{id,name,input,parseError?}], stopReason, rawStopReason, usage }
 *   stopReason ∈ tool_use | end | max_tokens | refusal | pause | other
 */
export function createProvider(settings) {
  const factory = FACTORIES[settings.name];
  if (!factory) throw new Error(`Unknown provider "${settings.name}". Use one of: ${Object.keys(FACTORIES).join(', ')}`);
  return factory(settings);
}
