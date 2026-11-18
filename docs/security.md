# Security

Hasty is a local agent with real access to your files, shell, network, and connected accounts. It is designed to be approval-first, but it is **not a sandbox**. This page explains what is enforced, what is only guided by prompts, and where you need to make trust decisions.

## Threat model in one paragraph

You run Hasty as your user. The model can request tool calls. Hasty enforces approval rules, blocks a small set of catastrophic commands outright, refuses to read known credential stores through its file tools, and keeps API keys out of model-visible config. Everything else — shell commands, plugin code, MCP servers, web content, repository content — is only as safe as the trust you extend to it. A malicious repository, web page, plugin, or MCP server can try to manipulate the model. Approvals are your last line of defense.

## Approval modes

| Mode | Intended use | Behavior |
| --- | --- | --- |
| `ask` (default) | Normal work | Read-only tools run; writes, shell, network, plugin, and MCP actions ask |
| `auto` | Trusted repo, faster loop | Writes inside the workspace and non-dangerous shell commands run; outside writes, dangerous shell, network, plugins, and MCP still ask |
| `yolo` | Disposable environments only | Almost everything runs automatically; catastrophic commands are still blocked |

Set the mode with:

```bash
hasty --mode ask
hasty --mode auto
hasty --yes              # yolo for this run
```

or in the REPL:

```text
/approvals ask
/approvals auto
/approvals yolo
```

### What `auto` does not approve

`auto` is not "yes to everything". It still asks for:

- Writes outside the working directory
- Shell commands flagged as dangerous
- Network tools (`web_fetch`, `web_search`) and GitHub mutations
- Plugin tool calls and `create_plugin`
- MCP tool calls

### What `yolo` still blocks

These are rejected before an approval prompt is even considered:

- Recursive deletion of `/`, `~`, `$HOME`, or an entire drive
- Filesystem formatting (`mkfs`, `wipefs`, `format`, `clear-disk`, `format-volume`, `diskpart clean`)
- Raw writes to disk devices (`dd of=/dev/sdX`, redirection to a block device)
- OS shutdown/reboot/halt/poweroff
- Boot configuration changes (`bcdedit`)
- Deleting filesystem snapshots (`vssadmin delete shadows`)
- Fork bombs
- Killing init/PID 1
- Wiping free space (`cipher /w:`)
- Similar patterns on Windows and POSIX shells

The blocklist is a safety net, not a proof. Novel destructive commands can still get through. That is why yolo is for disposable environments.

### Dangerous commands get a louder prompt

In `ask` and `auto`, commands such as these are highlighted before approval:

- `rm -rf`
- `git reset --hard`
- `git clean -fd`
- `git push --force`
- `sudo`
- `chmod -R 777`
- Piping a download into a shell (`curl ... | bash`)
- `npm publish` / `pnpm publish` / `yarn npm publish`
- Global package installs
- Registry deletion (`reg delete`)
- Force-killing processes (`taskkill /f`)
- Recursive Windows deletion (`del /s`, `rd /s`)
- `DROP DATABASE` / `DROP TABLE` / `TRUNCATE TABLE`

A human still has to approve them unless the mode is `yolo`.

## Non-interactive runs fail closed

In `-p`, piped-stdin, and `--json` modes there may be no terminal to ask a question. If an action requires approval, Hasty denies it and returns an error to the model instead of silently proceeding.

For automation, be explicit:

```bash
hasty --mode auto -p "..."     # workspace writes + ordinary shell only
hasty --mode yolo -p "..."     # only in a disposable environment
hasty --yes -p "..."
```

Read-only work usually needs no widening. `auto` still denies network, plugin, MCP, and outside-workspace actions in a non-interactive run, so those tasks need `yolo`/`--yes` or an interactive session.

## Protected paths

Hasty's file tools refuse to read, write, edit, or delete known credential locations and its own configuration. Attachments (`@file`) apply the same protection.

Protected paths include:

- `~/.hasty/config.json` (and the active `HASTY_HOME` config)
- `~/.ssh`
- `~/.gnupg`
- `~/.aws/credentials` and `~/.aws/config`
- `~/.netrc`
- `~/.config/gh/hosts.yml`
- `~/.docker/config.json`
- `~/.kube/config`
- Windows Credential Manager directories
- gcloud configuration directories

The refusal is enforced in the tool layer. A model cannot talk its way past it with `read_file`, `write_file`, `edit_file`, `delete_file`, or `@file`.

### Important limit: this is not a shell sandbox

The shell tool is intentionally a real shell. If you approve a command, it runs with your full user privileges. A command such as `cat ~/.ssh/id_rsa` is not blocked by the protected-path list; the approval prompt is the gate. In yolo mode, shell commands run without prompts (except the catastrophic blocklist).

Do not run yolo in a directory or machine where you would not let an autonomous process read your files and use your credentials.

## Secrets

### Provider keys

Keys are stored in `~/.hasty/config.json` when you enter them in setup. Hasty writes config and session files atomically and requests owner-only permissions (`0600` files, `0700` directories) on POSIX systems. Windows permissions follow the ACL of your user profile.

Keys can also come from the environment, which avoids writing them to disk:

```bash
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
```

Key precedence is documented in [providers.md](providers.md). `HASTY_API_KEY` overrides everything, which is useful for CI.

### What the model sees

