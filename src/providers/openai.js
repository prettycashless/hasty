import { fetchWithRetry, sseEvents, parseJsonEvent, normalizeUsage } from './http.js';
import { ProviderError } from './errors.js';

const USAGE_STREAM_PRESETS = new Set([
  'openai',
  'openrouter',
  'groq',
  'deepseek',
  'xai',
  'mistral',
  'together',
]);

export function toOpenAIMessages(system, messages) {
  const result = [];
  if (system) result.push({ role: 'system', content: system });
  for (const message of messages) {
    if (message.role === 'user') {
      result.push({ role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      const item = { role: 'assistant', content: message.content || null };
      if (message.toolCalls?.length) {
        item.tool_calls = message.toolCalls.map((call, index) => ({
          id: call.id || `call_${index}`,
          type: 'function',
          function: {
            name: call.name,
            arguments: typeof call.arguments === 'string'
              ? call.arguments
              : JSON.stringify(call.arguments ?? {}),
          },
        }));
        if (!item.content) item.content = null;
      }
      result.push(item);
    } else if (message.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: message.toolCallId || message.tool_call_id,
        content: String(message.content ?? ''),
      });
    }
  }
  return result;
}

export function toOpenAITools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  }));
}

function deltaText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      return '';
    }).join('');
  }
  return '';
}

function isReasoningModel(model) {
  return /^(?:o\d|gpt-5|gpt-6|codex)/i.test(String(model || ''));
}

function buildBody(runtime, { system, messages, tools, model, maxTokens, temperature, streamOptions }) {
  const useMaxCompletion = isReasoningModel(model);
  const body = {
    model,
    messages: toOpenAIMessages(system, messages),
    stream: true,
  };
  if (tools?.length) {
    body.tools = toOpenAITools(tools);
    body.tool_choice = 'auto';
  }
  if (maxTokens) {
    if (useMaxCompletion) body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
  }
  if (!useMaxCompletion && temperature != null && temperature !== '') {
    body.temperature = Number(temperature);
  }
  if (streamOptions) body.stream_options = { include_usage: true };
  return body;
}

function adjustBody(body, errorBody) {
  const text = String(errorBody || '').toLowerCase();
  const next = JSON.parse(JSON.stringify(body));
  if (text.includes('stream_options')) {
    delete next.stream_options;
    return next;
  }
  if (text.includes('max_completion_tokens') && next.max_tokens != null) {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
    return next;
  }
  if (text.includes('max_tokens') && next.max_completion_tokens != null) {
    next.max_tokens = next.max_completion_tokens;
    delete next.max_completion_tokens;
    return next;
  }
  if (text.includes('temperature') && next.temperature != null) {
    delete next.temperature;
    return next;
  }
  if (text.includes('tool_choice')) {
    delete next.tool_choice;
    return next;
  }
  return null;
}

export function createOpenAIProvider(runtime) {
  const providerName = runtime.label || runtime.name || 'OpenAI';
  const includeUsage = USAGE_STREAM_PRESETS.has(runtime.name);

  async function chat({
    system = '',
    messages = [],
    tools = [],
    model = runtime.model,
    maxTokens = runtime.maxTokens,
    temperature = runtime.temperature,
    signal,
    onText,
    onReasoning,
  }) {
    if (!runtime.baseUrl) {
      throw new ProviderError(`${providerName} has no base URL configured. Run \`hasty setup\`.`, {
        provider: providerName,
      });
    }
    if (!model) {
      throw new ProviderError(`${providerName} has no model configured. Run \`hasty setup\`.`, {
        provider: providerName,
      });
    }

    let body = buildBody(runtime, {
      system,
      messages,
      tools,
      model,
      maxTokens,
      temperature,
      streamOptions: includeUsage,
    });

    let response;
    for (let variant = 0; variant < 3; variant += 1) {
      try {
        response = await fetchWithRetry(
          `${runtime.baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: headersFor(runtime),
            body: JSON.stringify(body),
          },
          { retries: 2, provider: providerName, signal },
        );
        break;
      } catch (error) {
        if (error instanceof ProviderError && error.status === 400) {
          const adjusted = adjustBody(body, error.body);
          if (adjusted && JSON.stringify(adjusted) !== JSON.stringify(body)) {
            body = adjusted;
            continue;
          }
        }
        throw error;
      }
    }

    let text = '';
    let reasoning = '';
    let finishReason = 'stop';
    let usage = null;
    const callMap = new Map();

    for await (const event of sseEvents(response, signal)) {
      if (event.done) break;
      const json = parseJsonEvent(event, providerName);
      if (json.error) {
        throw new ProviderError(
          json.error.message || `${providerName} stream error`,
          { status: json.error.code || 0, body: event.data, provider: providerName },
        );
      }
      if (json.usage) usage = normalizeUsage(json.usage);
      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || choice.message || {};
      const chunkText = deltaText(delta.content);
      if (chunkText) {
        text += chunkText;
        onText?.(chunkText);
      }
      const chunkReasoning = delta.reasoning_content || delta.reasoning;
      if (chunkReasoning) {
        reasoning += chunkReasoning;
        onReasoning?.(chunkReasoning);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = Number.isInteger(call.index) ? call.index : 0;
          const entry = callMap.get(index) || {
            id: '',
            name: '',
            rawArguments: '',
          };
          if (call.id) entry.id = call.id;
          if (call.function?.name) entry.name += call.function.name;
          if (call.function?.arguments) entry.rawArguments += call.function.arguments;
          callMap.set(index, entry);
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const toolCalls = [...callMap.entries()]
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
          id: entry.id || `call_${index}`,
          name: entry.name,
          arguments: args,
          rawArguments: entry.rawArguments,
          parseError,
        };
      })
      .filter((call) => call.name);

    return {
      text,
      reasoning,
      toolCalls,
      usage,
      finishReason: toolCalls.length ? 'tool_calls' : (finishReason === 'length' ? 'length' : 'stop'),
      model,
      provider: runtime.name,
    };
  }

  async function listModels() {
    const response = await fetchWithRetry(
      `${runtime.baseUrl}/models`,
      { headers: headersFor(runtime) },
      { retries: 1, provider: providerName },
    );
    const json = await response.json();
    const list = Array.isArray(json) ? json : (json.data || json.models || []);
    return list
      .map((entry) => (typeof entry === 'string' ? entry : entry.id || entry.name))
      .filter(Boolean)
      .sort();
  }

  return { chat, listModels, runtime, type: 'openai' };
}

function headersFor(runtime) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'hasty-cli',
  };
  if (runtime.apiKey) headers.authorization = `Bearer ${runtime.apiKey}`;
  if (runtime.name === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/hasty-cli';
    headers['X-Title'] = 'Hasty';
  }
  return headers;
}
