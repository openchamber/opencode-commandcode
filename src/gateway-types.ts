/**
 * Shared gateway wire types for Command Code /alpha/generate.
 */
import { getApiBaseUrl as getBase } from "./log.js";
import {
  GENERATE_ROUTE,
  USAGE_SUMMARY_ROUTE,
  WHOAMI_ROUTE,
} from "./constants.js";

export { GENERATE_ROUTE, USAGE_SUMMARY_ROUTE, WHOAMI_ROUTE };
export const getApiBaseUrl = getBase;

export type WireTextPart = { type: "text"; text: string };
export type WireImagePart = {
  type: "image";
  image: string;
  mimeType?: string;
};
export type WireReasoningPart = { type: "reasoning"; text: string };
export type WireToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};
export type WireToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text" | "error-text"; value: string };
};

export type WireUserContent = Array<WireTextPart | WireImagePart>;
export type WireAssistantContent = Array<
  WireTextPart | WireReasoningPart | WireToolCallPart
>;
export type WireToolContent = Array<WireToolResultPart>;

export type WireMessage =
  | { role: "user"; content: WireUserContent }
  | { role: "assistant"; content: WireAssistantContent }
  | { role: "tool"; content: WireToolContent }
  | { role: "system"; content: string };

export type WireTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type WireUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  /** Estimated USD from the gateway finish event, when provided. */
  costUsd?: number;
};

export type GenerateBody = {
  config: {
    workingDir: string;
    date: string;
    environment: string;
    structure: string[];
    isGitRepo: boolean;
    currentBranch: string;
    mainBranch: string;
    gitStatus: string;
    recentCommits: string[];
    [key: string]: unknown;
  };
  memory: null;
  taste: null;
  skills: unknown;
  permissionMode: "standard" | "auto-accept" | "plan";
  threadId?: string;
  mode?:
    | "agent"
    | "learning"
    | "custom-agent"
    | "custom-agent-create"
    | "title-gen"
    | "tool-desc"
    | "compact"
    | "vision"
    | string;
  params: {
    model: string;
    messages: WireMessage[];
    tools: WireTool[];
    system?: string;
    max_tokens: number;
    stream: boolean;
    temperature?: number;
    reasoning_effort?: string;
  };
};

export type StreamEvent =
  | { type: "text-delta"; text?: string }
  | { type: "reasoning-start" }
  | { type: "reasoning-delta"; text?: string }
  | { type: "reasoning-end" }
  | {
      type: "tool-call";
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      args?: unknown;
      providerExecuted?: boolean;
    }
  | {
      type: "tool-result";
      toolCallId?: string;
      result?: unknown;
      output?: unknown;
      isError?: boolean;
      providerExecuted?: boolean;
    }
  | {
      type: "finish";
      finishReason?: string;
      rawFinishReason?: string;
      totalUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        reasoningTokens?: number;
        cachedInputTokens?: number;
        costUSD?: number;
        costUsd?: number;
        cost_usd?: number;
        total_cost_usd?: number;
        totalCostUSD?: number;
        cost?: number;
        inputTokenDetails?: {
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
      };
      costUSD?: number;
      costUsd?: number;
      cost_usd?: number;
      total_cost_usd?: number;
      systemPromptTokens?: number;
    }
  | { type: "error"; error?: unknown }
  | { type: "abort" }
  | { type: string; [key: string]: unknown };

export function emptyUsage(): WireUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function costFromUnknown(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const o = candidate as Record<string, unknown>;
    const cost =
      asFiniteNumber(o.costUSD) ||
      asFiniteNumber(o.costUsd) ||
      asFiniteNumber(o.cost_usd) ||
      asFiniteNumber(o.total_cost_usd) ||
      asFiniteNumber(o.totalCostUSD) ||
      asFiniteNumber(o.cost);
    if (cost > 0) return cost;
  }
  return 0;
}

/** Map a gateway `finish` event's usage/cost fields onto WireUsage. */
export function usageFromFinishEvent(event: {
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}): WireUsage {
  const usage = emptyUsage();
  const total = event.totalUsage;
  if (total) {
    usage.inputTokens = asFiniteNumber(total.inputTokens);
    usage.outputTokens = asFiniteNumber(total.outputTokens);
    usage.cacheReadTokens =
      asFiniteNumber(total.inputTokenDetails?.cacheReadTokens) ||
      asFiniteNumber(total.cachedInputTokens);
    usage.cacheWriteTokens = asFiniteNumber(
      total.inputTokenDetails?.cacheWriteTokens,
    );
    const reasoning = asFiniteNumber(total.reasoningTokens);
    if (reasoning > 0) usage.reasoningTokens = reasoning;
  }
  const cost = costFromUnknown(total, event);
  if (cost > 0) usage.costUsd = cost;
  return usage;
}

export function addUsage(a: WireUsage, b: WireUsage): WireUsage {
  const reasoningTokens = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  const costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
  };
}