- The system prompt gets the provider label and model name, not the key.
- `hasty config show` and `hasty config get` redact values whose key names look like keys, tokens, secrets, or passwords.
- Plugin tools receive `ctx.config` with keys redacted.
- Tool output is sent back to the model. If you ask Hasty to print a secret, or a command prints one, it can end up in the conversation and in the session file.
- Session JSON files contain the full transcript. Treat `~/.hasty/sessions` as sensitive.
- Hasty masks key input in the terminal, but terminal scrollback and shell history are outside its control.

Do not paste long-lived secrets into a prompt. Prefer environment variables and short-lived tokens.

### GitHub tokens

Hasty resolves GitHub auth in this order:

1. `GITHUB_TOKEN`
2. `GH_TOKEN`
3. Token saved in config
4. `gh auth token`, if the GitHub CLI is installed and logged in

Use the narrowest token that works:

- Classic: `repo`, `read:org`, and `workflow` for Actions
- Fine-grained: contents, issues, pull requests, actions, scoped to the repos you need

GitHub write tools ask for approval in `ask` and `auto`; they only run unattended in `yolo`. The model can read repository contents through the API once a token is connected; only connect repositories you are willing to expose to the model provider's context.

### Search keys

Optional Brave or Tavily keys live under `search` in config, with environment overrides:

```bash
export BRAVE_SEARCH_API_KEY=...
export TAVILY_API_KEY=...
```

Without a key, Hasty falls back to DuckDuckGo HTML search. Queries are sent to the selected provider.

## Prompt injection and untrusted content

Hasty reads repository files, command output, web pages, issues, PRs, and MCP results. Any of these can contain text that imitates instructions. The system prompt tells the model to treat them as untrusted data and to follow only you and the project instruction files.

That guidance is not a hard security boundary. Practical defenses:

- Keep approval mode at `ask` when browsing untrusted content or reviewing third-party code.
- Read approval prompts, especially for shell commands and plugin creation.
- Do not approve a plugin or command that was suggested by a web page or issue text without checking it yourself.
- Prefer `--no-mcp` or `--no-plugins` when they are not needed.
- Use project instruction files only for guidance you authored or reviewed.

Project instruction files (`HASTY.md`, `AGENTS.md`, `CLAUDE.md`, `.hasty/instructions.md`, `~/.hasty/HASTY.md`) are treated as user-authored. A malicious repository can include one; Hasty follows it without asking for approval. `/status` lists the instruction files that were loaded. Review them in unfamiliar repos.

## Network access

`web_fetch` and `web_search` require approval by default and are grouped under one "network" approval per session when you choose "always this session".

`web_fetch`:

- Only allows `http:` and `https:`
- Follows redirects
- Limits response bodies to 2 MB
- Does not execute JavaScript
- Does not currently block private, loopback, or link-local addresses

That last point matters: an approved fetch can reach `localhost`, cloud metadata endpoints, or internal services. Approve fetch URLs deliberately, especially if the model constructed the URL from untrusted text.

## Plugins

Plugins are arbitrary local ES modules, not sandboxed. They can use `fs`, `child_process` (via Node in general), `fetch`, and any installed package. The plugin tool wrapper asks for approval before each call, and `create_plugin` shows the code before writing it, but a plugin you install is code you have chosen to run.

- Review agent-generated plugin code before approving.
- Do not install plugins from untrusted sources.
- Plugins receive redacted config, but full `process.env`.
- Delete the file and run `/plugins reload` to remove a plugin.
- `--no-plugins` disables loading and `create_plugin` for a run.

See [plugins.md](plugins.md) for the API.

## MCP servers

MCP servers are separate processes you configure. They can do anything their own permissions allow. Hasty asks before calling an MCP tool unless the server sets `autoApprove: true`. Server output is treated as untrusted content.

- Prefer locally installed servers over `npx -y` downloads when reproducibility matters.
- Keep `autoApprove` off unless you trust the server and its inputs.
- MCP servers inherit the environment plus the `env` you configure. Do not pass more secrets than necessary.
- `--no-mcp` skips all configured servers for a run.

## File changes, backups, and undo

- Writes and edits show a diff in the approval prompt when available.
- Before changing an existing file, Hasty snapshots it under `~/.hasty/backups/<session-id>/` (up to 4 MB per file).
- `/undo` restores the last file changed by a write, edit, or delete in that session.
- `/diff` shows uncommitted git changes.

Backups are a convenience, not a transaction log. They are scoped to a session and may not cover every path or every change. Use git branches or commits for anything you care about.

## Attachments

`@path` attachments:

- Refuse protected credential paths
- Skip binary files
- Truncate large files and report that they were truncated
- Cap total attached content per message

Attached content is inserted into the prompt and sent to your model provider. Do not attach files you are not willing to send to that provider.

## Approval fatigue

The most common failure mode is approving without reading. If a session produces a stream of similar prompts:

- Use "always this session" for a specific category you trust, not globally.
- Switch to `auto` only in a repo and task you trust.
- Start a new session (`/clear`) when the task changes.
- Keep yolo for containers and throwaway checkouts.

## Sandboxing

For untrusted code or high-risk tasks, run Hasty inside a container, VM, or disposable checkout with:

- Only the project directory mounted
- No host SSH keys, cloud credentials, or browser profiles
- A dedicated GitHub token with minimal scope
- Network egress restricted if the task does not need it
- Snapshots or version control you can restore

Hasty does not provide OS-level isolation. Treat it like giving a capable contractor a shell on the machine.

## Reporting security issues

If you find a vulnerability in Hasty itself, please report it privately to the maintainer rather than opening a public issue with exploit details. Include the version (`hasty --version`), platform, a minimal reproduction, and the impact you believe it has.
