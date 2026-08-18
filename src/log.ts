import {
  COMMAND_CODE_API_KEY_ENV,
  DEFAULT_API_BASE_URL,
} from "./constants.js";

const DEBUG =
  process.env.OPENCODE_COMMANDCODE_DEBUG === "1" ||
  process.env.OPENCODE_COMMANDCODE_DEBUG === "true";

function stamp(): string {
  return new Date().toISOString();
}

export const log = {
  info(...args: unknown[]) {
    if (DEBUG) console.error(`[opencode-commandcode ${stamp()}]`, ...args);
  },
  warn(...args: unknown[]) {
    console.error(`[opencode-commandcode ${stamp()} WARN]`, ...args);
  },
  error(...args: unknown[]) {
    console.error(`[opencode-commandcode ${stamp()} ERROR]`, ...args);
  },
};

export function getApiBaseUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const raw =
    typeof env.COMMANDCODE_API_URL === "string"
      ? env.COMMANDCODE_API_URL.trim()
      : typeof env.OPENCODE_COMMANDCODE_API_URL === "string"
        ? env.OPENCODE_COMMANDCODE_API_URL.trim()
        : "";
  return (raw || DEFAULT_API_BASE_URL).replace(/\/$/, "");
}

export function getApiKeyEnvName(): string {
  return COMMAND_CODE_API_KEY_ENV;
}
