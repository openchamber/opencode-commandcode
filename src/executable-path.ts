/**
 * Resolve the `cmd` / `command-code` CLI binary.
 */
import { spawnSync } from "node:child_process";

export function findBinaryOnPath(
  name: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | null {
  const pathEnv = typeof env.PATH === "string" ? env.PATH : "";
  const parts = pathEnv.split(process.platform === "win32" ? ";" : ":");
  const exts =
    process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of parts) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir.replace(/[/\\]$/, "")}/${name}${ext}`;
      try {
        const result = spawnSync(candidate, ["--version"], {
          encoding: "utf8",
          timeout: 4000,
          env: env as NodeJS.ProcessEnv,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.error) continue;
        if (result.status === 0 || (result.stdout || "").trim()) {
          return candidate;
        }
      } catch {
        // try next
      }
    }
  }

  try {
    const result = spawnSync(name, ["--version"], {
      encoding: "utf8",
      timeout: 4000,
      env: env as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!result.error && (result.status === 0 || (result.stdout || "").trim())) {
      return name;
    }
  } catch {
    // missing
  }
  return null;
}

export function resolveCommandCodeExecutable(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): string | null {
  const env = options?.env ?? process.env;
  return (
    findBinaryOnPath("command-code", env) ||
    findBinaryOnPath("cmd", env) ||
    findBinaryOnPath("cmdc", env) ||
    findBinaryOnPath("commandcode", env)
  );
}

export function assertWorkingDirectory(cwd: unknown): string {
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : process.cwd();
}
