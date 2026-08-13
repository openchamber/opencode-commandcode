/**
 * Auth helpers: sync Command Code CLI credentials + browser Go-plan login.
 *
 * Browser flow matches `cmd login`:
 *   https://commandcode.ai/studio/auth/cli?callback=http://localhost:PORT/callback&state=STATE
 * Studio POSTs { apiKey, userId, userName, keyName, state } to the local callback when
 * reachable. If the POST fails, Studio shows the key to copy — paste it into OpenCode
 * (`method: "code"`), same as the CLI's "Paste your API key..." field.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  readCommandCodeCredentials,
  type CommandCodeCredentials,
} from "./credentials.js";
import {
  COMMAND_CODE_AUTH_FILE,
  COMMAND_CODE_DIR_NAME,
  PROVIDER_ID,
  WHOAMI_ROUTE,
} from "./constants.js";
import { getApiBaseUrl, log } from "./log.js";

export type CommandCodeAuthTokens = {
  access: string;
  refresh: string;
  expires: number;
  key?: string;
  userId?: string;
  userName?: string;
  keyName?: string;
};

export type PendingCommandLogin = {
  url: string;
  state: string;
  port: number;
  startedAt: number;
  completed: boolean;
  error?: string;
};

export type BrowserCallbackPayload = {
  apiKey: string;
  userId: string;
  userName: string;
  keyName: string;
  state: string;
};

const AUTH_START_PORT = 5959;
const AUTH_MAX_PORT_ATTEMPTS = 10;
const AUTH_TIMEOUT_MS = 12 * 60 * 1000;
const STUDIO_BASE = "https://commandcode.ai";
const ALLOWED_CORS = [
  "http://localhost:3000",
  "https://staging.commandcode.ai",
  "https://commandcode.ai",
  "https://www.commandcode.ai",
];

let pending: PendingCommandLogin | null = null;
let authServer: Server | null = null;
let waitForCallback: Promise<BrowserCallbackPayload> | null = null;
let rejectCallback: ((err: Error) => void) | null = null;
let receivedPayload: BrowserCallbackPayload | null = null;

function authJsonPath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
}

function commandCodeAuthPath(homeDir = homedir()): string {
  return join(homeDir, COMMAND_CODE_DIR_NAME, COMMAND_CODE_AUTH_FILE);
}

function readAuthFile(): Record<string, unknown> {
  const path = authJsonPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeAuthFile(data: Record<string, unknown>): void {
  const path = authJsonPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function writeCommandCodeAuth(
  tokens: CommandCodeAuthTokens & { key?: string },
): void {
  const existing = readAuthFile();
  const key = tokens.key || tokens.access;
  existing[PROVIDER_ID] = {
    type: "oauth",
    key,
    access: key,
    refresh: tokens.refresh,
    expires: tokens.expires,
    ...(tokens.userId ? { accountId: tokens.userId } : {}),
  };
  writeAuthFile(existing);

  // Keep CLI auth.json in sync so `cmd -p` / status also see the session.
  try {
    const cliPath = commandCodeAuthPath();
    mkdirSync(dirname(cliPath), { recursive: true });
    let cliExisting: Record<string, unknown> = {};
    if (existsSync(cliPath)) {
      try {
        cliExisting = JSON.parse(readFileSync(cliPath, "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        cliExisting = {};
      }
    }
    writeFileSync(
      cliPath,
      JSON.stringify(
        {
          ...cliExisting,
          apiKey: key,
          userId: tokens.userId || cliExisting.userId || "",
          userName: tokens.userName || cliExisting.userName || "",
          keyName: tokens.keyName || cliExisting.keyName || "opencode-oauth",
          authenticatedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  } catch (err) {
    log.warn(
      "[opencode-commandcode] failed to mirror credentials into ~/.commandcode/auth.json",
      err instanceof Error ? err.message : err,
    );
  }
}

export function credentialsToTokens(
  creds: CommandCodeCredentials,
): CommandCodeAuthTokens {
  return {
    access: creds.apiKey,
    refresh: `cli-sync-${creds.source}`,
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    key: creds.apiKey,
    userId: creds.userId || undefined,
    userName: creds.userName || undefined,
    keyName: creds.keyName || undefined,
  };
}

/**
 * Sync Command Code CLI credentials (from `cmd login` Go-plan browser auth)
 * into OpenCode auth.json. No separate Studio API key required.
 */
