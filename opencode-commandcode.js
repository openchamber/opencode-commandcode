// Entry point: re-exports the compiled plugin from dist/
// OpenCode's file/package loader resolves this more reliably than dist/index.js directly.
export { CommandCodePlugin, default } from "./dist/index.js";
