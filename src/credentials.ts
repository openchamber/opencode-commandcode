/** Optional environment override for headless and CI runtimes. */
import { COMMAND_CODE_API_KEY_ENV } from "./constants.js";

export function readCommandCodeApiKeyFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | null {
  const value = env[COMMAND_CODE_API_KEY_ENV];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
