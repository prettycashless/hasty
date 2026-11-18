# Hasty

> A terminal coding agent with hands. Dark red, bring your own key.

Hasty runs inside your real project and shell. It reads files, makes focused edits, runs your tests and build commands, searches the web, works with GitHub, and connects to MCP servers. When it needs a capability it doesn't have, it can write a small local plugin for it — with your approval.

- **Bring your own key.** OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, DeepSeek, xAI, Mistral, Ollama, LM Studio, or any OpenAI-compatible endpoint.
- **Actually does the work.** File tools, shell execution, git, tests, GitHub REST tools, web fetch/search.
- **Approval-first.** Three modes, clear diffs, and hard blocks on catastrophic commands even in yolo mode.
- **Extensible.** MCP servers, local JavaScript plugins, and a `create_plugin` tool Hasty can use to build a new connection on request.
- **Tiny.** Zero runtime dependencies. Plain Node ESM. Node 20.11 or newer.

## Install

From this directory:

```bash
npm install -g .
hasty --version
```

Once the package is published, the install command will be:

```bash
npm install -g hasty-cli
```

The npm package is `hasty-cli` because the plain `hasty` name is already taken. The command is still `hasty`.

Requirements:

- Node.js **20.11+**
- A model provider API key (not needed for Ollama / LM Studio)
- Git is recommended but optional

On Windows, Hasty automatically prefers **Git Bash** for shell commands, then PowerShell 7 (`pwsh`), Windows PowerShell, and finally `cmd.exe`. You can change this with `/shell` or `config.shell`.

## Quickstart

```bash
cd your-project
hasty setup
hasty
```

`hasty setup` asks for a provider, API key, model, an optional GitHub token, and an approval mode. It tests the provider connection before saving.

Then just talk to it:

```text
❯ fix the failing parser test and run the suite

❯ add a --dry-run flag to the export command, then update the README
```

### One-shot mode

```bash
hasty -p "fix the failing test in src/parser.test.js"
hasty "explain the architecture of this repo"
git diff | hasty -p "review this diff for bugs"
hasty --json -p "list every TODO marker" > events.jsonl
```

`-p/--print` writes the final assistant response to stdout. Tool activity and diagnostics go to stderr, so pipes stay clean. `--json` emits JSONL events instead.

### Environment-only setup

You can skip the wizard:

```bash
export OPENAI_API_KEY=sk-...
hasty --model gpt-4.1
```

Or for a custom gateway:

```bash
export HASTY_PROVIDER=custom
export HASTY_BASE_URL=https://gateway.example.com/v1
export HASTY_API_KEY=...
export HASTY_MODEL=my-model
hasty
```

See [docs/providers.md](docs/providers.md) for the full provider table and key precedence.

## Commands

### CLI subcommands

| Command | What it does |
| --- | --- |
| `hasty` | Start the interactive REPL |
| `hasty "prompt"` / `hasty -p "prompt"` | Run one turn and print the response |
| `hasty setup` | Provider, key, model, GitHub, and approval wizard |
| `hasty doctor` | Check Node, config, provider, shell, git, GitHub, plugins, MCP |
| `hasty models [provider]` | List models available to your key |
| `hasty config [show\|path\|get\|set]` | Inspect or change configuration |
| `hasty plugins [list\|path]` | List installed plugins |
| `hasty mcp [status\|connect]` | Show or connect MCP servers |
| `hasty github [status\|login\|logout]` | Manage the GitHub connection |
| `hasty sessions` | List saved sessions for the current directory |
| `hasty resume <id>` | Resume a session |
| `hasty help` | Usage summary |

### Flags

| Flag | Meaning |
| --- | --- |
| `-p, --print <text>` | One-shot mode; print the final response |
| `--json` | One-shot JSONL event stream |
| `-m, --model <name>` | Override the model for this run |
| `--provider <name>` | Override the provider for this run |
| `--mode <ask\|auto\|yolo>` | Approval mode for this run |
| `-y, --yes` | Same as `--mode yolo` |
| `-c, --continue` | Resume the latest session in this directory |
| `-r, --resume <id>` | Resume a specific session |
| `--cwd <dir>` | Run in another directory |
| `--temperature <n>` | Override temperature (0–2) |
| `--max-steps <n>` | Maximum model/tool steps per turn (1–200) |
| `--no-mcp` | Do not start configured MCP servers |
| `--no-plugins` | Do not load plugins |
| `-q, --quiet` | Less tool activity in print mode |
| `--no-color` | Disable ANSI color |
| `--no-banner` | Hide the startup banner |
| `-h, --help` | Show help |
| `-v, --version` | Print the version |

### In the REPL

