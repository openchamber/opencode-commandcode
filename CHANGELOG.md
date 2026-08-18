# Changelog

## 0.7.0

- Removed the Command Code CLI runtime dependency; OpenCode now owns browser OAuth credentials
- Load the live model catalog directly from the public Command Code API
- Use Laguna as the provider-local small model with dedicated `title-gen` requests
- Preserve authoritative gateway billing cost in OpenCode session usage
- Return proper upstream errors and map tool results to their originating tool calls

## 0.1.0

- Initial release: Command Code OpenCode plugin
- Local OpenAI-compatible proxy → `api.commandcode.ai/alpha/generate`
- Default model: Laguna S 2.1 free (`poolside/laguna-s-2.1-free`)
- Tools/MCP park-resume, attachment plumbing, context compact, usage endpoints
