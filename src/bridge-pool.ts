/**
 * Parked bridge pool for OpenCode tool_calls ↔ Command Code tool-call events.
 */
export type ParkedToolCall = {
  id: string;
  name: string;
  arguments: string;
  resolve: (result: string) => void;
  reject: (err: Error) => void;
  /** Set when parking so resume can await OpenCode tool results. */
  resultPromise?: Promise<string>;
};

export type ParkedBridge = {
  id: string;
  conversationKey: string;
  pendingTools: Map<string, ParkedToolCall>;
  createdAt: number;
  /** Resume generator after tool results land. */
  continueStream?: () => AsyncGenerator<unknown, void, unknown>;
  /** Accumulated assistant text so far (optional). */
  partialText?: string;
  /** Wire messages so far for the next gateway turn. */
  wireMessages?: unknown[];
  modelId?: string;
  system?: string;
  effort?: string;
  tools?: unknown[];
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
};

const bridges = new Map<string, ParkedBridge>();

export function putBridge(bridge: ParkedBridge): void {
  // Supersede older bridges for the same conversation.
  for (const [id, existing] of bridges) {
    if (
      existing.conversationKey === bridge.conversationKey &&
      id !== bridge.id
    ) {
      bridges.delete(id);
    }
  }
  bridges.set(bridge.id, bridge);
}

export function deleteBridge(id: string): void {
  bridges.delete(id);
}

export function findBridgeByConversation(
  conversationKey: string,
): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.conversationKey === conversationKey) return bridge;
  }
  return undefined;
}

export function findBridgeByPendingTool(
  toolCallId: string,
): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.pendingTools.has(toolCallId)) return bridge;
  }
  return undefined;
}

export function clearBridges(): void {
  bridges.clear();
}
