// Example Hasty plugin: Hacker News.
//
// Copy to ~/.hasty/plugins/hackernews.mjs, then run `/plugins reload`.
// This adds two tools: hackernews_top and hackernews_search.

const FIREBASE = 'https://hacker-news.firebaseio.com/v0';
const ALGOLIA = 'https://hn.algolia.com/api/v1';

export default {
  name: 'hackernews',
  description: 'Read and search Hacker News stories.',
  tools: [
    {
      name: 'top',
      description: 'List the current top stories on Hacker News with scores, comments, and links.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Number of stories to return (1-30). Default 10.'
          }
        },
        additionalProperties: false
      },
      async run({ limit = 10 }, ctx) {
        const count = clamp(limit, 1, 30);
        const ids = await getJson(`${FIREBASE}/topstories.json`, ctx.signal);
        if (!Array.isArray(ids)) throw new Error('Hacker News returned an unexpected response.');

        const items = await Promise.all(
          ids.slice(0, count).map((id) => getJson(`${FIREBASE}/item/${id}.json`, ctx.signal))
        );

        return items
          .filter(Boolean)
          .map((item, index) => formatStory(item, index + 1))
          .join('\n\n');
      }
    },
    {
      name: 'search',
      description: 'Search Hacker News stories by keyword and return titles, points, comments, and links.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms.' },
          limit: {
            type: 'integer',
            description: 'Number of results to return (1-20). Default 8.'
          }
        },
        required: ['query'],
        additionalProperties: false
      },
      async run({ query, limit = 8 }, ctx) {
        const text = String(query || '').trim();
        if (!text) return { content: 'query is required.', isError: true };
        const count = clamp(limit, 1, 20);
        const url = `${ALGOLIA}/search?tags=story&hitsPerPage=${count}&query=${encodeURIComponent(text)}`;
        const data = await getJson(url, ctx.signal);
        const hits = Array.isArray(data?.hits) ? data.hits : [];
        if (hits.length === 0) return `No Hacker News stories matched "${text}".`;

        return hits
          .map((hit, index) => formatStory({
            id: hit.objectID,
            title: hit.title,
            score: hit.points,
            descendants: hit.num_comments,
            url: hit.url
          }, index + 1))
          .join('\n\n');
      }
    }
  ]
};

async function getJson(url, signal) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal
  });
  if (!response.ok) throw new Error(`Hacker News returned HTTP ${response.status} for ${url}`);
  return response.json();
}

function formatStory(item, index) {
  const title = item.title || '(untitled)';
  const score = Number(item.score) || 0;
  const comments = Number(item.descendants) || 0;
  const discussion = `https://news.ycombinator.com/item?id=${item.id}`;
  const lines = [
    `${index}. ${title}`,
    `   ${score} points · ${comments} comments`,
    `   ${discussion}`
  ];
  if (item.url && item.url !== discussion) lines.push(`   ${item.url}`);
  return lines.join('\n');
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
