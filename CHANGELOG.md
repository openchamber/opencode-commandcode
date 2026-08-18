# Changelog

## 0.1.0

- Initial release: Command Code OpenCode plugin
- Local OpenAI-compatible proxy → `api.commandcode.ai/alpha/generate`
- Auth via Command Code browser OAuth with OpenCode-owned credential persistence
- Live model catalog from the public Command Code API; the Command Code CLI is no longer required
- Provider-local Laguna small model and dedicated `title-gen` requests for session titles
- Default model: Laguna S 2.1 free (`poolside/laguna-s-2.1-free`)
- Tools/MCP park-resume, attachment plumbing, context compact, usage endpoints
