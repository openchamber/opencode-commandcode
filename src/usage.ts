/**
 * Session-level usage + tool/MCP accounting.
 */
import { createHash } from "node:crypto";
import {
  addUsage,
  emptyUsage,
  type WireUsage,
} from "./gateway-types.js";

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
    /(^|\.)mcp($|\.)/i.test(name)
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

export function usageToOpenAI(usage: WireUsage): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
    cache_write_tokens: number;
  };
} {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cacheReadTokens,
      cache_write_tokens: usage.cacheWriteTokens,
    },
  };
}
