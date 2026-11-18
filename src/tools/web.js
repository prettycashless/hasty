import { searchKeys } from '../config.js';
import { sanitizeText, truncateEnd } from '../util.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; HastyCLI/0.1; +https://github.com/hasty-cli)';
const MAX_BODY_BYTES = 2_000_000;

export function createWebTools() {
  return [
    {
      name: 'web_fetch',
      permission: 'network',
      description:
        'Fetch a web page or HTTP API and return readable text (HTML is converted, JSON is pretty-printed). '
        + 'Use for documentation and research. Network access requires approval by default.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL.' },
          max_chars: { type: 'integer', description: 'Maximum characters to return. Default 60000.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        let url;
        try {
          url = new URL(String(args.url || ''));
        } catch {
          return { content: 'Invalid URL. Include http:// or https://.', isError: true };
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
          return { content: 'Only http and https URLs are supported.', isError: true };
        }
        const decision = await ctx.approve({
          category: 'network',
          tool: 'web_fetch',
          title: `fetch · ${url.hostname}`,
          detail: url.href,
          alwaysKey: 'network',
        });
        if (!decision.allowed) {
          return { content: `Fetch denied: ${decision.reason}.`, isError: true };
        }

        let response;
        try {
          response = await fetch(url.href, {
            headers: {
              'user-agent': USER_AGENT,
              accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5',
            },
            redirect: 'follow',
            signal: combineSignals(ctx.signal, AbortSignal.timeout(30_000)),
          });
        } catch (error) {
          return { content: `Fetch failed: ${error.message}`, isError: true };
        }
        if (!response.ok) {
          return {
            content: `Fetch failed: HTTP ${response.status} ${response.statusText} for ${url.href}`,
            isError: true,
          };
        }
        const contentType = response.headers.get('content-type') || '';
        if (/application\/(?:pdf|zip|octet-stream)|image\/|audio\/|video\//i.test(contentType)) {
          return {
            content: `Unsupported content type: ${contentType}. Hasty can fetch text, HTML, and JSON.`,
            isError: true,
          };
        }

        let raw;
        try {
          raw = await readLimited(response, MAX_BODY_BYTES);
        } catch (error) {
          return { content: `Could not read response: ${error.message}`, isError: true };
        }

        const maxChars = Math.min(200_000, Math.max(1000, Number(args.max_chars) || 60_000));
        let text;
        let title = '';
        if (/html/i.test(contentType) || /^\s*<!doctype html/i.test(raw) || /^\s*<html/i.test(raw)) {
          const parsed = htmlToText(raw);
          title = parsed.title;
          text = parsed.text;
        } else if (/json/i.test(contentType) || /^\s*[[{]/.test(raw)) {
          try {
            text = JSON.stringify(JSON.parse(raw), null, 2);
          } catch {
            text = raw;
          }
        } else {
          text = raw;
        }
        text = sanitizeText(text).trim();
        const truncated = text.length > maxChars;
        const body = truncateEnd(text, maxChars, 'page content');
        return {
          content: [
            `URL: ${url.href}`,
            title ? `Title: ${title}` : '',
            truncated ? `[content truncated to ${maxChars} chars]` : '',
            '',
            body,
          ].filter((line) => line !== '').join('\n'),
          display: { summary: `${body.length.toLocaleString('en-US')} chars` },
        };
      },
    },
    {
      name: 'web_search',
      permission: 'network',
      description:
        'Search the web and return titles, URLs, and snippets. Uses Brave or Tavily when a search key is configured, '
        + 'otherwise DuckDuckGo HTML. Network access requires approval by default.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          count: { type: 'integer', description: 'Number of results (1-10). Default 5.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const query = String(args.query || '').trim();
        if (!query) return { content: 'query is required.', isError: true };
        const count = Math.min(10, Math.max(1, Number(args.count) || 5));
        const decision = await ctx.approve({
          category: 'network',
          tool: 'web_search',
          title: `search · ${query.slice(0, 50)}`,
          detail: 'The query is sent to an external search provider.',
          alwaysKey: 'network',
        });
        if (!decision.allowed) {
          return { content: `Search denied: ${decision.reason}.`, isError: true };
        }

        const keys = searchKeys(ctx.config);
        try {
          if (keys.brave) return await braveSearch(query, count, keys.brave, ctx.signal);
          if (keys.tavily) return await tavilySearch(query, count, keys.tavily, ctx.signal);
          return await duckDuckGoSearch(query, count, ctx.signal);
        } catch (error) {
          return {
            content: `Search failed: ${error.message}\n`
              + 'Tip: add a Brave or Tavily API key in config for reliable search results.',
            isError: true,
          };
        }
      },
    },
  ];
}