| Input | Meaning |
| --- | --- |
| `/help` | Commands and shortcuts |
| `/setup` | Configure provider, key, model, GitHub, approvals |
| `/model [name]` | Show, list, or switch models |
| `/provider [name]` | Switch provider |
| `/approvals [ask\|auto\|yolo]` | Show or set approval mode |
| `/shell [auto\|bash\|pwsh\|powershell\|cmd]` | Show or change the shell |
| `/status` | Provider, model, cwd, usage, git, connections |
| `/usage` | Token usage and context estimate |
| `/tools` | List built-in, plugin, and MCP tools |
| `/plugins [reload\|path]` | Inspect or reload plugins |
| `/mcp [reconnect]` | Inspect or reconnect MCP servers |
| `/github [status\|login\|logout]` | Manage GitHub |
| `/undo` | Restore the file changed by the last write/edit/delete |
| `/diff` | Show uncommitted git changes |
| `/sessions` | List recent sessions |
| `/resume <number\|id>` | Resume a session |
| `/clear` | Start a fresh conversation |
| `/compact` | Summarize older history to free context |
| `/init` | Have Hasty write project instructions to `HASTY.md` |
| `/doctor` | Run diagnostics |
| `/exit` | Quit |
| `@path/to/file` | Attach a file to your message (Tab completes paths; works in one-shot prompts too) |
| `!command` | Run a shell command directly; approvals still apply |
| `/paste` | Paste multi-line text, ending with a line containing only `.` |
| `\` at end of line | Continue input on the next line |
| `Ctrl+C` | Cancel the current request, or clear the input |
| `Ctrl+D` | Exit |

## Approvals

Hasty defaults to **ask**. Every state-changing action shows what it wants to do before it runs.

| Action | `ask` | `auto` | `yolo` |
| --- | --- | --- | --- |
| Read-only tools | allowed | allowed | allowed |
| Writes inside the workspace | asks | allowed | allowed |
| Writes outside the workspace | asks | asks | allowed |
| Shell commands | asks | allowed unless flagged dangerous | allowed |
| Network actions (web fetch/search, GitHub writes) | asks | asks | allowed |
| Plugin tools / `create_plugin` | asks | asks | allowed |
| MCP tool calls | asks | asks | allowed |

Some commands are always blocked, regardless of mode: disk formatting, raw writes to block devices, recursive deletion of `/` or your home directory, OS shutdown, fork bombs, boot configuration changes, and similar destructive operations. Dangerous-but-legitimate commands such as `rm -rf`, `git reset --hard`, `git push --force`, `sudo`, and `npm publish` get a louder prompt.

Non-interactive runs fail closed: if an action would need approval and there is no terminal, it is denied. Pass `--mode auto` for automation that only needs workspace writes and ordinary shell commands. Use `--mode yolo` or `--yes` only in a disposable environment if the run also needs network, plugin, MCP, or outside-workspace actions.

Read [docs/security.md](docs/security.md) for the full model, including protected credential paths and prompt-injection guidance.

## Providers

Hasty supports these providers out of the box:

| Provider | Key environment variable | Default model |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-4.1` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |
| Google Gemini | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | `gemini-2.5-pro` |
| OpenRouter | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4.5` |
| Groq | `GROQ_API_KEY` | `openai/gpt-oss-120b` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| xAI | `XAI_API_KEY` | `grok-3` |
| Mistral | `MISTRAL_API_KEY` | `mistral-large-latest` |
| Ollama | none (local) | `qwen2.5-coder:7b` |
| LM Studio | none (local) | `local-model` |
| Custom | `HASTY_API_KEY` | none; you provide a base URL |

For a saved config, open `hasty config path`. A minimal provider section looks like this:

```json
{
  "provider": "custom",
  "model": "my-model",
  "providers": {
    "custom": {
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "...",
      "type": "openai"
    }
  }
}
```

Use `hasty models` to verify that the key and endpoint can list models. Custom gateways that do not expose `/models` can still be used; `hasty setup` offers to save anyway.

## GitHub

Hasty includes native GitHub REST tools for searching repos/code/issues, reading repo contents, listing branches and commits, working with issues and pull requests, writing small files through the API, and inspecting Actions runs. Local git operations use `run_command`.

Connect with any of these:

```bash
hasty github login
export GITHUB_TOKEN=ghp_...
gh auth token          # used automatically if gh is installed and logged in
```

Token precedence is `GITHUB_TOKEN`, then `GH_TOKEN`, then the token saved in config, then `gh auth token`. Classic tokens usually need `repo`, `read:org`, and `workflow`. Fine-grained tokens need contents, issues, pull requests, and actions as appropriate.

Try:

```text
❯ summarize the open issues on octocat/Hello-World
❯ review PR #42 and list anything that looks risky
❯ search this org for uses of the deprecated auth helper
```

GitHub tools only appear once a token is connected.

## MCP servers

Add stdio MCP servers under `mcpServers` in the config file:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work\\project"],
      "env": {},
      "cwd": null,
      "autoApprove": false
    }
  }
}
```