export function syncCommandCodeCredentialsToOpenCode(): CommandCodeAuthTokens | null {
  const creds = readCommandCodeCredentials();
  if (!creds?.apiKey) return null;
  const tokens = credentialsToTokens(creds);
  writeCommandCodeAuth(tokens);
  log.info(
    "[opencode-commandcode] synced Command Code Go-plan credentials into OpenCode auth",
  );
  return tokens;
}

export async function validateCommandApiKey(
  apiKey: string,
  options?: { baseUrl?: string; fetchFn?: typeof fetch },
): Promise<{ valid: boolean; userName?: string; error?: string }> {
  const fetchFn = options?.fetchFn ?? fetch;
  const baseUrl = (options?.baseUrl ?? getApiBaseUrl()).replace(/\/$/, "");
  try {
    const res = await fetchFn(`${baseUrl}${WHOAMI_ROUTE}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (res.status === 401) {
      return { valid: false, error: "invalid_key" };
    }
    if (!res.ok) {
      return { valid: false, error: `server_error_${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as {
      user?: { userName?: string; name?: string };
      success?: boolean;
    } | null;
    const userName =
      body?.user?.userName || body?.user?.name || undefined;
    return { valid: true, userName };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "network_error",
    };
  }
}

export function getPendingCommandLogin(): PendingCommandLogin | null {
  return pending;
}

export function resetPendingCommandLogin(): void {
  stopAuthServer();
  pending = null;
  waitForCallback = null;
  rejectCallback = null;
  receivedPayload = null;
}

function payloadToTokens(payload: BrowserCallbackPayload): CommandCodeAuthTokens {
  return {
    access: payload.apiKey,
    key: payload.apiKey,
    refresh: "browser-oauth",
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    userId: payload.userId,
    userName: payload.userName,
    keyName: payload.keyName,
  };
}

function sanitizeApiKeyInput(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function stopAuthServer(): void {
  if (authServer) {
    try {
      authServer.close();
    } catch {
      // ignore
    }
    authServer = null;
  }
}

export function buildCommandAuthUrl(port: number, state: string): string {
  const callback = `http://localhost:${port}/callback`;
  return `${STUDIO_BASE}/studio/auth/cli?callback=${encodeURIComponent(callback)}&state=${encodeURIComponent(state)}`;
}

function isCallbackPayload(body: unknown): body is BrowserCallbackPayload {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.apiKey === "string" &&
    typeof b.state === "string" &&
    typeof b.userId === "string" &&
    typeof b.userName === "string" &&
    typeof b.keyName === "string"
  );
}

async function listenOnPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function findAvailablePort(
  start = AUTH_START_PORT,
  attempts = AUTH_MAX_PORT_ATTEMPTS,
): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = start + i;
    try {
      const server = await listenOnPort(port);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      return port;
    } catch {
      // try next
    }
  }
  throw new Error(
    `No available auth callback port after ${attempts} attempts from ${start}`,
  );
}

/**
 * Start Command Code Studio CLI browser login (same as `cmd login`).
 * Works with the $1 Go plan — Studio returns a session credential via POST.
 */
export async function startCommandBrowserLogin(): Promise<PendingCommandLogin> {
  resetPendingCommandLogin();

  const port = await findAvailablePort();
  const state = randomBytes(32).toString("base64url");
  const url = buildCommandAuthUrl(port, state);

  let resolveCb!: (payload: BrowserCallbackPayload) => void;
  let rejectCb!: (err: Error) => void;
  waitForCallback = new Promise<BrowserCallbackPayload>((resolve, reject) => {
    resolveCb = resolve;
    rejectCb = reject;
  });
  rejectCallback = rejectCb;

  const server = await listenOnPort(port);
  authServer = server;

  server.on("request", (req, res) => {
    const origin = req.headers.origin;
    const allow =
      typeof origin === "string" && ALLOWED_CORS.includes(origin)
        ? origin
        : origin && origin.endsWith("commandcode.ai")
          ? origin
          : ALLOWED_CORS[2]; // https://commandcode.ai
    res.setHeader("Access-Control-Allow-Origin", allow);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Chrome Private Network Access: public site → localhost callback.
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url !== "/callback") {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: "Not found" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end(
        JSON.stringify({
          success: false,
          error: "Method not allowed. Use POST.",
        }),
      );
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
          const message =
            typeof parsed.error_description === "string"
              ? parsed.error_description
              : typeof parsed.error === "string"
                ? parsed.error
                : "Authorization denied";
          rejectCb(new Error(message));
          stopAuthServer();
          return;
        }
        if (!isCallbackPayload(parsed)) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              success: false,
              error: "Missing required fields",
            }),
          );
          return;
        }
        if (parsed.state !== state) {
          res.writeHead(403);
          res.end(
            JSON.stringify({ success: false, error: "Invalid state token" }),
          );
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        receivedPayload = parsed;
        if (pending) pending.completed = true;
        resolveCb(parsed);
        stopAuthServer();
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
      }
    });
  });

  pending = {
    url,
    state,
    port,
    startedAt: Date.now(),
    completed: false,
  };
  log.info("[opencode-commandcode] Command Code Go-plan OAuth URL ready", {
    port,
  });
  return pending;
}

