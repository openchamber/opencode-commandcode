/** Command Code OpenCode provider id. */
export const PROVIDER_ID = "command-code";

/** Default model alias shown in OpenCode (resolves to Laguna S 2.1 free). */
export const DEFAULT_MODEL_ID = "laguna-s-2.1-free";

/** Canonical Laguna S 2.1 free model id on Command Code. */
export const LAGUNA_MODEL_ID = "poolside/laguna-s-2.1-free";

export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

export const EFFORT_HEADER = "x-opencode-commandcode-effort";
export const SESSION_HEADER = "x-opencode-commandcode-session";

export const COMMAND_CODE_API_KEY_ENV = "COMMAND_CODE_API_KEY";
export const COMMAND_CODE_DIR_NAME = ".commandcode";
export const COMMAND_CODE_AUTH_FILE = "auth.json";

export const DEFAULT_API_BASE_URL = "https://api.commandcode.ai";
export const GENERATE_ROUTE = "/alpha/generate";
export const WHOAMI_ROUTE = "/alpha/whoami";
export const USAGE_SUMMARY_ROUTE = "/alpha/usage/summary";

export const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CommandEffort = (typeof EFFORT_LEVELS)[number];

export function isCommandEffort(value: unknown): value is CommandEffort {
  return (
    typeof value === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

/** Compact tiers as fractions of the model context window. */
export const COMPACT_TIERS = {
  tip: 0.5,
  warn: 0.8,
  auto: 0.9,
} as const;
