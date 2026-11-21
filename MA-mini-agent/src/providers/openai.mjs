const STOP_REASONS = {
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  stop: 'end',
  length: 'max_tokens',
  content_filter: 'refusal',
};

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Any OpenAI-compatible /chat/completions endpoint (DeepSeek, Qwen, Kimi, OpenRouter, vLLM, Ollama…).
 * Uses fetch directly so no vendor SDK is pulled in for third-party endpoints.
 */
export function createOpenAIProvider(settings) {
  if (!settings.baseUrl) throw new Error('providers.openai.baseUrl is required.');
  const endpoint = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const maxRetries = settings.maxRetries ?? 4;

  async function post(body) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 250);
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(settings.timeoutMs ?? 300_000),
        });
      } catch (error) {
        lastError = new Error(`Request to ${endpoint} failed: ${error.message}`, { cause: error });
        continue;
      }
      const raw = await response.text();
      if (response.ok) {
        try {
          return JSON.parse(raw);
        } catch {
          throw new Error(`Non-JSON response from ${endpoint}: ${raw.slice(0, 500)}`);
        }
      }
      lastError = new Error(`HTTP ${response.status} from ${endpoint}: ${raw.slice(0, 1000)}`);
      if (!RETRYABLE_STATUS.has(response.status)) break;
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(Math.min(retryAfter, 60) * 1000);
    }
    throw lastError;
  }

  return {
    name: 'openai',
    model: settings.model,
    createSession({ system, tools }) {
      const messages = [{ role: 'system', content: system }];
      const toolDefs = tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));

      async function call() {
        const body = {
          model: settings.model,
          messages,
          tools: toolDefs,
          tool_choice: 'auto',
          max_tokens: settings.maxTokens ?? 8192,
          ...(settings.temperature !== undefined && settings.temperature !== null
            ? { temperature: settings.temperature }
            : {}),
          ...(settings.extraBody ?? {}),
        };
        const data = await post(body);
        const choice = data.choices?.[0];
        if (!choice?.message) throw new Error(`Response has no choices: ${JSON.stringify(data).slice(0, 500)}`);
        const message = choice.message;

        // Keep the assistant message as returned; reasoning_content is optional to replay.
        const stored = { role: 'assistant', content: message.content ?? '' };
        if (message.tool_calls?.length) stored.tool_calls = message.tool_calls;
        if (settings.passReasoningBack !== false && message.reasoning_content) {
          stored.reasoning_content = message.reasoning_content;
        }
        messages.push(stored);

        const toolCalls = (message.tool_calls ?? []).map((call) => {
          const rawArgs = call.function?.arguments ?? '{}';
          try {
            const input = rawArgs.trim() ? JSON.parse(rawArgs) : {};
            return { id: call.id, name: call.function?.name, input };
          } catch (error) {
            return { id: call.id, name: call.function?.name, input: {}, parseError: `Invalid JSON arguments: ${error.message}` };
          }
        });
        const usage = data.usage ?? {};
        const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
        return {
          text: typeof message.content === 'string' ? message.content : '',
          toolCalls,
          stopReason: toolCalls.length ? 'tool_use' : STOP_REASONS[choice.finish_reason] ?? 'other',
          rawStopReason: choice.finish_reason,
          servedBy: data.model ?? settings.model,
          usage: {
            input: usage.prompt_tokens ?? 0,
            output: usage.completion_tokens ?? 0,
            cacheRead,
            cacheWrite: 0,
          },
        };
      }

      return {
        async start(userText) {
          messages.push({ role: 'user', content: userText });
          return call();
        },
        async continue(results) {
          for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
          return call();
        },
        async nudge(text) {
          messages.push({ role: 'user', content: text });
          return call();
        },
        history: () => messages,
      };
    },
  };
}
