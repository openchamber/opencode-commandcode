/**
 * Command Code gateway client — POST /alpha/generate NDJSON stream.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import {
  GENERATE_ROUTE,
  emptyUsage,
  getApiBaseUrl,
  type GenerateBody,
  type StreamEvent,
  type WireMessage,
  type WireTool,
  type WireUsage,
} from "./gateway-types.js";
import { log } from "./log.js";
import { resolveCommandCodeExecutable } from "./executable-path.js";

let cachedCliVersion: string | null = null;
const MODEL_CALL_MAX_ATTEMPTS = 10;
const MODEL_CALL_BACKOFF_MIN_MS = 1_000;
const MODEL_CALL_BACKOFF_MAX_MS = 10_000;
const TERMINAL_ERROR_MARKERS = [
  "premium_credits_exhausted",
  "model_not_in_plan",
  "insufficient credits",
];

function cliVersion(): string {
  if (cachedCliVersion) return cachedCliVersion;
  const executable = resolveCommandCodeExecutable();
  if (executable) {
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 4_000,
      env: process.env,
      windowsHide: true,
    });
    const match = `${result.stdout || ""} ${result.stderr || ""}`.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/);
    if (match) return (cachedCliVersion = match[0]);
  }
  return "unknown";
}

function gitValue(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? (result.stdout || "").trim() : "";
}

export function commandRetryDelayMs(attempt: number): number {
  return Math.min(
    MODEL_CALL_BACKOFF_MAX_MS,
    Math.max(MODEL_CALL_BACKOFF_MIN_MS, 100 * 2 ** attempt),
  );
}

export function isRetryableGatewayError(input: {
  status?: number | null;
  isRetryable?: boolean;
  message?: string;
}): boolean {
  if (input.isRetryable === true) return true;
  if (typeof input.status === "number") {
    return input.status === 429 || (input.status >= 500 && input.status <= 599);
  }
  if (input.isRetryable === false) return false;
  const message = (input.message || "").toLowerCase();
  return !TERMINAL_ERROR_MARKERS.some((marker) => message.includes(marker));
}

async function retryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  const ms = commandRetryDelayMs(attempt);
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function streamErrorInfo(event: StreamEvent): {
  message: string;
  status: number | null;
  isRetryable?: boolean;
} {
  if (event.type !== "error") {
    return { message: "Command Code stream error", status: null };
  }
  const error = event.error;
  if (typeof error === "string") {
    return { message: error, status: null };
  }
  if (error && typeof error === "object") {
    const value = error as {
      message?: unknown;
      status?: unknown;
      statusCode?: unknown;
      isRetryable?: unknown;
    };
    const rawStatus = value.statusCode ?? value.status;
    return {
      message:
        typeof value.message === "string"
          ? value.message
          : "Command Code stream error",
      status: typeof rawStatus === "number" ? rawStatus : null,
      ...(typeof value.isRetryable === "boolean"
        ? { isRetryable: value.isRetryable }
        : {}),
    };
  }
  return { message: "Command Code stream error", status: null };
}

export type GatewayAuthHeaders = {
  apiKey: string;
  sessionId?: string;
  cliVersion?: string;
  projectSlug?: string;
};

export type GatewayGenerateParams = {
  apiKey: string;
  model: string;
  messages: WireMessage[];
  tools?: WireTool[];
  system?: string;
  /** OpenCode skills are already disclosed in its system prompt and skill tool. */
  skills?: unknown;
  maxTokens?: number;
  temperature?: number;
  effort?: string;
  permissionMode?: "standard" | "auto-accept" | "plan";
  threadId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** Injected for tests. */
  fetchFn?: typeof fetch;
  baseUrl?: string;
  /** Override POST body builder for mocks. */
  postStream?: (
    body: GenerateBody,
    headers: Record<string, string>,
  ) => Promise<ReadableStream<Uint8Array>>;
};

export type GatewayMappedEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool_call";
      id: string;
      name: string;
      arguments: string;
      providerExecuted?: boolean;
    }
  | { kind: "tool_result"; id: string; output: string; isError?: boolean }
  | {
      kind: "finish";
      finishReason: string;
      usage: WireUsage;
      systemPromptTokens?: number;
    }
  | { kind: "error"; text: string }
  | { kind: "ignore" };

export function buildAuthHeaders(auth: GatewayAuthHeaders): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "cli",
    Authorization: `Bearer ${auth.apiKey}`,
    "x-command-code-version": auth.cliVersion || cliVersion(),
    "x-cli-environment": "cli",
    "x-taste-learning": "false",
    "x-co-flag": "false",
  };
  if (auth.sessionId) headers["x-session-id"] = auth.sessionId;
  if (auth.projectSlug) headers["x-project-slug"] = auth.projectSlug;
  return headers;
}

