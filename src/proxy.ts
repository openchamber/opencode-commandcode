/**
 * Local OpenAI-compatible proxy → Command Code /alpha/generate gateway.
 *
 * Accepts POST /v1/chat/completions, streams OpenAI-format SSE.
 * Tool calls park (bridge-pool) until OpenCode returns tool results.
 */
import { randomUUID } from "node:crypto";
import {
  deleteBridge,
  findBridgeByConversation,
  findBridgeByPendingTool,
  putBridge,
  type ParkedBridge,
  type ParkedToolCall,
} from "./bridge-pool.js";
import { assessContext, compactWireMessages, estimateMessageTokens } from "./compact.js";
import {
  DEFAULT_MODEL_ID,
  LAGUNA_MODEL_ID,
  SESSION_HEADER,
} from "./constants.js";
import {
  decodeCommandModelSelection,
  EFFORT_HEADER,
} from "./model-selection.js";
import { findCommandModel, getCommandModels, resolveCommandModelId } from "./models.js";
import {
  extractTextContent,
  openaiMessagesToWire,
  openaiToolsToWire,
  type OpenAIMessage,
  type OpenAITool,
} from "./prompt.js";
import {
  stableCompletionId,
  streamGenerate,
  type GatewayMappedEvent,
} from "./gateway.js";
import type { WireMessage, WireTool, WireUsage } from "./gateway-types.js";
import { emptyUsage } from "./gateway-types.js";
import { log } from "./log.js";
import {
  conversationKeyFromMessages,
  getSessionUsage,
  listSessionUsage,
  recordToolCall,
  recordTurnUsage,
  totalUsageAcrossSessions,
  usageToOpenAI,
} from "./usage.js";

const DEFAULT_PROXY_PORT = 8797;
const PROXY_PORT_SCAN_ATTEMPTS = 40;

/** Explicit pin via env, or `null` → pick a free port dynamically. */
function envProxyPort(): number | null {
  const raw = process.env.OPENCODE_COMMANDCODE_PROXY_PORT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536
    ? parsed
    : null;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

type TokenProvider = () => Promise<string | null>;

type ChatCompletionRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  tools?: OpenAITool[];
  stream?: boolean;
  temperature?: number;
  stream_options?: { include_usage?: boolean };
};

let server: ReturnType<typeof Bun.serve> | null = null;
let proxyPort: number | null = null;
let getAccessToken: TokenProvider | null = null;

/** Optional injectors for tests. */
let streamGenerateOverride:
  | ((params: Parameters<typeof streamGenerate>[0]) => ReturnType<typeof streamGenerate>)
  | null = null;

export function setStreamGenerateForTests(
  fn: typeof streamGenerateOverride,
): void {
  streamGenerateOverride = fn;
}

export function getCommandProxyBaseUrl(): string {
  const port = proxyPort ?? envProxyPort() ?? DEFAULT_PROXY_PORT;
  return `http://127.0.0.1:${port}/v1`;
}

export function getProxyPort(): number | null {
  return proxyPort ?? envProxyPort();
}

function isAddrInUseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return (
    code === "EADDRINUSE" ||
    (typeof message === "string" &&
      /eaddrinuse|address already in use|in use/i.test(message))
  );
}

async function bindProxy(port: number): Promise<number> {
  const hostname = "127.0.0.1";
  server = Bun.serve({
    hostname,
    port,
    // CLI-compatible model retries can legitimately keep an HTTP request open
    // beyond Bun's 10s default while the upstream gateway is recovering.
    idleTimeout: 120,
    async fetch(req) {
      return handleRequest(req);
    },
  });
  proxyPort = server.port ?? port;
  log.info(
    `[opencode-commandcode] proxy listening on ${getCommandProxyBaseUrl()}`,
  );
  return proxyPort;
}

/**
 * Start the local OpenAI-compatible proxy.
 *
 * Port selection:
 * - `OPENCODE_COMMANDCODE_PROXY_PORT` → bind that exact port
 * - otherwise prefer `8797`, then scan upward, then fall back to OS ephemeral (`0`)
 */
