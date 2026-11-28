import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessage } from '@langchain/core/messages';
import { ChatOpenAICompletions } from '@langchain/openai';

/** Provider stop reasons → the Turn.stopReason values core.decideNext understands. */
const ANTHROPIC_STOP_REASONS = {
  tool_use: 'tool_use',
  end_turn: 'end',
  stop_sequence: 'end',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
  pause_turn: 'pause',
};
const OPENAI_STOP_REASONS = {
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  stop: 'end',
  length: 'max_tokens',
  content_filter: 'refusal',
};

/**
 * LangChain chat models configured from the same `providers.*` settings as src/native.
 * Each adapter exposes:
 *   bind(tools)  → runnable whose invoke(messages) resolves to an AIMessage
 *   toTurn(msg)  → the Turn shape core.mjs works with, so traces and result.json stay comparable
 */

function messageText(message) {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** Same wording as the native OpenAI provider, without LangChain's troubleshooting text. */
function parseErrorOf(invalidCall) {
  try {
    JSON.parse(invalidCall.args ?? '');
  } catch (error) {
    return `Invalid JSON arguments: ${error.message}`;
  }
  return `Invalid tool call: ${invalidCall.error ?? 'could not parse arguments'}`;
}

function toolCallsOf(message) {
  const valid = (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.name, input: c.args ?? {} }));
  const invalid = (message.invalid_tool_calls ?? []).map((c) => ({ id: c.id, name: c.name, input: {}, parseError: parseErrorOf(c) }));
  return [...valid, ...invalid];
}

/**
 * Tool calls whose arguments did not parse are kept off `tool_calls` by LangChain, so the replayed
 * assistant message would lack them while we still answer them with a ToolMessage. Fold them back in
 * with empty args so every ToolMessage has a matching call.
 */
export function foldInvalidToolCalls(message) {
  if (!message.invalid_tool_calls?.length) return message;
  message.tool_calls = [
    ...(message.tool_calls ?? []),
    ...message.invalid_tool_calls.map((c) => ({ id: c.id, name: c.name, args: {}, type: 'tool_call' })),
  ];
  message.invalid_tool_calls = [];
  return message;
}

function createAnthropicModel(settings) {
  if (settings.fallbacks !== null && settings.fallbacks !== undefined) {
    throw new Error('providers.anthropic.fallbacks is not supported by the langgraph engine; set it to null.');
  }
  const chat = new ChatAnthropic({
    model: settings.model,
    apiKey: settings.apiKey,
    ...(settings.baseUrl ? { anthropicApiUrl: settings.baseUrl } : {}),
    maxTokens: settings.maxTokens ?? 16000,
    maxRetries: settings.maxRetries ?? 4,
    clientOptions: { timeout: settings.timeoutMs ?? 600_000 },
    ...(settings.effort ? { outputConfig: { effort: settings.effort } } : {}),
    invocationKwargs: settings.extraBody ?? {},
  });
  return {
    name: 'anthropic',
    model: settings.model,
    bind: (tools) =>
      chat.bindTools(tools, settings.promptCaching !== false ? { cache_control: { type: 'ephemeral' } } : {}),
    toTurn(message) {
      const meta = message.response_metadata ?? {};
      const usage = message.usage_metadata ?? {};
      const cacheRead = usage.input_token_details?.cache_read ?? 0;
      const cacheWrite = usage.input_token_details?.cache_creation ?? 0;
      return {
        text: messageText(message),
        toolCalls: toolCallsOf(message),
        stopReason: ANTHROPIC_STOP_REASONS[meta.stop_reason] ?? 'other',
        rawStopReason: meta.stop_reason,
        stopDetails: meta.stop_details ?? null,
        servedBy: meta.model ?? settings.model,
        // LangChain folds cache tokens into input_tokens; the native engine reports them separately.
        usage: { input: Math.max(0, (usage.input_tokens ?? 0) - cacheRead - cacheWrite), output: usage.output_tokens ?? 0, cacheRead, cacheWrite },
      };
    },
  };
}