export async function completeCommandBrowserLogin(): Promise<CommandCodeAuthTokens> {
  if (!pending || !waitForCallback) {
    throw new Error("No Command Code login in progress — start auth first.");
  }

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("Browser authentication timed out")),
      AUTH_TIMEOUT_MS,
    );
  });

  try {
    const payload = await Promise.race([waitForCallback, timeout]);
    receivedPayload = payload;
    const tokens = payloadToTokens(payload);
    writeCommandCodeAuth(tokens);
    if (pending) pending.completed = true;
    return tokens;
  } catch (err) {
    if (pending) {
      pending.error = err instanceof Error ? err.message : String(err);
    }
    resetPendingCommandLogin();
    throw err;
  }
}

/**
 * Finish login the way `cmd login` does after Studio confirms:
 * prefer a key already POSTed to the local callback; otherwise accept the
 * API key the user pasted from Studio's fallback / copy page.
 */
export async function completeCommandLoginWithCode(
  code: string,
): Promise<CommandCodeAuthTokens> {
  if (receivedPayload?.apiKey) {
    const tokens = payloadToTokens(receivedPayload);
    writeCommandCodeAuth(tokens);
    if (pending) pending.completed = true;
    stopAuthServer();
    waitForCallback = null;
    rejectCallback = null;
    return tokens;
  }

  // Tiny grace period: Studio may still be POSTing while the user pastes "ok".
  if (waitForCallback) {
    const raced = await Promise.race([
      waitForCallback.then((payload) => ({ ok: true as const, payload })),
      new Promise<{ ok: false }>((resolve) =>
        setTimeout(() => resolve({ ok: false }), 750),
      ),
    ]);
    if (raced.ok) {
      receivedPayload = raced.payload;
      const tokens = payloadToTokens(raced.payload);
      writeCommandCodeAuth(tokens);
      if (pending) pending.completed = true;
      stopAuthServer();
      waitForCallback = null;
      rejectCallback = null;
      return tokens;
    }
  }

  const key = sanitizeApiKeyInput(code);
  // OpenCode "code" flow: if the browser already succeeded, user may paste "ok".
  if (!key || /^(ok|done|success|yes)$/i.test(key)) {
    if (receivedPayload?.apiKey) {
      const tokens = payloadToTokens(receivedPayload);
      writeCommandCodeAuth(tokens);
      resetPendingCommandLogin();
      return tokens;
    }
    if (!key) {
      throw new Error(
        "Paste the API key from Command Code Studio (shown after Authorize).",
      );
    }
    throw new Error(
      "No session received yet. Paste the API key shown on the Studio page.",
    );
  }

  const check = await validateCommandApiKey(key);
  if (!check.valid) {
    throw new Error(
      check.error === "invalid_key"
        ? "Invalid API key — copy the key from Studio and try again."
        : `Could not validate API key (${check.error ?? "unknown"}).`,
    );
  }

  const tokens: CommandCodeAuthTokens = {
    access: key,
    key,
    refresh: "browser-oauth-paste",
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    userName: check.userName,
    keyName: "opencode-oauth",
  };
  writeCommandCodeAuth(tokens);
  if (pending) pending.completed = true;
  resetPendingCommandLogin();
  return tokens;
}