export async function startProxy(tokenProvider: TokenProvider): Promise<number> {
  getAccessToken = tokenProvider;
  if (server && proxyPort) return proxyPort;

  const fixed = envProxyPort();
  if (fixed !== null) {
    try {
      return await bindProxy(fixed);
    } catch (err) {
      throw err;
    }
  }

  // Never reuse a proxy owned by another OpenCode process: its token provider,
  // plugin build, model cache, and session bridge state belong to that process.
  for (let i = 0; i < PROXY_PORT_SCAN_ATTEMPTS; i++) {
    const candidate = DEFAULT_PROXY_PORT + i;
    try {
      return await bindProxy(candidate);
    } catch (err) {
      if (!isAddrInUseError(err)) throw err;
    }
  }

  // Last resort — let the OS pick an ephemeral port.
  return await bindProxy(0);
}

export async function stopProxy(): Promise<void> {
  if (server) {
    server.stop(true);
    server = null;
    proxyPort = null;
  }
  setStreamGenerateForTests(null);
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (
    req.method === "GET" &&
    (url.pathname === "/health" || url.pathname === "/v1/health")
  ) {
    return Response.json({ ok: true, provider: "command-code" });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return Response.json({
      object: "list",
      data: getCommandModels().map((m) => ({
        id: m.id,
        object: "model",
        owned_by: "command-code",
      })),
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/usage") {
    return Response.json({
      object: "usage",
      total: usageToOpenAI(totalUsageAcrossSessions()),
      sessions: listSessionUsage().map((s) => ({
        ...s,
        usage: usageToOpenAI(s.usage),
        mcpTools: s.tools.filter((t) => t.mcp),
        localTools: s.tools.filter((t) => !t.mcp),
      })),
    });
  }

  if (
    req.method === "GET" &&
    url.pathname.startsWith("/v1/usage/session/")
  ) {
    const sessionId = decodeURIComponent(
      url.pathname.slice("/v1/usage/session/".length),
    );
    const snap = getSessionUsage(sessionId);
    if (!snap) {
      return Response.json(
        { error: { message: "session not found", type: "invalid_request_error" } },
        { status: 404 },
      );
    }
    return Response.json({
      ...snap,
      usage: usageToOpenAI(snap.usage),
      mcpTools: snap.tools.filter((t) => t.mcp),
      localTools: snap.tools.filter((t) => !t.mcp),
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    try {
      const body = (await req.json()) as ChatCompletionRequest;
      return await handleChatCompletions(req, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("[opencode-commandcode] chat completions error", message);
      return Response.json(
        { error: { message, type: "server_error" } },
        { status: 500 },
      );
    }
  }

  return new Response("Not Found", { status: 404 });
}

function collectToolResults(messages: OpenAIMessage[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "tool" || !msg.tool_call_id) continue;
    results.set(msg.tool_call_id, extractTextContent(msg.content));
  }
  return results;
}

function selectionFromRequest(
  req: Request,
  body: ChatCompletionRequest,
): { modelId: string; effort?: string } {
  const header = req.headers.get(EFFORT_HEADER);
  const decoded = decodeCommandModelSelection(header);
  const modelId =
    decoded?.modelId ||
    (typeof body.model === "string"
      ? resolveCommandModelId(body.model)
      : LAGUNA_MODEL_ID);
  return {
    modelId,
    ...(decoded?.effort ? { effort: decoded.effort } : {}),
  };
}

async function handleChatCompletions(
  req: Request,
  body: ChatCompletionRequest,
): Promise<Response> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const conversationKey =
    req.headers.get(SESSION_HEADER) ||
    conversationKeyFromMessages(messages);
  const selection = selectionFromRequest(req, body);
  const modelMeta =
    findCommandModel(selection.modelId) ||
    findCommandModel(DEFAULT_MODEL_ID)!;
  const model = resolveCommandModelId(selection.modelId);
  const stream = body.stream !== false;
  const includeUsage = body.stream_options?.include_usage !== false;

  const toolResults = collectToolResults(messages);
  let existing = findBridgeByConversation(conversationKey);
  if ((!existing || existing.pendingTools.size === 0) && toolResults.size > 0) {
    for (const toolCallId of toolResults.keys()) {
      const byTool = findBridgeByPendingTool(toolCallId);
      if (byTool) {
        existing = byTool;
        break;
      }
    }
  }

  // Resume parked tool turn: append tool results and call gateway again.
  if (existing && existing.pendingTools.size > 0 && toolResults.size > 0) {
    let resolved = 0;
    for (const [toolId, tool] of existing.pendingTools) {
      const result = toolResults.get(toolId);
      if (result !== undefined) {
        tool.resolve(result);
        existing.pendingTools.delete(toolId);
        resolved++;
      }
    }
    if (existing.pendingTools.size === 0 && existing.continueStream) {
      log.info("[opencode-commandcode] resuming parked bridge", {
        conversationKey: existing.conversationKey,
        resolved,
      });
      return streamOpenAIResponse(
        existing.continueStream(),
        body.model || model,
        stream,
        existing,
        includeUsage,
      );
    }
    if (resolved === 0) {
      return streamOpenAIResponse(
        (async function* () {
          yield {
            type: "__park__",
            tools: [...existing!.pendingTools.values()],
          };
        })(),
        body.model || model,
        stream,
        existing,
        includeUsage,
      );
    }
  }

  const apiKey = getAccessToken ? await getAccessToken() : null;
  if (!apiKey) {
    return Response.json(
      {
        error: {
          message:
            "Not authenticated with Command Code. Run `cmd login` or set COMMAND_CODE_API_KEY, then `opencode auth login --provider command-code`.",
          type: "authentication_error",
        },
      },
      { status: 401 },
    );
  }

  const openCodeTools = Array.isArray(body.tools) ? body.tools : [];
  const { system, messages: wireMessages } = openaiMessagesToWire(messages, {
    vision: modelMeta.vision,
  });
  if (wireMessages.length === 0 && openCodeTools.length === 0) {
    return Response.json(
      {
        error: {
          message: "No user message found",
          type: "invalid_request_error",
        },
      },
      { status: 400 },
    );
  }

  // Context / compact pre-check
  const estimated = estimateMessageTokens(wireMessages);
  const advice = assessContext(estimated, modelMeta.contextWindow);
  let finalMessages = wireMessages;
  let compactNote: string | null = advice.message;
  if (advice.shouldCompact || advice.tier === "warn") {
    const compacted = compactWireMessages(wireMessages, {
      sessionId: conversationKey,
      keepToolResults: advice.tier === "auto" ? 10 : 20,
    });
    finalMessages = compacted.messages;
    if (compacted.note) compactNote = compacted.note;
  }

  const wireTools = openaiToolsToWire(openCodeTools);
  const bridgeId = randomUUID();
  const pendingTools = new Map<string, ParkedToolCall>();

  const bridge: ParkedBridge = {
    id: bridgeId,
    conversationKey,
    pendingTools,
    createdAt: Date.now(),
    wireMessages: finalMessages,
    modelId: model,
    system,
    effort: selection.effort,
    tools: wireTools,
    apiKey,
    contextWindow: modelMeta.contextWindow,
    maxTokens: modelMeta.maxTokens,
  };
  putBridge(bridge);

  async function* runTurn(
    msgs: WireMessage[],
    tools: WireTool[],
    preface?: string | null,
  ): AsyncGenerator<unknown, void, unknown> {
    if (preface) {
      yield { type: "__reasoning__", text: `${preface}\n` };
    }

    const gen = (streamGenerateOverride || streamGenerate)({
      apiKey: apiKey!,
      model,
      messages: msgs,
      tools,
      system: system || undefined,
      maxTokens: modelMeta.maxTokens,
      temperature: body.temperature,
      effort: selection.effort,
      permissionMode: tools.length > 0 ? "auto-accept" : "auto-accept",
      sessionId: conversationKey,
      threadId: undefined,
    });

    const assistantToolCalls: ParkedToolCall[] = [];
    let turnUsage: WireUsage = emptyUsage();
    let systemPromptTokens: number | undefined;
    let finishReason = "stop";

    for await (const event of gen) {
      if (event.kind === "text" || event.kind === "reasoning") {
        yield event;
        continue;
      }
      if (event.kind === "error") {
        yield event;
        continue;
      }
      if (event.kind === "tool_call") {
        if (event.providerExecuted) {
          // Server-executed tool — surface as reasoning note, do not park.
          yield {
            kind: "reasoning",
            text: `[mcp/tool] ${event.name} (provider-executed)\n`,
          } satisfies GatewayMappedEvent;
          recordToolCall(conversationKey, event.name);
          continue;
        }
        recordToolCall(conversationKey, event.name);
        const pending: ParkedToolCall = {
          id: event.id,
          name: event.name,
          arguments: event.arguments,
          resolve: () => {},
          reject: () => {},
        };
        pending.resultPromise = new Promise<string>((resolve, reject) => {
          pending.resolve = resolve;
          pending.reject = reject;
        });
        pendingTools.set(event.id, pending);
        assistantToolCalls.push(pending);
        continue;
      }
      if (event.kind === "finish") {
        turnUsage = event.usage;
        systemPromptTokens = event.systemPromptTokens;
        finishReason = event.finishReason;
        recordTurnUsage(
          conversationKey,
          model,
          modelMeta.contextWindow,
          turnUsage,
          systemPromptTokens,
        );
        // After finish, if we collected client tools, park for OpenCode.
        if (assistantToolCalls.length > 0) {
          finishReason = "tool_calls";
          const assistantContent = assistantToolCalls.map((t) => ({
            type: "tool-call" as const,
            toolCallId: t.id,
            toolName: t.name,
            input: safeParse(t.arguments),
          }));
          const nextMessages: WireMessage[] = [
            ...msgs,
            { role: "assistant", content: assistantContent },
          ];
          bridge.wireMessages = nextMessages;
          bridge.continueStream = async function* () {
            const toolMsgs: WireMessage[] = [];
            for (const tool of assistantToolCalls) {
              const result = await tool.resultPromise!;
              toolMsgs.push({
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: tool.id,
                    toolName: tool.name,
                    output: { type: "text", value: result },
                  },
                ],
              });
            }
            const resumed = [
              ...(bridge.wireMessages as WireMessage[]),
              ...toolMsgs,
            ];
            bridge.wireMessages = resumed;
            pendingTools.clear();
            yield* runTurn(resumed, tools, null);
          };
          yield { type: "__park__", tools: assistantToolCalls };
          return;
        }
        yield {
          kind: "finish",
          finishReason,
          usage: turnUsage,
          systemPromptTokens,
        } satisfies GatewayMappedEvent;
        deleteBridge(bridgeId);
        return;
      }
    }

    // Stream ended without explicit finish.
    recordTurnUsage(
      conversationKey,
      model,
      modelMeta.contextWindow,
      turnUsage,
      systemPromptTokens,
    );
    yield {
      kind: "finish",
      finishReason,
      usage: turnUsage,
      systemPromptTokens,
    } satisfies GatewayMappedEvent;
    if (pendingTools.size === 0) deleteBridge(bridgeId);
  }

  return streamOpenAIResponse(
    runTurn(finalMessages, wireTools, compactNote),
    body.model || model,
    stream,
    bridge,
    includeUsage,
  );
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { value: v };
  } catch {
    return { raw };
  }
}

