import Anthropic from '@anthropic-ai/sdk';

const STOP_REASONS = {
  tool_use: 'tool_use',
  end_turn: 'end',
  stop_sequence: 'end',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
  pause_turn: 'pause',
};

function describeApiError(error) {
  if (error instanceof Anthropic.AuthenticationError) return `Anthropic authentication failed: ${error.message}`;
  if (error instanceof Anthropic.RateLimitError) return `Anthropic rate limit (retries exhausted): ${error.message}`;
  if (error instanceof Anthropic.BadRequestError) return `Anthropic rejected the request: ${error.message}`;
  if (error instanceof Anthropic.APIError) return `Anthropic API error ${error.status ?? ''}: ${error.message}`;
  return null;
}

/**
 * Claude via the official SDK. The conversation keeps `response.content` verbatim so thinking
 * blocks are passed back unchanged, as the API requires.
 */
export function createAnthropicProvider(settings) {
  const client = new Anthropic({
    apiKey: settings.apiKey,
    ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
    timeout: settings.timeoutMs ?? 600_000,
    maxRetries: settings.maxRetries ?? 4,
  });
  const useFallbacks = settings.fallbacks !== null && settings.fallbacks !== undefined;

  return {
    name: 'anthropic',
    model: settings.model,
    createSession({ system, tools }) {
      const messages = [];
      const toolDefs = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));

      async function call() {
        const params = {
          model: settings.model,
          max_tokens: settings.maxTokens ?? 16000,
          system,
          messages,
          tools: toolDefs,
          ...(settings.promptCaching !== false ? { cache_control: { type: 'ephemeral' } } : {}),
          ...(settings.effort ? { output_config: { effort: settings.effort } } : {}),
          ...(settings.extraBody ?? {}),
        };
        let response;
        try {
          response = useFallbacks
            ? await client.beta.messages.create({
                ...params,
                betas: ['server-side-fallback-2026-07-01'],
                fallbacks: settings.fallbacks,
              })
            : await client.messages.create(params);
        } catch (error) {
          const described = describeApiError(error);
          throw described ? new Error(described, { cause: error }) : error;
        }

        messages.push({ role: 'assistant', content: response.content });
        const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        const toolCalls = response.content
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
        const usage = response.usage ?? {};
        return {
          text,
          toolCalls,
          stopReason: STOP_REASONS[response.stop_reason] ?? 'other',
          rawStopReason: response.stop_reason,
          stopDetails: response.stop_details ?? null,
          servedBy: response.model,
          usage: {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
          },
        };
      }

      return {
        async start(userText) {
          messages.push({ role: 'user', content: userText });
          return call();
        },
        /** All results for one assistant turn go back in a single user message. */
        async continue(results) {
          messages.push({
            role: 'user',
            content: results.map((r) => ({
              type: 'tool_result',
              tool_use_id: r.id,
              content: r.content,
              ...(r.isError ? { is_error: true } : {}),
            })),
          });
          return call();
        },
        /** Used after pause_turn / max_tokens to let the model carry on. */
        async nudge(text) {
          messages.push({ role: 'user', content: text });
          return call();
        },
        history: () => messages,
      };
    },
  };
}
