/**
 * Browser authentication for the OpenCode provider.
 *
 * Browser flow uses Command Code Studio's CLI-compatible callback:
 *   https://commandcode.ai/studio/auth/cli?callback=http://localhost:PORT/callback&state=STATE
 * Studio POSTs { apiKey, userId, userName, keyName, state } to the local callback when
 * reachable. OpenCode persists the returned credential through its standard
 * provider OAuth callback contract.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { log } from "./log.js";

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

export function getPendingCommandLogin(): PendingCommandLogin | null {
  return pending;
}

export function resetPendingCommandLogin(): void {
  stopAuthServer();
  pending = null;
  waitForCallback = null;
  rejectCallback = null;
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
 * Start Command Code Studio browser login.
 * Studio returns a session credential via POST for the authenticated account.
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
  log.info("[opencode-commandcode] Command Code OAuth URL ready", {
    port,
  });
  return pending;
}

export async function completeCommandBrowserLogin(): Promise<CommandCodeAuthTokens> {
  if (!pending || !waitForCallback) {
    throw new Error("No Command Code login in progress — start auth first.");
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error("Browser authentication timed out")),
      AUTH_TIMEOUT_MS,
    );
  });

  try {
    const payload = await Promise.race([waitForCallback, timeout]);
    const tokens = payloadToTokens(payload);
    if (pending) pending.completed = true;
    return tokens;
  } catch (err) {
    if (pending) {
      pending.error = err instanceof Error ? err.message : String(err);
    }
    resetPendingCommandLogin();
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