/**
 * ChatOpenAICompletions drops `reasoning_content` when it replays assistant messages. DeepSeek and
 * other thinking models need it back during tool use, so re-attach it to the outgoing request.
 */
class ReasoningChatOpenAI extends ChatOpenAICompletions {
  passReasoningBack = true;

  async _generate(messages, options, runManager) {
    this._reasoning = messages.filter((m) => AIMessage.isInstance(m)).map((m) => m.additional_kwargs?.reasoning_content);
    return super._generate(messages, options, runManager);
  }

  async completionWithRetry(request, requestOptions) {
    if (this.passReasoningBack && Array.isArray(this._reasoning) && Array.isArray(request.messages)) {
      let i = 0;
      request.messages = request.messages.map((m) => {
        if (m.role !== 'assistant') return m;
        const reasoning = this._reasoning[i++];
        return reasoning ? { ...m, reasoning_content: reasoning } : m;
      });
    }
    return super.completionWithRetry(request, requestOptions);
  }
}

function createOpenAIModel(settings) {
  if (!settings.baseUrl) throw new Error('providers.openai.baseUrl is required.');
  const chat = new ReasoningChatOpenAI({
    model: settings.model,
    apiKey: settings.apiKey,
    configuration: { baseURL: settings.baseUrl },
    maxTokens: settings.maxTokens ?? 8192,
    ...(settings.temperature !== undefined && settings.temperature !== null ? { temperature: settings.temperature } : {}),
    timeout: settings.timeoutMs ?? 300_000,
    maxRetries: settings.maxRetries ?? 4,
    modelKwargs: settings.extraBody ?? {},
  });
  chat.passReasoningBack = settings.passReasoningBack !== false;
  return {
    name: 'openai',
    model: settings.model,
    bind: (tools) => chat.bindTools(tools, { tool_choice: 'auto' }),
    toTurn(message) {
      const meta = message.response_metadata ?? {};
      const usage = message.usage_metadata ?? {};
      const toolCalls = toolCallsOf(message);
      return {
        text: messageText(message),
        toolCalls,
        stopReason: toolCalls.length ? 'tool_use' : OPENAI_STOP_REASONS[meta.finish_reason] ?? 'other',
        rawStopReason: meta.finish_reason,
        servedBy: meta.model_name ?? meta.model ?? settings.model,
        usage: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.input_token_details?.cache_read ?? 0,
          cacheWrite: 0,
        },
      };
    },
  };
}

/** Same script format as the native mock provider; answers with AIMessages so the graph runs unchanged. */
function createMockModel(settings) {
  const script = settings.script ?? [{ text: 'Mock run finished.' }];
  let step = 0;
  let callCount = 0;
  const runnable = {
    async invoke() {
      const entry = script[Math.min(step, script.length - 1)];
      step += 1;
      const toolCalls = (entry.tools ?? []).map((t) => ({ id: `mock_${(callCount += 1)}`, name: t.name, args: t.input ?? {}, type: 'tool_call' }));
      return new AIMessage({
        content: entry.text ?? '',
        tool_calls: toolCalls,
        response_metadata: { stop_reason: toolCalls.length ? 'tool_use' : 'end_turn', model: 'mock' },
        usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      });
    },
  };
  return {
    name: 'mock',
    model: 'mock',
    bind: () => runnable,
    toTurn(message) {
      const toolCalls = toolCallsOf(message);
      return {
        text: messageText(message),
        toolCalls,
        stopReason: toolCalls.length ? 'tool_use' : 'end',
        rawStopReason: message.response_metadata?.stop_reason,
        servedBy: 'mock',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    },
  };
}

const FACTORIES = { anthropic: createAnthropicModel, openai: createOpenAIModel, mock: createMockModel };

export function createChatModel(settings) {
  const factory = FACTORIES[settings.name];
  if (!factory) throw new Error(`Unknown provider "${settings.name}". Use one of: ${Object.keys(FACTORIES).join(', ')}`);
  return factory(settings);
}
