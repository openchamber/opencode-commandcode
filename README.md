# opencode-commandcode

[![GitHub stars](https://img.shields.io/github/stars/openchamber/opencode-commandcode?style=flat&labelColor=100F0F&color=66800B)](https://github.com/openchamber/opencode-commandcode/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/openchamber/opencode-commandcode?style=flat&labelColor=100F0F&color=205EA6)](https://github.com/openchamber/opencode-commandcode/releases/latest)
[![npm](https://img.shields.io/npm/v/%40openchamber%2Fopencode-commandcode?style=flat&labelColor=100F0F&color=24837B)](https://www.npmjs.com/package/@openchamber/opencode-commandcode)
[![Discord](https://img.shields.io/badge/Discord-join.svg?style=flat&labelColor=100F0F&color=8B7EC8&logo=discord&logoColor=FFFCF0)](https://discord.gg/ZYRSdnwwKA)
[![License](https://img.shields.io/badge/license-MIT-black?style=flat&labelColor=100F0F&color=EC8B49)](LICENSE)

## Command Code models in OpenCode. Gateway proxy. Browser login.

**opencode-commandcode is the OpenCode plugin for running [Command Code](https://commandcode.ai) models — including Laguna S 2.1 — with tools/MCP, attachments, compact, and usage. No Command Code CLI installation is required.**

Use Command Code from OpenCode and [OpenChamber](https://github.com/openchamber/openchamber) via browser login and a local OpenAI-compatible proxy that `POST`s to `/alpha/generate`. Sibling plugins: [@openchamber/opencode-cursor](https://github.com/openchamber/opencode-cursor) and [@openchamber/opencode-claude](https://github.com/openchamber/opencode-claude).

![opencode-commandcode — Command Code in OpenCode, Laguna S 2.1 gateway](docs/header.svg)

## What you can do

### Sign in with your Command Code account

`opencode auth login --provider command-code` opens Command Code Studio in your browser. After you authorize, Studio returns the credential to the plugin's temporary localhost callback and OpenCode stores it through its standard provider auth flow.

### Talk to the real Command Code gateway

The plugin proxies OpenCode chat to `POST https://api.commandcode.ai/alpha/generate` (`mode=agent`).

### Use Laguna S 2.1 and the live catalog

Default live-test target is **Laguna S 2.1 free** (`poolside/laguna-s-2.1-free`, 256k context, $0). The catalog comes from the public Command Code models API, not a local CLI or hardcoded product list. Aliases like `laguna` still resolve to the upstream id.

### Keep agent loops, files, and context moving

OpenCode tool calls park and resume. MCP tools configured natively in OpenCode (`mcp:` in `opencode.json`) are mapped both ways — OpenCode's `<server>_<tool>` ↔ the gateway's `mcp__<server>__<tool>` — so the agent sees them and OpenCode executes them with its own MCP clients. Attachments (images, PDFs, text/binary) pass through. Auto-compact tips and tiered client compact run before the 256k window overflows. Per-turn and session usage come from SSE `usage` plus `GET /v1/usage`.

Session titles use Laguna as the provider-local small model and the gateway's constrained `title-gen` mode. This selection applies only when OpenCode requests a small model for the `command-code` provider; it never changes the global `small_model` or another provider's utility model.

## Quick start

`command-code` is **not** a built-in OpenCode provider. Install the plugin first, or `opencode auth login --provider command-code` fails with `Unknown provider "command-code"`.

### 1. Install the plugin

```bash
npm install -g @openchamber/opencode-commandcode
```

Or with the OpenCode CLI:

```bash
# global (recommended)
opencode plugin @openchamber/opencode-commandcode -g

# or project-local (writes .opencode/opencode.json)
opencode plugin @openchamber/opencode-commandcode
```

### 2. Register it in OpenCode

Add (or merge) this into `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@openchamber/opencode-commandcode"],
  "provider": {
    "command-code": { "name": "Command Code" }
  }
}
```

### 3. Sign in with Command Code

```bash
opencode auth login --provider command-code
# open the URL and Authorize; the callback completes automatically
```

### 4. Run a Command Code model

```bash
opencode run "Summarise this repository in five bullets." --model command-code/laguna-s-2.1-free
```

In the TUI, pick provider **command-code**, then a model from the live catalog. Laguna S 2.1 free is the default when available. It needs an active Go (or higher) account with credits on file; requests on that model still bill **$0**.

### From source (optional)

```bash
git clone https://github.com/openchamber/opencode-commandcode.git
cd opencode-commandcode
bun install && bun run build
npm install -g .
# or: opencode plugin file://$PWD
```

## Authenticate

| Step | What happens |
| --- | --- |
| `opencode auth login --provider command-code` | Starts browser login |
| You Authorize in the browser | Studio posts the credential to the temporary localhost callback |
| Callback succeeds | OpenCode stores the provider credential in its auth store |
| Session expires | Re-run the OpenCode provider login |

**Command Code browser login is the supported path.** You do not need a separate Studio product API key.

## Architecture

```text
OpenCode
  └─ /v1/chat/completions
       └─ Bun.serve proxy (dynamic port, prefer 8797)
            └─ POST https://api.commandcode.ai/alpha/generate
                 └─ poolside/laguna-s-2.1-free (default)
```

| Layer | Responsibility |
| --- | --- |
| **Plugin hooks** | Command Code OAuth, provider config, live catalog |
| **Proxy** | OpenAI ↔ Command Code gateway, tools/MCP, attachments, compact, usage |
| **Transport** | `POST /alpha/generate` to `api.commandcode.ai` |

Model catalog: live from `GET https://api.commandcode.ai/provider/v1/models`, cached for request-time lookups with a minimal Laguna fallback when the endpoint is unavailable. Each upstream model appears once in OpenCode; request aliases still resolve to the gateway id.

## Requirements

- [OpenCode](https://opencode.ai)
- A Command Code account
- Bun (plugin runtime) · Node.js ≥ 18

## Development

```bash
bun install
bun run build
bun run test          # mocked gateway — attachments, tools, compact, usage
COMMAND_CODE_API_KEY=... bun run test:live  # optional live Laguna test
```

Debug logging: `OPENCODE_COMMANDCODE_DEBUG=1`.

Optional knobs:

- `OPENCODE_COMMANDCODE_PROXY_PORT` — pin a fixed local proxy port (otherwise dynamic: prefer `8797`, then scan upward / ephemeral)
- `OPENCODE_COMMANDCODE_CWD` — working directory reported to the gateway
- `COMMANDCODE_API_URL` / `OPENCODE_COMMANDCODE_API_URL` — override API base (default `https://api.commandcode.ai`)

Local pin refresh after a release:

```bash
./scripts/update-plugin.sh
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Unknown provider `command-code` | Install `@openchamber/opencode-commandcode` and restart OpenCode |
| Command Code missing from provider list | Confirm `plugin` includes `@openchamber/opencode-commandcode` and restart |
| Need a Studio API key? | No — use the OpenCode browser login |
| Only Laguna models? | No — the plugin loads the full live catalog from the public models API |
| Laguna S 2.1 free rejected | Needs an active Go (or higher) account with credits on file |

## Contributing

Issues and pull requests belong in this repository: [openchamber/opencode-commandcode](https://github.com/openchamber/opencode-commandcode).

```bash
bun install
bun run build
bun run test
```

## Acknowledgments

This plugin started as community work around Command Code access in OpenCode. Special thanks to:

- [OpenCode](https://opencode.ai) for the plugin API
- [OpenChamber](https://github.com/openchamber/openchamber) for the workspace that runs this plugin in production
- [Command Code](https://commandcode.ai) for the gateway and browser login
- Contributors who shaped OAuth, the live catalog, and the `/alpha/generate` proxy

Related plugins: [@openchamber/opencode-cursor](https://github.com/openchamber/opencode-cursor), [@openchamber/opencode-claude](https://github.com/openchamber/opencode-claude).

## License

[MIT](LICENSE)