Then run `hasty mcp connect` or start Hasty normally. MCP tools are exposed as `mcp__<server>__<tool>`. They ask for approval per server unless `autoApprove` is true. Use `--no-mcp` to skip them for one run.

## Plugins

Plugins are local ES modules in `~/.hasty/plugins` that add tools. Hasty can create one for you:

```text
❯ build a plugin that queries our status page at https://status.example.com/api and summarizes incidents
```

That calls `create_plugin`, shows you the code, and asks for approval. If the plugin fails to load, the file is rolled back so a broken plugin cannot wedge your setup.

You can also write one yourself and run `/plugins reload`:

```js
export default {
  name: 'weather',
  description: 'Weather lookups',
  tools: [{
    name: 'forecast',
    description: 'Get a forecast for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
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
  }]
};
```

Tools are namespaced automatically (`weather_forecast`). See [docs/plugins.md](docs/plugins.md) and the runnable [examples/hackernews.mjs](examples/hackernews.mjs).

## Project instructions

Hasty reads project guidance at the start of every turn:

- `HASTY.md`
- `AGENTS.md`
- `CLAUDE.md`
- `.hasty/instructions.md`
- `~/.hasty/HASTY.md` (global)

Use `/init` to have Hasty inspect the repo and write a `HASTY.md` with the real stack, commands, conventions, and gotchas. Keep these files specific and short; they are injected into the system prompt.

## Sessions and files

Hasty keeps its state in `~/.hasty` (override with `HASTY_HOME`):

| Path | Contents |
| --- | --- |
| `config.json` | Provider, model, keys, approvals, MCP, GitHub, UI settings |
| `sessions/` | Conversation sessions, one JSON file each |
| `backups/` | File snapshots used by `/undo` |
| `plugins/` | Local plugin modules |
| `history` | REPL prompt history |

Sessions are scoped by working directory. Use `hasty -c` to continue the latest one, `hasty resume <id>`, or `/sessions` and `/resume` in the REPL.

`/undo` restores the previous contents of the last file Hasty changed. It is a convenience, not a replacement for git. Commit or stash before large agent runs.

Configuration is written atomically with restrictive permissions where the OS supports it. `hasty config show` redacts keys; it never prints them in full. Keys are stored locally in `config.json`, so treat that file as a secret.

## Security

- Read-only tools run automatically. Everything state-changing is gated by the approval mode.
- Protected paths are refused at the tool layer: `~/.hasty/config.json`, `~/.ssh`, `~/.gnupg`, cloud credential files, Docker/Kubernetes config, browser/system credential stores, and similar.
- `@file` attachments refuse the same protected paths and skip binary files.
- Catastrophic commands are blocked even under `--yes`.
- Non-interactive runs fail closed unless approvals are explicitly widened.
- Hasty treats repository content, command output, web pages, and MCP results as untrusted data. Project instruction files are the intended way to give it standing guidance.
- Plugins and MCP servers are code you chose to trust. They run with your user privileges.

No agent harness is a sandbox. Run Hasty in a container or disposable checkout when you are working with untrusted code, and keep backups.

Full details: [docs/security.md](docs/security.md).

## Development

```bash
npm test              # node --test, no dependencies
npm run test:watch
node bin/hasty.js --version
node bin/hasty.js doctor
```

The project is plain ESM with no build step and no runtime dependencies. Tests use isolated `HASTY_HOME` directories and a mock provider; they do not call real APIs.

Layout:

```text
bin/hasty.js          entry point
src/cli.js            argument parsing, REPL, one-shot modes, subcommands
src/agent.js          model/tool loop, compaction, session persistence
src/providers/        OpenAI, Anthropic, and Google adapters
src/tools/            file, shell, web, todo, GitHub, plugin, MCP tools
src/ui/               streaming markdown renderer, prompt, JSON output
src/plugins.js        plugin loader and namespacing
src/mcp.js            stdio MCP client
src/github.js         GitHub REST client and auth resolution
docs/                 provider, plugin, and security documentation
examples/             example plugins
```

## Troubleshooting

Run:

```bash
hasty doctor
hasty models
```

Common fixes:

- **`No model provider is configured`** — run `hasty setup`, set a provider key environment variable, or pass `--provider` and `--model`.
- **Command not found after install** — make sure the npm global bin directory is on `PATH`.
- **PowerShell blocks `npm.ps1`** — use `npm.cmd` on Windows.
- **Wrong shell syntax** — run `/shell` in the REPL, or `hasty config set shell auto`.
- **Context limit errors** — Hasty compacts automatically once and retries. Use `/compact` or `/clear` if a session has grown too large.
- **GitHub tools missing** — run `hasty github status`; connect a token and restart or use `/github login`.
- **Plugin not loading** — run `/plugins reload` and read the error, or `hasty plugins` from the terminal.

## License

MIT. See [LICENSE](LICENSE).
