# Plugins

Plugins are local JavaScript modules that add tools to Hasty. They are how Hasty gains a new connection or capability without changing the CLI itself.

There are two ways to get one:

1. **Ask Hasty to build it.** Describe the capability. Hasty writes an ES module and calls `create_plugin`. The code and target path are shown for approval before anything is written or loaded.
2. **Write it yourself.** Drop a `.mjs` (or `.js` ES module) into `~/.hasty/plugins` and run `/plugins reload`.

Plugins are trusted code. They run in the same Node process and with the same user privileges as Hasty. Installation is a trust decision.

## Where plugins live

```bash
hasty plugins path
# ~/.hasty/plugins
```

With `HASTY_HOME` set, the directory moves accordingly.

Every `.mjs` or `.js` file in that directory is imported at startup. Files are loaded in sorted order. Import failures are reported but do not stop the session.

## Module contract

A plugin default-exports an object:

```js
export default {
  name: 'weather',
  description: 'Weather lookups',
  tools: [
    {
      name: 'forecast',
      description: 'Get a forecast for a city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' }
        },
        required: ['city'],
        additionalProperties: false
      },
      async run({ city }, ctx) {
        const res = await fetch(`https://api.example.com/weather?q=${encodeURIComponent(city)}`, {
          signal: ctx.signal
        });
        if (!res.ok) throw new Error(`Weather API returned ${res.status}`);
        return await res.text();
      }
    }
  ]
};
```

The default export can also be an async function, which is useful for reading environment variables at load time:

```js
export default async ({ env }) => ({
  name: 'internal',
  description: 'Internal API helpers',
  tools: [/* ... */]
});
```

The loader also accepts a named `plugin` export, but `export default` is preferred.

### Plugin fields

| Field | Required | Notes |
| --- | --- | --- |
| `name` | recommended | Lowercased and slugified. Used as the tool namespace. Defaults to the file name. |
| `description` | optional | Shown by `hasty plugins` and `/plugins`. |
| `tools` | yes | Non-empty array of tool definitions, or an object keyed by tool name. |

### Tool fields

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Lowercase letters, digits, underscores. Namespaced automatically. |
| `description` | recommended | Sent to the model; keep it concrete. |
| `parameters` | yes | JSON Schema object for the arguments. |
| `run(args, ctx)` | yes | Async or sync function. Return a string or a result object. |

Tool names are namespaced as `<plugin>_<tool>`. A plugin named `weather` with a tool named `forecast` becomes `weather_forecast`. If a name collides with a built-in tool or another plugin, Hasty appends `_2`, `_3`, and so on. Final names are limited to 64 characters.

## The `run` context

`run(args, ctx)` receives the tool arguments and a context object with these fields:

| Field | Meaning |
| --- | --- |
| `ctx.fetch` | Global `fetch` |
| `ctx.fs` / `ctx.fsp` | `node:fs/promises` |
| `ctx.path` | `node:path` |
| `ctx.os` | `node:os` |
| `ctx.env` | `process.env` |
| `ctx.cwd` / `ctx.workspace` | Project working directory |
| `ctx.config` | Current config with API keys and tokens redacted |
| `ctx.session` | Session object (id, messages, todos, usage) |
| `ctx.signal` | `AbortSignal` cancelled by Ctrl+C |
| `ctx.approve` | `async (request) => { allowed, reason }` for extra approvals |
| `ctx.log` | Writes an informational line to the UI |

`ctx.config` is deliberately redacted. Do not expect to read provider keys or the GitHub token from it. Use `ctx.env` for secrets you intentionally expose to the plugin process, and document that requirement for the user.

`ctx.approve` takes the same shape used internally:

```js
const decision = await ctx.approve({
  category: 'network',
  tool: 'internal_deploy',
  title: 'deploy to staging',
  detail: 'POST /deploy on staging.example.com',
  danger: false,
  alwaysKey: 'internal_deploy:staging'
});
if (!decision.allowed) return { content: 'Deploy cancelled.', isError: true };
```

The plugin wrapper already asks for approval before every plugin tool call. Use `ctx.approve` again only when the tool has a distinct, higher-risk sub-action.

## Return values

Return one of:

| Return | Effect |
| --- | --- |
| `'text'` | Displayed as the tool result |
| `{ content, isError? }` | Full result; `isError: true` marks failure |
| any other object | Serialized as pretty JSON |
| `null` / `undefined` | Treated as empty output |

Keep output concise. Large outputs consume context and are truncated by the tool pipeline. If a response is huge, summarize it or return only the relevant fields.

Errors thrown from `run` are caught by the harness and shown to the model as a failed tool call, including the message. Throw with a useful message rather than returning silent emptiness.

## Using `create_plugin`

`create_plugin` is itself a tool, available while plugins are enabled. The model can call it with:

| Argument | Meaning |
| --- | --- |
| `name` | 2–48 chars, lowercase letters/digits/underscores, starts with a letter |
| `description` | What the plugin does |
| `code` | Complete ES module source |
| `overwrite` | Replace an existing same-named plugin file |

What happens:

1. Hasty validates the name, size, and presence of `export default`.
2. The approval prompt shows the code and target file.
3. The file is written to `~/.hasty/plugins/<name>.mjs`.
4. Plugins are reloaded and the new tools are registered immediately.
5. If the module fails to import or exposes invalid tools, the previous file is restored and the error is returned.

A typical request:

```text
❯ build a plugin that queries our status page at https://status.example.com/api and summarizes incidents
```

Hasty inspects the API if possible, writes the module, asks for approval, tests the new tool, and then uses it.

Guidance for good agent-built plugins:

- Prefer one focused tool over a generic "call any endpoint" tool.
- Put secrets in environment variables, not in the plugin source.
- Use `ctx.signal` on `fetch` so Ctrl+C cancels requests.
- Return compact text, not raw JSON dumps.
- Handle non-2xx responses with a clear error.

## Installing by hand

```bash
hasty plugins path
# create ~/.hasty/plugins/myplugin.mjs
```

Then reload without restarting:

```text
/plugins reload
```

Or check loading from the terminal:

```bash
hasty plugins
hasty doctor
```

## Example: Hacker News

[`examples/hackernews.mjs`](../examples/hackernews.mjs) adds two tools:

- `hackernews_top` — current top stories
- `hackernews_search` — Algolia search

Copy it into your plugin directory:

```bash
cp examples/hackernews.mjs ~/.hasty/plugins/
```

Then run `/plugins reload` and ask for the top stories.

## Testing and debugging

- `hasty plugins` lists loaded plugins, their files, and their tool names. Load errors set a non-zero exit code.
- `/plugins` in the REPL shows the same information.
- `/tools` shows the final registered names, including namespacing and collisions.
- `ctx.log(...)` writes to the session UI. Do not log secrets.
- A plugin module is re-imported with a cache-busting query string on reload, so edits take effect without restarting Hasty.
- Top-level side effects run at load time. Keep them minimal; do work inside `run`.

## Security notes

- Plugins are not sandboxed. They can read files, make network requests, spawn processes, and use any Node API.
- The approval prompt is the trust boundary. Review generated code before approving, especially if it came from a model that read untrusted web or repository content.
- Remove a plugin by deleting its file from the plugin directory and running `/plugins reload`.
- `--no-plugins` disables plugin loading and `create_plugin` for a run.
- A plugin tool can call `ctx.approve` for extra checks, but it can also bypass Hasty's filesystem tools and approval categories entirely. Only install plugins you trust.

See [security.md](security.md) for the broader threat model.
