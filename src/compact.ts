/**
 * Context-window / compact helpers for long OpenCode ↔ Command Code sessions.
 */
import { COMPACT_TIERS } from "./constants.js";
import type { WireMessage } from "./gateway-types.js";
import { recordCompactEvent } from "./usage.js";
import { log } from "./log.js";

export type CompactAdvice = {
  tier: "ok" | "tip" | "warn" | "auto";
  fraction: number;
  shouldCompact: boolean;
  message: string | null;
};

export function assessContext(
  lastContextTokens: number,
  contextWindow: number,
): CompactAdvice {
  if (contextWindow <= 0) {
    return { tier: "ok", fraction: 0, shouldCompact: false, message: null };
  }
  const fraction = lastContextTokens / contextWindow;
  if (fraction >= COMPACT_TIERS.auto) {
    return {
      tier: "auto",
      fraction,
      shouldCompact: true,
      message: `[compact] Context at ${Math.round(fraction * 100)}% of window — auto-compacting older turns.`,
    };
  }
  if (fraction >= COMPACT_TIERS.warn) {
    return {
      tier: "warn",
      fraction,
      shouldCompact: false,
      message: `[compact] Context at ${Math.round(fraction * 100)}% — consider compacting soon.`,
    };
  }
  if (fraction >= COMPACT_TIERS.tip) {
    return {
      tier: "tip",
      fraction,
      shouldCompact: false,
      message: `[compact] Context at ${Math.round(fraction * 100)}% — compact at a task boundary if this session will grow.`,
    };
  }
  return { tier: "ok", fraction, shouldCompact: false, message: null };
}

/**
 * Estimate rough token count from wire messages (chars/4 heuristic).
 * Used when the gateway has not yet reported usage for this turn.
 */
export function estimateMessageTokens(messages: WireMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
      continue;
    }
    for (const part of msg.content) {
      if (part.type === "text") chars += part.text.length;
      else if (part.type === "reasoning") chars += part.text.length;
      else if (part.type === "image") chars += 256; // placeholder cost
      else if (part.type === "tool-call") {
        chars += part.toolName.length + JSON.stringify(part.input).length;
      } else if (part.type === "tool-result") {
        chars += part.output.value.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Tiered client-side compact: trim old tool results, then drop early turns.
 * Mirrors Command Code's fast compact-mode spirit for the OpenCode proxy path.
 */
export function compactWireMessages(
  messages: WireMessage[],
  options: {
    sessionId: string;
    keepToolResults?: number;
    keepTurns?: number;
  },
): { messages: WireMessage[]; compacted: boolean; note: string | null } {
  const keepToolResults = options.keepToolResults ?? 10;
  const keepTurns = options.keepTurns ?? 24;

  let toolResults: Array<{ index: number; msgIndex: number; partIndex: number }> =
    [];
  messages.forEach((msg, msgIndex) => {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) return;
    msg.content.forEach((part, partIndex) => {
      if (part.type === "tool-result") {
        toolResults.push({
          index: toolResults.length,
          msgIndex,
          partIndex,
        });
      }
    });
  });

  let compacted = false;
  const cloned: WireMessage[] = messages.map((m) => {
    if (typeof m.content === "string") return { ...m };
    return {
      ...m,
      content: m.content.map((p) => ({ ...p })),
    } as WireMessage;
  });

  if (toolResults.length > keepToolResults) {
    const dropCount = toolResults.length - keepToolResults;
    for (let i = 0; i < dropCount; i++) {
      const ref = toolResults[i];
      const msg = cloned[ref.msgIndex];
      if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
      const part = msg.content[ref.partIndex];
      if (part?.type === "tool-result") {
        part.output = {
          type: "text",
          value: "[compacted: older tool result trimmed]",
        };
        compacted = true;
      }
    }
  }

  // Keep system + recent turns.
  if (cloned.length > keepTurns) {
    const system = cloned.filter((m) => m.role === "system");
    const rest = cloned.filter((m) => m.role !== "system");
    const kept = rest.slice(-keepTurns);
    cloned.length = 0;
    cloned.push(...system, ...kept);
    compacted = true;
  }

  if (compacted) {
    recordCompactEvent(options.sessionId);
    log.info("[opencode-commandcode] compacted wire messages", {
      sessionId: options.sessionId,
      remaining: cloned.length,
    });
    return {
      messages: cloned,
      compacted: true,
      note: "[compact] Older context was compacted before this turn.",
    };
  }

  return { messages: cloned, compacted: false, note: null };
}
