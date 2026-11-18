import { ProviderError, parseRetryAfter, sleep } from './errors.js';

const MAX_ERROR_BODY = 6000;

/**
 * Fetch with retry/backoff. Retries only failures that happen before a
 * streaming body is consumed (network errors, 408, 409, 429, 5xx).
 */
export async function fetchWithRetry(url, options = {}, {
  retries = 2,
  provider = 'provider',
  onRetry = null,
  signal = null,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      throw error;
    }

    let failure;
    let retryAfter = null;
    try {
      const response = await fetch(url, { ...options, signal });
      if (response.ok) return response;
      const text = await safeText(response);
      const retryable = [408, 409, 425, 429, 500, 502, 503, 504].includes(response.status);
      failure = new ProviderError(
        `${provider} request failed with HTTP ${response.status} ${response.statusText}`.trim(),
        {
          status: response.status,
          code: retryable ? 'retryable_http' : 'http_error',
          body: text,
          retryable,
          provider,
        },
      );
      retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      failure = error;
    }

    const isProviderError = failure instanceof ProviderError;
    const retryable = isProviderError ? failure.retryable : true;
    if (!retryable || attempt >= retries) {
      if (isProviderError) throw failure;
      const wrapped = new ProviderError(
        `Network error contacting ${provider}: ${failure.message}`,
        {
          code: 'network',
          retryable: true,
          provider,
          body: failure.cause?.message || '',
        },
      );
      wrapped.cause = failure;
      throw wrapped;
    }

    const delay = retryAfter ?? Math.min(8000, 700 * 2 ** attempt) + Math.random() * 250;
    onRetry?.({ attempt: attempt + 1, delay, status: failure.status || 0 });
    await sleep(delay, signal);
  }
}

async function safeText(response) {
  try {
    const text = await response.text();
    return text.slice(0, MAX_ERROR_BODY);
  } catch {
    return '';
  }
}

/**
 * Async iterator over Server-Sent Events.
 * Yields `{ event, data }`; emits a final `{ done: true }` for `[DONE]`.
 */
export async function* sseEvents(response, signal = null) {
  if (!response.body) {
    throw new ProviderError('The provider returned an empty streaming response.', {
      code: 'empty_stream',
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let separator;
      while ((separator = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const parsed = parseSseBlock(block);
        if (parsed) yield parsed;
      }
    }
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (buffer.trim()) {
      const parsed = parseSseBlock(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already closed.
    }
  }
}

function parseSseBlock(block) {
  const dataLines = [];
  let eventName = 'message';
  let sawField = false;
  for (const rawLine of block.split('\n')) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      dataLines.push(value);
      sawField = true;
    } else if (field === 'event') {
      eventName = value;
      sawField = true;
    }
  }
  if (!sawField) return null;
  const data = dataLines.join('\n');
  if (data === '[DONE]') return { done: true, event: eventName, data };
  return { done: false, event: eventName, data };
}

export function parseJsonEvent(event, provider) {
  try {
    return JSON.parse(event.data);
  } catch {
    throw new ProviderError(`${provider} sent a malformed streaming event.`, {
      code: 'bad_stream',
      provider,
      body: event.data.slice(0, 2000),
    });
  }
}

export function normalizeUsage(usage, mapping = {}) {
  if (!usage) return null;
  const input = Number(usage[mapping.input || 'input_tokens'] ?? usage.prompt_tokens ?? 0);
  const output = Number(usage[mapping.output || 'output_tokens'] ?? usage.completion_tokens ?? 0);
  const total = Number(usage.total_tokens ?? input + output);
  if (!input && !output && !total) return null;
  return { input, output, total };
}