export function buildGenerateBody(
  params: GatewayGenerateParams,
): GenerateBody {
  const cwd = process.env.OPENCODE_COMMANDCODE_CWD || process.cwd();
  let structure: string[] = [];
  try {
    structure = readdirSync(cwd)
      .filter((name) => !name.startsWith("."))
      .sort()
      .slice(0, 200);
  } catch {
    structure = [];
  }

  const gitRoot = gitValue(cwd, ["rev-parse", "--show-toplevel"]);
  const currentBranch = gitValue(cwd, ["branch", "--show-current"]);
  const mainBranch = gitValue(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
    .replace(/^origin\//, "");
  const gitStatus = gitValue(cwd, ["status", "--short"]);
  const recentCommits = gitValue(cwd, ["log", "-5", "--pretty=format:%h %s"])
    .split("\n")
    .filter(Boolean);

  return {
    config: {
      workingDir: cwd,
      date: new Date().toISOString().slice(0, 10),
      environment: process.platform,
      structure,
      isGitRepo: Boolean(gitRoot),
      currentBranch,
      mainBranch,
      gitStatus,
      recentCommits,
    },
    memory: null,
    taste: null,
    skills: params.skills ?? null,
    permissionMode: params.permissionMode || "auto-accept",
    ...(params.threadId ? { threadId: params.threadId } : {}),
    // Feature mode — must be a gateway feature id, not "default".
    mode: "agent",
    params: {
      model: params.model,
      messages: params.messages,
      tools: params.tools || [],
      ...(params.system ? { system: params.system } : {}),
      max_tokens: params.maxTokens ?? 32_768,
      stream: true,
      ...(typeof params.temperature === "number"
        ? { temperature: params.temperature }
        : {}),
      ...(params.effort ? { reasoning_effort: params.effort } : {}),
    },
  };
}

async function* readNdjsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) yield line;
      }
    }
    const tail = buffer.trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

