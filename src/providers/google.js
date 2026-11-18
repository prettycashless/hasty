import { fetchWithRetry, sseEvents, parseJsonEvent, normalizeUsage } from './http.js';
import { ProviderError } from './errors.js';

const GEMINI_SCHEMA_TYPES = new Set([
  'STRING',
  'NUMBER',
  'INTEGER',
  'BOOLEAN',
  'ARRAY',
  'OBJECT',
  'NULL',
]);

/** Gemini uses a JSON-Schema subset with upper-case types. */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return undefined;
  const out = {};
  let type = schema.type;
  if (Array.isArray(type)) {
    type = type.find((entry) => String(entry).toLowerCase() !== 'null');
    if (schema.type.includes('null')) out.nullable = true;
  }
  if (type) {
    const upper = String(type).toUpperCase();
    out.type = GEMINI_SCHEMA_TYPES.has(upper) ? upper : 'STRING';
  }
  if (schema.description) out.description = schema.description;
  if (schema.format && ['int32', 'int64', 'float', 'double', 'byte', 'date-time', 'enum'].includes(schema.format)) {
    out.format = schema.format;
  }
  if (Array.isArray(schema.enum)) out.enum = schema.enum.map(String);
  if (schema.nullable) out.nullable = true;
  if (schema.minimum != null) out.minimum = schema.minimum;
  if (schema.maximum != null) out.maximum = schema.maximum;
  if (schema.minItems != null) out.minItems = schema.minItems;
  if (schema.maxItems != null) out.maxItems = schema.maxItems;
  if (Array.isArray(schema.required) && schema.required.length) out.required = [...schema.required];
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = toGeminiSchema(value);
    }
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}

export function toGeminiContents(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === 'user') {
      appendGemini(contents, 'user', { text: message.content || '(empty)' });
    } else if (message.role === 'assistant') {
      if (message.content) appendGemini(contents, 'model', { text: message.content });
      for (const call of message.toolCalls || []) {
        appendGemini(contents, 'model', {
          functionCall: {
            name: call.name,
            args: typeof call.arguments === 'object' && call.arguments !== null ? call.arguments : {},
          },
        });
      }
    } else if (message.role === 'tool') {
      const content = String(message.content ?? '');
      appendGemini(contents, 'user', {
        functionResponse: {
          name: message.name,
          response: message.isError ? { error: content } : { result: content },
        },
      });
    }
  }
  return contents;
}

function appendGemini(contents, role, part) {
  const last = contents[contents.length - 1];
  if (last && last.role === role) {
    last.parts.push(part);
  } else {
    contents.push({ role, parts: [part] });
  }
}

export function toGeminiTools(tools) {
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toGeminiSchema(tool.parameters || { type: 'object', properties: {} }),
    })),
  }];
}

export function createGoogleProvider(runtime) {
  const providerName = runtime.label || 'Google Gemini';

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
        `${providerName} is missing an API key. Run \`hasty setup\` or set GEMINI_API_KEY.`,
        { provider: providerName, status: 401 },
      );
    }
    if (!model) {
      throw new ProviderError(`${providerName} has no model configured. Run \`hasty setup\`.`, {
        provider: providerName,
      });
    }
    const modelId = String(model).replace(/^models\//, '');
    if (!/^[A-Za-z0-9._/-]+$/.test(modelId)) {
      throw new ProviderError(`Invalid Gemini model name: ${model}`, { provider: providerName });
    }

    const body = {
      contents: toGeminiContents(messages),
      generationConfig: {
        temperature: Math.min(2, Math.max(0, Number(temperature ?? 0.2))),
        maxOutputTokens: maxTokens || 8192,
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length) body.tools = toGeminiTools(tools);

    const url = `${runtime.baseUrl}/models/${modelId}:streamGenerateContent?alt=sse`;
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': runtime.apiKey,
          'user-agent': 'hasty-cli',
        },
        body: JSON.stringify(body),
      },
      { retries: 2, provider: providerName, signal },
    );

    let text = '';
    let finishReason = 'stop';
    let usage = null;
    const toolCalls = [];
    let blocked = null;

    for await (const event of sseEvents(response, signal)) {
      if (event.done) break;
      const json = parseJsonEvent(event, providerName);
      if (json.error) {
        throw new ProviderError(
          json.error.message || `${providerName} stream error`,
          { status: json.error.code || 0, body: event.data, provider: providerName },
        );
      }
      if (json.promptFeedback?.blockReason) {
        blocked = json.promptFeedback.blockReason;
      }
      if (json.usageMetadata) {
        usage = normalizeUsage(json.usageMetadata, {
          input: 'promptTokenCount',
          output: 'candidatesTokenCount',
        });
      }
      const candidate = json.candidates?.[0];
      if (!candidate) continue;
      for (const part of candidate.content?.parts || []) {
        if (part.text && !part.thought) {
          text += part.text;
          onText?.(part.text);
        }
        if (part.functionCall?.name) {
          toolCalls.push({
            id: `call_${toolCalls.length}`,
            name: part.functionCall.name,
            arguments: part.functionCall.args && typeof part.functionCall.args === 'object'
              ? part.functionCall.args
              : {},
            rawArguments: JSON.stringify(part.functionCall.args || {}),
            parseError: null,
          });
        }
      }
      if (candidate.finishReason) finishReason = candidate.finishReason;
    }

    if (blocked && !text && toolCalls.length === 0) {
      throw new ProviderError(`${providerName} blocked the request: ${blocked}`, {
        provider: providerName,
        code: 'blocked',
      });
    }

    return {
      text,
      reasoning: '',
      toolCalls,
      usage,
      finishReason: toolCalls.length
        ? 'tool_calls'
        : (finishReason === 'MAX_TOKENS' ? 'length' : 'stop'),
      model,
      provider: runtime.name,
    };
  }

  async function listModels() {
    const response = await fetchWithRetry(
      `${runtime.baseUrl}/models?pageSize=100`,
      {
        headers: {
          'x-goog-api-key': runtime.apiKey,
          'user-agent': 'hasty-cli',
        },
      },
      { retries: 1, provider: providerName },
    );
    const json = await response.json();
    return (json.models || [])
      .filter((entry) => !entry.supportedGenerationMethods
        || entry.supportedGenerationMethods.includes('generateContent'))
      .map((entry) => String(entry.name || '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort();
  }

  return { chat, listModels, runtime, type: 'google' };
}
