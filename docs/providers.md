# Providers

Hasty talks to model providers directly. There is no Hasty account, proxy, or hosted key. You supply the key (or run a local model) and pay the provider directly.

## Supported providers

| Name | Label | API type | Default base URL | Default model | API key environment variables |
| --- | --- | --- | --- | --- | --- |
| `openai` | OpenAI | OpenAI | `https://api.openai.com/v1` | `gpt-4.1` | `OPENAI_API_KEY` |
| `anthropic` | Anthropic | Anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-4-5` | `ANTHROPIC_API_KEY` |
| `google` | Google Gemini | Google | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.5-pro` | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` |
| `openrouter` | OpenRouter | OpenAI | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4.5` | `OPENROUTER_API_KEY` |
| `groq` | Groq | OpenAI | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` | `GROQ_API_KEY` |
| `deepseek` | DeepSeek | OpenAI | `https://api.deepseek.com/v1` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `xai` | xAI Grok | OpenAI | `https://api.x.ai/v1` | `grok-3` | `XAI_API_KEY` |
| `mistral` | Mistral | OpenAI | `https://api.mistral.ai/v1` | `mistral-large-latest` | `MISTRAL_API_KEY` |
| `ollama` | Ollama (local) | OpenAI | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | none |
| `lmstudio` | LM Studio (local) | OpenAI | `http://localhost:1234/v1` | `local-model` | none |
| `custom` | Custom endpoint | OpenAI | none | none | `HASTY_API_KEY` |

Default model names change over time. Use `hasty models` to see what your key can actually access, then switch with `/model` or `hasty config set model <name>`.

## Setup wizard

```bash
hasty setup
```

The wizard:

1. Lets you pick a provider.
2. Asks for a base URL only for `custom`.
3. Finds an existing key from the environment or saved config.
4. Masks key input while you type.
5. Lets you choose or type a model.
6. Calls the provider's model-list endpoint to verify the connection.
7. Optionally connects GitHub.
8. Sets the approval mode and saves.

A failed connection test does not have to be fatal. Some gateways do not implement `/models` but still work. The wizard offers to save anyway; verify with a real prompt afterward.

## Environment variables

| Variable | Effect |
| --- | --- |
| `HASTY_HOME` | State directory, default `~/.hasty` |
| `HASTY_PROVIDER` | Override the configured provider name |
| `HASTY_MODEL` | Override the model |
| `HASTY_API_KEY` | Override the key for whatever provider is active |
| `HASTY_BASE_URL` | Override the provider base URL |

Provider-specific variables such as `OPENAI_API_KEY` are used when there is no saved key.

### Key precedence

For the active provider, Hasty resolves the key in this order:

1. `HASTY_API_KEY`
2. The key saved under `providers.<name>.apiKey` in `~/.hasty/config.json`
3. The provider's environment variables, in the order listed in the table above
4. No key (works only for keyless local providers)

This means a saved key wins over `OPENAI_API_KEY`, but `HASTY_API_KEY` wins over everything. That is useful for CI jobs that inject one key for a chosen provider.

### Model and base URL precedence

Base URL:

1. `HASTY_BASE_URL`
2. `providers.<name>.baseUrl` in config
3. The built-in preset URL

Model:

1. `--model` (highest, applies to the run)
2. `HASTY_MODEL`
3. `model` in config (when the active provider matches)
4. `providers.<name>.defaultModel`
5. The built-in preset default

## Configuration file

`hasty config path` prints the location. The default is `~/.hasty/config.json`.

A provider-related subset:

```json
{
  "provider": "openai",
  "model": "gpt-4.1",
  "temperature": 0.2,
  "maxTokens": 8192,
  "contextWindow": 128000,
  "providers": {
    "openai": {
      "apiKey": "sk-..."
    },
    "anthropic": {
      "apiKey": "sk-ant-...",
      "defaultModel": "claude-sonnet-4-5"
    }
  }
}
```

Per-provider overrides can include:

| Key | Meaning |
| --- | --- |
| `apiKey` | Saved key for that provider |
| `baseUrl` | Alternate endpoint |
| `defaultModel` | Preferred model when switching to that provider |
| `type` | Adapter type: `openai`, `anthropic`, or `google` |

Saving a key for a provider does not switch to it. Change `provider` (or use `/provider`) as well.

### Custom / self-hosted endpoints

Anything that speaks the OpenAI Chat Completions API can be used through `custom`, or through a named override:

```bash
hasty config set provider custom
hasty config set model my-model
hasty config set providers.custom.baseUrl https://gateway.example.com/v1
hasty config set providers.custom.apiKey sk-...
```

Or with the wizard:

```bash
hasty setup
# choose "Custom endpoint", enter the base URL, key, and model
```

If the endpoint uses an Anthropic- or Gemini-shaped API instead, set `providers.<name>.type` to `anthropic` or `google` and provide the matching base URL.

You are responsible for the endpoint's compatibility: request shape, SSE streaming, tool calls, and usage reporting. Hasty expects streaming responses and tool-call support for agent work. A model that cannot call tools can still chat, but it cannot edit files or run commands reliably.

## Local models

### Ollama

```bash
ollama pull qwen2.5-coder:7b
ollama serve
hasty --provider ollama --model qwen2.5-coder:7b
```

Hasty uses Ollama's OpenAI-compatible endpoint at `http://localhost:11434/v1`. No key is required.

### LM Studio

1. Load a tool-capable model in LM Studio.
2. Start the local server (default port 1234).
3. Run:

```bash
hasty --provider lmstudio --model local-model
```

Use the exact model identifier shown by the server. `hasty models` lists what the endpoint reports.

Local models vary a lot in tool-calling quality. If a model narrates edits instead of calling `edit_file`, try a larger coding model or a hosted provider.

## Models and limits

```bash
hasty models                 # active provider
hasty models anthropic       # another provider, using its saved/env key
hasty models --json          # machine-readable
```

In the REPL:

```text
/model                       # list and pick a model
/model claude-sonnet-4-5     # switch directly
/provider                    # list and pick a provider
```

Settings that affect provider calls:

| Config key | Default | Meaning |
| --- | --- | --- |
| `model` | provider default | Active model |
| `temperature` | `0.2` | Sampling temperature, 0–2 |
| `maxTokens` | `8192` | Output cap per model response |
| `contextWindow` | `128000` | Context estimate used for compaction warnings |
| `maxSteps` | `50` | Maximum model/tool steps in one turn |
| `maxToolOutput` | `60000` | Maximum captured tool output in characters |

`contextWindow` is a local budgeting hint. It does not change the provider's real limit. Set it to the context size of the model you actually use so Hasty compacts before the provider rejects the request. When a provider reports a context-length error, Hasty compacts and retries once automatically.

## Diagnostics

```bash
hasty doctor
```

Checks:

- Node version and platform
- Config directory writability
- Provider, model, base URL, and key presence (masked)
- Shell resolution
- Git repository status
- GitHub token validity
- Plugin and MCP load status

`hasty doctor` does not send a model prompt. `hasty models` makes a lightweight API request to list models.

## Common errors

| Error | Likely cause | Fix |
| --- | --- | --- |
| `401` / `403` | Bad or expired key, missing scope | Re-run `hasty setup`, check provider console |
| `404` on chat | Wrong base URL or model name | Check `hasty models`, verify `/v1` suffix |
| `429` | Rate limit or no credit | Wait, upgrade, or switch provider |
| `model not found` | Model unavailable to your key | Pick one from `hasty models` |
| `context length exceeded` | Conversation or file payload too large | Set `contextWindow`, run `/compact`, attach less |
| Streaming hangs | Proxy buffering SSE | Use a streaming-capable endpoint or direct provider URL |
| Tool calls ignored | Model lacks tool support | Use a tool-capable model |
| `No model provider is configured` | No key/base URL/model | `hasty setup` or set env vars |

If a provider returns an unfamiliar error, `hasty doctor` and `hasty models` usually separate configuration problems from model or billing problems.