export function mapStreamEvent(event: StreamEvent): GatewayMappedEvent {
  switch (event.type) {
    case "text-delta":
      return typeof event.text === "string" && event.text
        ? { kind: "text", text: event.text }
        : { kind: "ignore" };
    case "reasoning-delta":
      return typeof event.text === "string" && event.text
        ? { kind: "reasoning", text: event.text }
        : { kind: "ignore" };
    case "reasoning-start":
    case "reasoning-end":
      return { kind: "ignore" };
    case "tool-call": {
      const id =
        (typeof event.toolCallId === "string" && event.toolCallId) ||
        `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const name =
        (typeof event.toolName === "string" && event.toolName) || "unknown";
      const raw = event.input ?? event.args ?? {};
      let args: string;
      try {
        args =
          typeof raw === "string"
            ? raw
            : JSON.stringify(raw && typeof raw === "object" ? raw : { value: raw });
      } catch {
        args = "{}";
      }
      return {
        kind: "tool_call",
        id,
        name,
        arguments: args,
        providerExecuted: event.providerExecuted === true,
      };
    }
    case "tool-result": {
      const id =
        (typeof event.toolCallId === "string" && event.toolCallId) || "";
      const raw = event.output ?? event.result ?? "";
      let output: string;
      if (typeof raw === "string") output = raw;
      else if (raw && typeof raw === "object" && "value" in (raw as object)) {
        output = String((raw as { value: unknown }).value);
      } else {
        try {
          output = JSON.stringify(raw);
        } catch {
          output = String(raw);
        }
      }
      return {
        kind: "tool_result",
        id,
        output,
        isError: event.isError === true,
      };
    }
    case "finish": {
      const usage = emptyUsage();
      const total = event.totalUsage as
        | {
            inputTokens?: number;
            outputTokens?: number;
            inputTokenDetails?: {
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
            };
          }
        | undefined;
      if (total) {
        usage.inputTokens = total.inputTokens ?? 0;
        usage.outputTokens = total.outputTokens ?? 0;
        usage.cacheReadTokens =
          total.inputTokenDetails?.cacheReadTokens ?? 0;
        usage.cacheWriteTokens =
          total.inputTokenDetails?.cacheWriteTokens ?? 0;
      }
      const finishReason =
        event.finishReason === "tool-calls"
          ? "tool_calls"
          : event.finishReason === "length"
            ? "length"
            : "stop";
      return {
        kind: "finish",
        finishReason,
        usage,
        systemPromptTokens:
          typeof event.systemPromptTokens === "number"
            ? event.systemPromptTokens
            : undefined,
      };
    }
    case "error": {
      const err = event.error;
      const text =
        typeof err === "string"
          ? err
          : err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : "Command Code stream error";
      return { kind: "error", text };
    }
    case "abort":
      return { kind: "error", text: "aborted" };
    default:
      return { kind: "ignore" };
  }
}

/**
 * Stream mapped events from Command Code /alpha/generate.
 */
export async function* streamGenerate(
  params: GatewayGenerateParams,
): AsyncGenerator<GatewayMappedEvent, void, unknown> {
  const body = buildGenerateBody(params);
  const headers = buildAuthHeaders({
    apiKey: params.apiKey,
    sessionId: params.sessionId,
    cliVersion: cliVersion(),
    projectSlug: basename(process.env.OPENCODE_COMMANDCODE_CWD || process.cwd()),
  });

  for (let attempt = 0; attempt < MODEL_CALL_MAX_ATTEMPTS; attempt++) {
    let stream: ReadableStream<Uint8Array>;
    try {
      if (params.postStream) {
        stream = await params.postStream(body, headers);
      } else {
        const fetchFn = params.fetchFn ?? fetch;
        const baseUrl = (params.baseUrl ?? getApiBaseUrl()).replace(/\/$/, "");
        const url = `${baseUrl}${GENERATE_ROUTE}`;
        log.info("[opencode-commandcode] POST /alpha/generate", {
          model: params.model,
          toolCount: params.tools?.length ?? 0,
          messageCount: params.messages.length,
          attempt: attempt + 1,
        });
        const res = await fetchFn(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: params.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          if (
            attempt < MODEL_CALL_MAX_ATTEMPTS - 1 &&
            isRetryableGatewayError({ status: res.status, message: text })
          ) {
            log.warn("[opencode-commandcode] transient gateway response; retrying", {
              status: res.status,
              attempt: attempt + 1,
            });
            await retryDelay(attempt, params.signal);
            continue;
          }
          yield {
            kind: "error",
            text: `POST ${GENERATE_ROUTE} → ${res.status} ${text.slice(0, 500)}`,
          };
          return;
        }
        if (!res.body) throw new Error("empty stream body");
        stream = res.body;
      }
    } catch (err) {
      if (params.signal?.aborted) throw err;
      if (attempt < MODEL_CALL_MAX_ATTEMPTS - 1) {
        log.warn("[opencode-commandcode] gateway connection failed; retrying", {
          attempt: attempt + 1,
          error: err instanceof Error ? err.message : String(err),
        });
        await retryDelay(attempt, params.signal);
        continue;
      }
      yield {
        kind: "error",
        text: err instanceof Error ? `network error: ${err.message}` : "network error",
      };
      return;
    }

    let emittedVisible = false;
    let finished = false;
    let retry = false;
    let terminalError = false;
    try {
      for await (const line of readNdjsonLines(stream)) {
        let parsed: StreamEvent;
        try {
          parsed = JSON.parse(line) as StreamEvent;
        } catch {
          continue;
        }
        if (parsed.type === "error") {
          const info = streamErrorInfo(parsed);
          if (
            !emittedVisible &&
            attempt < MODEL_CALL_MAX_ATTEMPTS - 1 &&
            isRetryableGatewayError(info)
          ) {
            retry = true;
            log.warn("[opencode-commandcode] transient stream error; retrying", {
              attempt: attempt + 1,
              status: info.status,
              error: info.message,
            });
            break;
          }
        }
        const mapped = mapStreamEvent(parsed);
        if (
          mapped.kind === "text" ||
          mapped.kind === "reasoning" ||
          mapped.kind === "tool_call" ||
          mapped.kind === "tool_result"
        ) {
          emittedVisible = true;
        }
        if (mapped.kind === "finish") finished = true;
        if (mapped.kind === "error") terminalError = true;
        yield mapped;
      }
    } catch (err) {
      if (params.signal?.aborted) throw err;
      if (!emittedVisible && attempt < MODEL_CALL_MAX_ATTEMPTS - 1) {
        retry = true;
        log.warn("[opencode-commandcode] stream connection failed; retrying", {
          attempt: attempt + 1,
          error: err instanceof Error ? err.message : String(err),
        });
      } else {
        yield {
          kind: "error",
          text: `Stream connection failed mid-response: ${err instanceof Error ? err.message : String(err)}`,
        };
        return;
      }
    }

    if (terminalError) return;
    if (retry || (!finished && !emittedVisible)) {
      if (attempt < MODEL_CALL_MAX_ATTEMPTS - 1) {
        await retryDelay(attempt, params.signal);
        continue;
      }
      yield { kind: "error", text: "stream ended before completion" };
    }
    return;
  }
}

export function stableCompletionId(seed: string): string {
  return `chatcmpl_${createHash("sha1").update(seed).digest("hex").slice(0, 24)}`;
}