function streamOpenAIResponse(
  events: AsyncIterable<unknown>,
  model: string,
  stream: boolean,
  bridge: ParkedBridge,
  includeUsage: boolean,
): Response {
  const completionId = stableCompletionId(bridge.id);
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    const bodyStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          let content = "";
          let reasoning = "";
          const toolCalls: ParkedToolCall[] = [];
          let usage = emptyUsage();
          for await (const event of events) {
            const mapped = normalizeEvent(event);
            if (mapped.kind === "park") toolCalls.push(...mapped.tools);
            else if (mapped.kind === "text") content += mapped.text;
            else if (mapped.kind === "reasoning") reasoning += mapped.text;
            else if (mapped.kind === "finish") usage = mapped.usage;
            else if (mapped.kind === "error") content += `\n\n[command-code error] ${mapped.text}`;
          }
          const payload = {
            id: completionId,
            object: "chat.completion",
            created,
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content,
                  ...(reasoning ? { reasoning_content: reasoning } : {}),
                  ...(toolCalls.length
                    ? {
                        tool_calls: toolCalls.map((t) => ({
                          id: t.id,
                          type: "function",
                          function: {
                            name: t.name,
                            arguments: t.arguments,
                          },
                        })),
                      }
                    : {}),
                },
                finish_reason: toolCalls.length ? "tool_calls" : "stop",
              },
            ],
            ...(includeUsage ? { usage: usageToOpenAI(usage) } : {}),
          };
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(payload)),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ error: { message, type: "server_error" } }),
            ),
          );
        } finally {
          controller.close();
        }
      },
    });
    return new Response(bodyStream, {
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      send({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      });

      let finishReason: string | null = "stop";
      let usage = emptyUsage();

      try {
        for await (const event of events) {
          const mapped = normalizeEvent(event);
          if (mapped.kind === "park") {
            finishReason = "tool_calls";
            for (let i = 0; i < mapped.tools.length; i++) {
              const tool = mapped.tools[i];
              send({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: i,
                          id: tool.id,
                          type: "function",
                          function: {
                            name: tool.name,
                            arguments: tool.arguments,
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
            }
            break;
          }
          if (mapped.kind === "text" && mapped.text) {
            send({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: mapped.text },
                  finish_reason: null,
                },
              ],
            });
          }
          if (mapped.kind === "reasoning" && mapped.text) {
            send({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: mapped.text },
                  finish_reason: null,
                },
              ],
            });
          }
          if (mapped.kind === "finish") {
            finishReason = mapped.finishReason;
            usage = mapped.usage;
          }
          if (mapped.kind === "error") {
            send({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: `\n\n[command-code error] ${mapped.text}`,
                  },
                  finish_reason: null,
                },
              ],
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: `\n\n[command-code error] ${message}` },
              finish_reason: null,
            },
          ],
        });
      }

      send({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        ...(includeUsage ? { usage: usageToOpenAI(usage) } : {}),
      });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(readable, { headers: SSE_HEADERS });
}

type Normalized =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "park"; tools: ParkedToolCall[] }
  | { kind: "finish"; finishReason: string; usage: WireUsage }
  | { kind: "error"; text: string }
  | { kind: "ignore" };

function normalizeEvent(event: unknown): Normalized {
  if (!event || typeof event !== "object") return { kind: "ignore" };
  const e = event as Record<string, unknown>;
  if (e.type === "__park__" && Array.isArray(e.tools)) {
    return { kind: "park", tools: e.tools as ParkedToolCall[] };
  }
  if (e.type === "__reasoning__" && typeof e.text === "string") {
    return { kind: "reasoning", text: e.text };
  }
  if (e.kind === "text" && typeof e.text === "string") {
    return { kind: "text", text: e.text };
  }
  if (e.kind === "reasoning" && typeof e.text === "string") {
    return { kind: "reasoning", text: e.text };
  }
  if (e.kind === "error" && typeof e.text === "string") {
    return { kind: "error", text: e.text };
  }
  if (e.kind === "finish") {
    return {
      kind: "finish",
      finishReason: typeof e.finishReason === "string" ? e.finishReason : "stop",
      usage: (e.usage as WireUsage) || emptyUsage(),
    };
  }
  return { kind: "ignore" };
}
