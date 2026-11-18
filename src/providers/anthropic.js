import { fetchWithRetry, sseEvents, parseJsonEvent, normalizeUsage } from './http.js';
import { ProviderError } from './errors.js';

/** Convert internal messages to Anthropic's block format. */
export function toAnthropicMessages(messages) {
  const raw = [];
  for (const message of messages) {
    if (message.role === 'user') {
      raw.push({ role: 'user', content: [{ type: 'text', text: message.content || '(empty)' }] });
    } else if (message.role === 'assistant') {
      const content = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls || []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: typeof call.arguments === 'object' && call.arguments !== null
            ? call.arguments
            : {},
        });
      }
      raw.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(empty)' }] });
    } else if (message.role === 'tool') {
      raw.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.toolCallId || message.tool_call_id,
          content: String(message.content ?? ''),
          ...(message.isError ? { is_error: true } : {}),
        }],
      });
    }
  }

  // Merge consecutive same-role turns, as required by the Messages API.
  const merged = [];
  for (const message of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      last.content.push(...message.content);
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
  }
  return merged;
}

export function toAnthropicTools(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters || { type: 'object', properties: {} },
  }));
}

export function createAnthropicProvider(runtime) {
  const providerName = runtime.label || 'Anthropic';

  async function chat({
    system = '',
    messages = [],
    tools = [],
    model = runtime.model,
    maxTokens = runtime.maxTokens,
    temperature = runtime.temperature,
    signal,
    onText,
  }) {
    if (!runtime.apiKey) {
      throw new ProviderError(
        `${providerName} is missing an API key. Run \`hasty setup\` or set ANTHROPIC_API_KEY.`,
        { provider: providerName, status: 401 },
      );
    }
    if (!model) {
      throw new ProviderError(`${providerName} has no model configured. Run \`hasty setup\`.`, {
        provider: providerName,
      });
    }

    const body = {
      model,
      max_tokens: maxTokens || 8192,
      stream: true,
      messages: toAnthropicMessages(messages),
    };
    if (system) body.system = system;
    if (tools.length) body.tools = toAnthropicTools(tools);
    if (temperature != null) {
      body.temperature = Math.min(1, Math.max(0, Number(temperature)));
    }

    const response = await fetchWithRetry(
      `${runtime.baseUrl}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': runtime.apiKey,
          'anthropic-version': '2023-06-01',
          'user-agent': 'hasty-cli',
        },
        body: JSON.stringify(body),
      },
      { retries: 2, provider: providerName, signal },
    );

    let text = '';
    let finishReason = 'stop';
    let usage = null;
    const callBlocks = new Map();
    let currentBlock = null;

    for await (const event of sseEvents(response, signal)) {
      if (event.done) break;
      const json = parseJsonEvent(event, providerName);
      if (event.event === 'error' || json.type === 'error') {
        throw new ProviderError(
          json.error?.message || `${providerName} stream error`,
          { status: json.error?.code || 0, body: event.data, provider: providerName },
        );
      }

      if (json.type === 'message_start') {
        usage = normalizeUsage(json.message?.usage, { input: 'input_tokens', output: 'output_tokens' });
      } else if (json.type === 'content_block_start') {
        currentBlock = json.index;
        const block = json.content_block;
        if (block?.type === 'tool_use') {
          callBlocks.set(json.index, {
            id: block.id,
            name: block.name,
            rawArguments: '',
          });
        }
      } else if (json.type === 'content_block_delta') {
        const delta = json.delta;
        if (delta?.type === 'text_delta') {
          text += delta.text || '';
          onText?.(delta.text || '');
        } else if (delta?.type === 'input_json_delta') {
          const entry = callBlocks.get(currentBlock);
          if (entry) entry.rawArguments += delta.partial_json || '';
        }
        // Thinking deltas are intentionally ignored in the transcript.
      } else if (json.type === 'content_block_stop') {
        currentBlock = null;
      } else if (json.type === 'message_delta') {
        if (json.delta?.stop_reason) finishReason = json.delta.stop_reason;
        if (json.usage) {
          const deltaUsage = normalizeUsage(json.usage, { input: 'input_tokens', output: 'output_tokens' });
          if (deltaUsage) {
            usage = {
              input: usage?.input || deltaUsage.input || 0,
              output: deltaUsage.output || usage?.output || 0,
              total: (usage?.input || 0) + (deltaUsage.output || 0),
            };
          }
        }
      }
    }

    const toolCalls = [...callBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, entry]) => {
        let args = {};
        let parseError = null;
        if (entry.rawArguments.trim()) {
          try {
            args = JSON.parse(entry.rawArguments);
          } catch (error) {
            parseError = error.message;
          }
        }
        return {
          id: entry.id || `toolu_${index}`,
          name: entry.name,
          arguments: args,
          rawArguments: entry.rawArguments,
          parseError,
        };
      });

    return {
      text,
      reasoning: '',
      toolCalls,
      usage,
      finishReason: toolCalls.length || finishReason === 'tool_use' ? 'tool_calls' : (finishReason === 'max_tokens' ? 'length' : 'stop'),
      model,
      provider: runtime.name,
    };
  }

  async function listModels() {
    const response = await fetchWithRetry(
      `${runtime.baseUrl}/models?limit=100`,
      {
        headers: {
          'x-api-key': runtime.apiKey,
          'anthropic-version': '2023-06-01',
          'user-agent': 'hasty-cli',
        },
      },
      { retries: 1, provider: providerName },
    );
    const json = await response.json();
    return (json.data || [])
      .map((entry) => entry.id)
      .filter(Boolean)
      .sort();
  }

  return { chat, listModels, runtime, type: 'anthropic' };
}
