/**
 * Read Command Code CLI credentials from env or ~/.commandcode/auth.json.
 * Never log token values.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  COMMAND_CODE_API_KEY_ENV,
  COMMAND_CODE_AUTH_FILE,
  COMMAND_CODE_DIR_NAME,
} from "./constants.js";

export type CommandCodeCredentials = {
  apiKey: string;
  userId: string | null;
  userName: string | null;
  keyName: string | null;
  source: "env" | "auth-file";
  authPath?: string;
};

export type CommandAuthFile = {
  apiKey?: string;
  userId?: string;
  userName?: string;
  keyName?: string;
  authenticatedAt?: string;
};

export function listCommandAuthCandidates(
  homeDir = homedir(),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string[] {
  const candidates: string[] = [];
  const configDir =
    typeof env.COMMANDCODE_CONFIG_DIR === "string"
      ? env.COMMANDCODE_CONFIG_DIR.trim()
      : "";
  if (configDir) {
    candidates.push(join(configDir, COMMAND_CODE_AUTH_FILE));
  }
  candidates.push(
    join(homeDir, COMMAND_CODE_DIR_NAME, COMMAND_CODE_AUTH_FILE),
    join(homeDir, ".config", "commandcode", COMMAND_CODE_AUTH_FILE),
  );
  return candidates;
}

export function parseAuthFile(raw: string): CommandAuthFile | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as CommandAuthFile;
  } catch {
    return null;
  }
}

export function extractApiKeyFromAuthFile(
  parsed: CommandAuthFile | null,
): string | null {
  if (!parsed) return null;
  const key = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
  return key.length > 0 ? key : null;
}

export function readCommandCodeApiKeyFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | null {
  const value = env[COMMAND_CODE_API_KEY_ENV];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readCommandCodeCredentials(options?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): CommandCodeCredentials | null {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? homedir();

  const fromEnv = readCommandCodeApiKeyFromEnv(env);
  if (fromEnv) {
    return {
      apiKey: fromEnv,
      userId: null,
      userName: null,
      keyName: null,
      source: "env",
    };
  }

  for (const path of listCommandAuthCandidates(homeDir, env)) {
    if (!existsSync(path)) continue;
    try {
      const parsed = parseAuthFile(readFileSync(path, "utf8"));
      const apiKey = extractApiKeyFromAuthFile(parsed);
      if (!apiKey || !parsed) continue;
      return {
        apiKey,
        userId: typeof parsed.userId === "string" ? parsed.userId : null,
        userName: typeof parsed.userName === "string" ? parsed.userName : null,
        keyName: typeof parsed.keyName === "string" ? parsed.keyName : null,
        source: "auth-file",
        authPath: path,
      };
    } catch {
      // try next
    }
  }
  return null;
}

export function hasCommandCodeCredentials(options?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): boolean {
  return Boolean(readCommandCodeCredentials(options)?.apiKey);
}
