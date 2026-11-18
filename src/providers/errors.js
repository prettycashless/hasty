import { sanitizeText, truncateEnd } from '../util.js';

export class ProviderError extends Error {
  constructor(message, {
    status = 0,
    code = 'provider_error',
    body = '',
    retryable = false,
    provider = '',
  } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryable = retryable;
    this.provider = provider;
  }
}

export function isAbortError(error) {
  return error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || /aborted/i.test(error?.message || '');
}

export function friendlyProviderError(error, runtime = null) {
  if (!error) return 'Unknown provider error.';
  if (isAbortError(error)) return 'Request cancelled.';
  const provider = error.provider || runtime?.label || runtime?.name || 'the provider';
  const body = sanitizeText(error.body || '');
  const detail = truncateEnd(body.trim(), 1200, 'error body');

  if (error instanceof ProviderError) {
    if (error.status === 401 || error.status === 403) {
      return [
        `${provider} rejected the API key (HTTP ${error.status}).`,
        `Check the key${runtime?.docs ? ` at ${runtime.docs}` : ''}, then run \`hasty setup\`.`,
        detail ? `\n${detail}` : '',
     ].filter(Boolean).join('\n');
    }
    if (error.status === 404) {
      return [
        `${provider} returned 404. The base URL or model may be wrong.`,
        `Current model: ${runtime?.model || 'unknown'}`,
        `Current base URL: ${runtime?.baseUrl || 'unknown'}`,
        detail ? `\n${detail}` : '',
      ].filter(Boolean).join('\n');
    }
    if (error.status === 429) {
      return [
        `${provider} rate-limited the request (HTTP 429).`,
        'Hasty already retried with backoff. Wait a moment, switch models, or check your plan limits.',
        detail ? `\n${detail}` : '',
      ].filter(Boolean).join('\n');
    }
    if (error.status >= 500) {
      return [
        `${provider} is having trouble (HTTP ${error.status}).`,
        'Hasty retried a couple of times. Try again shortly or switch providers with /provider.',
        detail ? `\n${detail}` : '',
      ].filter(Boolean).join('\n');
    }
    if (/context|too many tokens|maximum.*length|prompt is too long/i.test(`${error.message} ${body}`)) {
      return [
        `The conversation is too large for ${runtime?.model || 'this model'}.`,
        'Run /compact to summarize it, or start a fresh turn with /clear.',
        detail ? `\n${detail}` : '',
      ].filter(Boolean).join('\n');
    }
    if (error.code === 'network') {
      return [
        `Could not reach ${provider} at ${runtime?.baseUrl || 'the configured base URL'}.`,
        'Check your internet connection, proxy, base URL, and whether a local model server is running.',
        detail ? `\n${detail}` : '',
      ].filter(Boolean).join('\n');
    }
    return [
      error.message || `${provider} request failed.`,
      detail ? `\n${detail}` : '',
    ].filter(Boolean).join('\n');
  }

  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(error.message || '')) {
    return [
      `Could not reach ${provider} at ${runtime?.baseUrl || 'the configured base URL'}.`,
      'Check your connection, proxy, base URL, or local model server.',
      error.message ? `\n${sanitizeText(error.message)}` : '',
    ].filter(Boolean).join('\n');
  }

  return sanitizeText(error.message || String(error));
}

export function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(headerValue);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
