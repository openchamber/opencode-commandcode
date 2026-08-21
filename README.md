# ⚠️ This plugin is deprecated and archived

**opencode-commandcode is no longer needed — or recommended.**

Command Code now offers an **official API** (the [Provider API](https://commandcode.ai/docs/provider)) that works natively with OpenCode. Every paid plan **except the $1 Go plan** includes API access, and connecting it takes about a minute — no plugin, no proxy, no browser-login tricks.

## Why we archived this

- **The official API replaced us.** GOAT ($10), Pro, Max, Team, and Provider plans can all call `https://api.commandcode.ai/provider/v1` directly with a standard API key. OpenCode supports OpenAI-compatible providers out of the box, so a plugin adds nothing.
- **The only audience left was Go-plan ($1) users bypassing a deliberate paywall.** Command Code intentionally excludes the Go plan from API access (their API returns `403 upgrade_required`). Using this plugin on a Go account violates the Command Code Terms of Service and **accounts have been banned** for it.
- **Legal risk.** Similar community projects (e.g. 9router) received DMCA takedowns for proxying Command Code's internal endpoints.

We don't want to put users' accounts — or this project — at risk. So the repository is archived.

## ✅ Use the official API instead

1. **Subscribe** to any plan except Go (GOAT $10/mo and up), or the pay-as-you-go Provider plan ($15/mo).
2. **Create an API key** at [Studio → API keys](https://commandcode.ai/settings/keys).
3. **Add it to OpenCode** — run `opencode auth login`, or add a custom provider to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "commandcode": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Command Code",
      "options": {
        "baseURL": "https://api.commandcode.ai/provider/v1",
        "apiKey": "{env:CMD_API_KEY}"
      },
      "models": {
        "zai-org/GLM-5.2": {},
        "deepseek/deepseek-v4-flash": {},
        "moonshotai/Kimi-K2.7-code": {}
      }
    }
  }
}
```

Then set `CMD_API_KEY` in your environment and run:

```bash
opencode run "Hello" --model commandcode/zai-org/GLM-5.2
```

The full live model catalog is at [`GET /provider/v1/models`](https://commandcode.ai/docs/provider#models). Both OpenAI (`/chat/completions`) and Anthropic (`/messages`) endpoints are available, streaming included. See the [Provider API docs](https://commandcode.ai/docs/provider) for details, and [Pricing & Limits](https://commandcode.ai/docs/resources/pricing-limits) for per-model rates.

## Historical context

This plugin provided browser OAuth and a local OpenAI-compatible proxy to Command Code's internal `POST /alpha/generate` endpoint, bringing Laguna and the live model catalog into OpenCode before an official API path existed. Its source remains available in this archived repository for reference, but **it is unmaintained and will not receive updates**.

Thanks to everyone who contributed, filed issues, and used it responsibly.

## License

[MIT](LICENSE)
