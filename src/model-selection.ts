import {
  EFFORT_HEADER,
  isCommandEffort,
  type CommandEffort,
  DEFAULT_MODEL_ID,
} from "./constants.js";
import { resolveCommandModelId } from "./models.js";

export { EFFORT_HEADER };

export type CommandModelSelection = {
  modelId: string;
  effort?: CommandEffort;
};

export function resolveCommandModelSelection(
  modelId: string,
  variant?: string,
): CommandModelSelection {
  const resolved = resolveCommandModelId(modelId || DEFAULT_MODEL_ID);
  const effort = isCommandEffort(variant) ? variant : undefined;
  return effort ? { modelId: resolved, effort } : { modelId: resolved };
}

export function encodeCommandModelSelection(
  selection: CommandModelSelection,
): string {
  return selection.effort
    ? `${selection.modelId}|${selection.effort}`
    : selection.modelId;
}

export function decodeCommandModelSelection(
  header: string | null | undefined,
): CommandModelSelection | null {
  if (!header || typeof header !== "string") return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const pipe = trimmed.indexOf("|");
  if (pipe < 0) {
    return { modelId: resolveCommandModelId(trimmed) };
  }
  const modelId = resolveCommandModelId(trimmed.slice(0, pipe));
  const effortRaw = trimmed.slice(pipe + 1);
  const effort = isCommandEffort(effortRaw) ? effortRaw : undefined;
  return effort ? { modelId, effort } : { modelId };
}
