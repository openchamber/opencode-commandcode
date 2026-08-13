/**
 * Detect Command Code CLI installation + auth status.
 */
import { spawnSync } from "node:child_process";
import { hasCommandCodeCredentials } from "./credentials.js";
import { resolveCommandCodeExecutable } from "./executable-path.js";

export type CommandDetectStatus =
  | "ready"
  | "needs-login"
  | "missing-cli"
  | "error";

export type CommandDetectResult = {
  status: CommandDetectStatus;
  statusDetail?: string;
  binaryPath?: string | null;
  version?: string | null;
  loggedIn: boolean;
};

export function probeCommandAuthStatusCli(options: {
  binaryPath: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  spawnSyncFn?: typeof spawnSync;
}): { loggedIn: boolean; detail: string } | null {
  const binaryPath = options.binaryPath.trim();
  if (!binaryPath) return null;
  const spawnSyncFn = options.spawnSyncFn || spawnSync;

  try {
    const result = spawnSyncFn(binaryPath, ["status", "--json"], {
      encoding: "utf8",
      timeout: 8000,
      env: (options.env || process.env) as NodeJS.ProcessEnv,
      windowsHide: true,
    });

    const output = `${result.stdout || ""}`.trim();
    if (!output) {
      // Fall back to non-json status text.
      const text = spawnSyncFn(binaryPath, ["status"], {
        encoding: "utf8",
        timeout: 8000,
        env: (options.env || process.env) as NodeJS.ProcessEnv,
        windowsHide: true,
      });
      const combined = `${text.stdout || ""}\n${text.stderr || ""}`;
      const loggedIn = /logged in|authenticated/i.test(combined) &&
        !/not authenticated/i.test(combined);
      return {
        loggedIn,
        detail: loggedIn ? "auth-status-text" : "auth-status-logged-out",
      };
    }

    try {
      const payload = JSON.parse(output) as {
        authenticated?: boolean;
        loggedIn?: boolean;
      };
      const loggedIn = Boolean(payload.authenticated || payload.loggedIn);
      return {
        loggedIn,
        detail: loggedIn ? "auth-status-json" : "auth-status-logged-out",
      };
    } catch {
      const loggedIn =
        /authenticated|logged in/i.test(output) &&
        !/not authenticated/i.test(output);
      return {
        loggedIn,
        detail: loggedIn ? "auth-status-text" : "auth-status-parse-error",
      };
    }
  } catch {
    return null;
  }
}

export async function detectCommandCode(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
  binaryPath?: string | null;
}): Promise<CommandDetectResult> {
  const env = options?.env ?? process.env;
  const binaryPath =
    options?.binaryPath !== undefined
      ? options.binaryPath
      : resolveCommandCodeExecutable({ env });

  const credsPresent = hasCommandCodeCredentials({
    homeDir: options?.homeDir,
    env,
  });

  if (!binaryPath && !credsPresent) {
    return {
      status: "missing-cli",
      statusDetail:
        "Command Code CLI (`cmd` / `command-code`) not found on PATH. Install with `npm i -g command-code@latest`.",
      binaryPath: null,
      version: null,
      loggedIn: false,
    };
  }

  let version: string | null = null;
  if (binaryPath) {
    try {
      const result = spawnSync(binaryPath, ["--version"], {
        encoding: "utf8",
        timeout: 4000,
        env: env as NodeJS.ProcessEnv,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const match = `${result.stdout || ""}`.trim().match(/(\d+\.\d+\.\d+)/);
      version = match?.[1] ?? (`${result.stdout || ""}`.trim() || null);
    } catch {
      version = null;
    }
  }

  const authStatus = binaryPath
    ? probeCommandAuthStatusCli({ binaryPath, env })
    : null;
  const loggedIn = Boolean(authStatus?.loggedIn) || credsPresent;

  if (!loggedIn) {
    return {
      status: "needs-login",
      statusDetail:
        "Command Code is installed but not authenticated. Run `cmd login` or set COMMAND_CODE_API_KEY.",
      binaryPath,
      version,
      loggedIn: false,
    };
  }

  return {
    status: "ready",
    statusDetail: authStatus?.detail || "ready",
    binaryPath,
    version,
    loggedIn: true,
  };
}

export { resolveCommandCodeExecutable } from "./executable-path.js";