async function readLimited(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  while (bytes < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  try {
    await reader.cancel();
  } catch {
    // Ignore cancellation errors.
  }
  return text;
}

function combineSignals(a, b) {
  if (!a) return b;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

export function htmlToText(html) {
  const titleMatch = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : '';
  let text = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table|ul|ol|nav|main|aside|figure)>/gi, '\n')
    .replace(/<(li)\b[^>]*>/gi, '\n• ')
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u00a0/g, ' ')
    .trim();
  return { title, text };
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, '');
}

export function decodeEntities(text) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    copy: '©',
    reg: '®',
    trade: '™',
    rsquo: '’',
    lsquo: '‘',
    ldquo: '“',
    rdquo: '”',
  };
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

async function braveSearch(query, count, key, signal) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  const response = await fetch(url.href, {
    headers: {
      accept: 'application/json',
      'x-subscription-token': key,
      'user-agent': USER_AGENT,
    },
    signal: combineSignals(signal, AbortSignal.timeout(20_000)),
  });
  if (!response.ok) {
    throw new Error(`Brave Search returned HTTP ${response.status}.`);
  }
  const json = await response.json();
  const results = (json.web?.results || []).slice(0, count).map((item, index) => ({
    title: item.title || item.url,
    url: item.url,
    snippet: stripTags(item.description || ''),
    index: index + 1,
  }));
  return formatResults(query, results, 'Brave Search');
}

async function tavilySearch(query, count, key, signal) {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      query,
      max_results: count,
      search_depth: 'basic',
      include_answer: false,
    }),
    signal: combineSignals(signal, AbortSignal.timeout(25_000)),
  });
  if (!response.ok) {
    throw new Error(`Tavily returned HTTP ${response.status}.`);
  }
  const json = await response.json();
  const results = (json.results || []).slice(0, count).map((item, index) => ({
    title: item.title || item.url,
    url: item.url,
    snippet: item.content || '',
    index: index + 1,
  }));
  return formatResults(query, results, 'Tavily');
}

async function duckDuckGoSearch(query, count, signal) {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const response = await fetch(url.href, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html',
    },
    signal: combineSignals(signal, AbortSignal.timeout(25_000)),
  });
  if (!response.ok) {
    throw new Error(`DuckDuckGo returned HTTP ${response.status}. Configure a Brave or Tavily key for reliable search.`);
  }
  const html = await response.text();
  const blocks = html.split(/class="result__body"/i).slice(1);
  const results = [];
  for (const block of blocks) {
    if (results.length >= count) break;
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippetMatch = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    results.push({
      title: decodeEntities(stripTags(link[2])).trim(),
      url: decodeDuckUrl(link[1]),
      snippet: snippetMatch ? decodeEntities(stripTags(snippetMatch[1])).trim() : '',
      index: results.length + 1,
    });
  }
  if (results.length === 0) {
    throw new Error('DuckDuckGo returned no parseable results (it may be rate-limiting). Configure a Brave or Tavily key.');
  }
  return formatResults(query, results, 'DuckDuckGo');
}

function decodeDuckUrl(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    return url.searchParams.get('uddg') || href;
  } catch {
    return href;
  }
}

function formatResults(query, results, provider) {
  if (results.length === 0) {
    return {
      content: `No results for "${query}" via ${provider}.`,
      display: { summary: '0 results' },
    };
  }
  const lines = results.map((item) => `${item.index}. ${item.title}\n   ${item.url}\n   ${item.snippet}`);
  return {
    content: `Search: ${query}\nProvider: ${provider}\n\n${lines.join('\n\n')}`,
    display: { summary: `${results.length} results` },
  };
}
