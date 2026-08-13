/**
 * Session-level usage + tool/MCP accounting.
 */
import { createHash } from "node:crypto";
import {
  addUsage,
  emptyUsage,
  type WireUsage,
} from "./gateway-types.js";
import { isNativeMcpName } from "./mcp-names.js";

export type ToolUsageStat = {
  name: string;
  calls: number;
  /** True when the tool looks like an MCP tool (mcp__* or contains mcp). */
  mcp: boolean;
};

export type SessionUsageSnapshot = {
  sessionId: string;
  modelId: string;
  turns: number;
  usage: WireUsage;
  /** Estimated context occupancy from last finish (input + cache reads). */
  lastContextTokens: number;
  contextWindow: number;
  contextFraction: number;
  tools: ToolUsageStat[];
  compactEvents: number;
  updatedAt: number;
};

const sessions = new Map<string, SessionUsageSnapshot>();

function isMcpToolName(name: string): boolean {
  return (
    name.startsWith("mcp__") ||
    name.startsWith("mcp_") ||
    /(^|\.)mcp($|\.)/i.test(name) ||
    // Native OpenCode MCP names (<server>_<tool>) recorded after mapping.
    isNativeMcpName(name)
  );
}

export function conversationKeyFromMessages(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  const seed = messages
    .slice(0, 3)
    .map((m) => `${m.role}:${typeof m.content === "string" ? m.content.slice(0, 80) : ""}`)
    .join("|");
  return `conv_${createHash("sha1").update(seed || "empty").digest("hex").slice(0, 16)}`;
}

export function getOrCreateSessionUsage(
  sessionId: string,
  modelId: string,
  contextWindow: number,
): SessionUsageSnapshot {
  let snap = sessions.get(sessionId);
  if (!snap) {
    snap = {
      sessionId,
      modelId,
      turns: 0,
      usage: emptyUsage(),
      lastContextTokens: 0,
      contextWindow,
      contextFraction: 0,
      tools: [],
      compactEvents: 0,
      updatedAt: Date.now(),
    };
    sessions.set(sessionId, snap);
  } else {
    snap.modelId = modelId;
    snap.contextWindow = contextWindow;
  }
  return snap;
}

export function recordTurnUsage(
  sessionId: string,
  modelId: string,
  contextWindow: number,
  usage: WireUsage,
  systemPromptTokens?: number,
): SessionUsageSnapshot {
  const snap = getOrCreateSessionUsage(sessionId, modelId, contextWindow);
  snap.turns += 1;
  snap.usage = addUsage(snap.usage, usage);
  const contextTokens =
    usage.inputTokens +
    usage.cacheReadTokens +
    (typeof systemPromptTokens === "number" ? 0 : 0);
  // Prefer input+cacheRead as occupancy signal; systemPromptTokens is optional.
  snap.lastContextTokens = Math.max(
    usage.inputTokens + usage.cacheReadTokens,
    systemPromptTokens ?? 0,
    contextTokens,
  );
  snap.contextFraction =
    snap.contextWindow > 0
      ? Math.min(1, snap.lastContextTokens / snap.contextWindow)
      : 0;
  snap.updatedAt = Date.now();
  return snap;
}

export function recordToolCall(
  sessionId: string,
  toolName: string,
  modelId = "unknown",
  contextWindow = 256_000,
): void {
  const snap = getOrCreateSessionUsage(sessionId, modelId, contextWindow);
  const existing = snap.tools.find((t) => t.name === toolName);
  if (existing) {
    existing.calls += 1;
  } else {
    snap.tools.push({
      name: toolName,
      calls: 1,
      mcp: isMcpToolName(toolName),
    });
  }
  snap.updatedAt = Date.now();
}

export function recordCompactEvent(sessionId: string): void {
  const snap = sessions.get(sessionId);
  if (!snap) return;
  snap.compactEvents += 1;
  snap.updatedAt = Date.now();
}

export function getSessionUsage(
  sessionId: string,
): SessionUsageSnapshot | null {
  return sessions.get(sessionId) ?? null;
}

export function listSessionUsage(): SessionUsageSnapshot[] {
  return [...sessions.values()];
}

export function totalUsageAcrossSessions(): WireUsage {
  return [...sessions.values()].reduce(
    (acc, s) => addUsage(acc, s.usage),
    emptyUsage(),
  );
}

export function resetUsageStore(): void {
  sessions.clear();
}

export type ModelCostRates = {
  input: number;
  output: number;
  cache: { read: number; write: number };
};

/** Fill `costUsd` from advertised $/1M rates when the gateway omitted it. */
export function withEstimatedCost(
  usage: WireUsage,
  rates?: ModelCostRates | null,
): WireUsage {
  if ((usage.costUsd ?? 0) > 0) return usage;
  if (!rates) return usage;
  const costUsd =
    (usage.inputTokens / 1e6) * rates.input +
    (usage.outputTokens / 1e6) * rates.output +
    (usage.cacheReadTokens / 1e6) * rates.cache.read +
    (usage.cacheWriteTokens / 1e6) * rates.cache.write;
  if (!(costUsd > 0)) return usage;
  return { ...usage, costUsd };
}

/** Omit empty usage so OpenCode does not overwrite the session meter with zeros. */
export function usageChunkFields(
  usage: WireUsage,
): { usage: OpenAIUsage } | Record<string, never> {
  const openai = usageToOpenAI(usage);
  if (openai.prompt_tokens <= 0 && openai.completion_tokens <= 0) return {};
  return { usage: openai };
}

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  /** Estimated USD from the Command Code gateway (not a billing statement). */
  cost_usd?: number;
};

/**
 * Convert Command Code wire usage into an OpenAI-compatible usage object.
 *
 * OpenAI contract: `prompt_tokens` is the INCLUSIVE prompt total and
 * `prompt_tokens_details.cached_tokens` is a subset of it. Command Code
 * reports `inputTokens` excluding cached tokens (same as Anthropic), so
 * sum them back in — consumers (OpenCode) derive the non-cached count by
 * subtracting the details.
 */
export function usageToOpenAI(usage: WireUsage): OpenAIUsage {
  const cached = usage.cacheReadTokens;
  const cacheWrite = usage.cacheWriteTokens;
  const prompt = usage.inputTokens + cached + cacheWrite;
  const completion = usage.outputTokens;
  const details: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) details.cached_tokens = cached;
  if (cacheWrite > 0) details.cache_write_tokens = cacheWrite;
  const reasoning = usage.reasoningTokens ?? 0;
  const cost = usage.costUsd ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(details).length ? { prompt_tokens_details: details } : {}),
    ...(reasoning > 0
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
    ...(cost > 0 ? { cost_usd: cost } : {}),
  };
}
