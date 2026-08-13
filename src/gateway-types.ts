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
        inputTokenDetails?: {
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
      };
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

export function addUsage(a: WireUsage, b: WireUsage): WireUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
