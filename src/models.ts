/**
 * Command Code model catalog — discovered dynamically from the installed CLI.
 * Laguna remains the preferred default when present (unlimited free tier for tests),
 * but every model from `cmd --list-models` is exposed in OpenCode.
 */
import {
  EFFORT_LEVELS,
  type CommandEffort,
  DEFAULT_MODEL_ID,
  LAGUNA_MODEL_ID,
} from "./constants.js";
import {
  discoverCommandModels,
  type DiscoveredModelMeta,
} from "./model-discover.js";
import { log } from "./log.js";

export type CommandModel = {
  id: string;
  name: string;
  resolvedId: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Vision / image input support on the upstream model. */
  vision: boolean;
  /** Free-tier badge. */
  free?: boolean;
  /** Supported effort levels from Command Code (empty → model decides). */
  efforts?: CommandEffort[];
};

const CATALOG_TTL_MS = 30 * 60 * 1000;

let cachedModels: CommandModel[] | null = null;
let cachedAt = 0;

export const GENERATED_VARIANT_KEYS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Placeholder so OpenCode keeps the provider visible while logged out. */
export const LOGIN_PLACEHOLDER_MODELS: CommandModel[] = [
  {
    id: "login",
    name: "Sign in to Command Code",
    resolvedId: "login",
    reasoning: false,
    contextWindow: 256_000,
    maxTokens: 8_192,
    vision: false,
  },
];

function metaToModel(meta: DiscoveredModelMeta): CommandModel {
  return {
    id: meta.id,
    name: meta.name,
    resolvedId: meta.id,
    reasoning: meta.reasoning || meta.efforts.length > 0,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    vision: meta.vision,
    free: meta.free || undefined,
    efforts: meta.efforts.length ? meta.efforts : undefined,
  };
}

function normalizeCatalog(models: CommandModel[]): CommandModel[] {
  const unique = new Map<string, CommandModel>();
  for (const model of models) {
    const key = model.resolvedId.toLowerCase();
    if (!unique.has(key)) unique.set(key, model);
  }
  return [...unique.values()].sort((a, b) => {
    const rank = (m: CommandModel) =>
      m.resolvedId === LAGUNA_MODEL_ID ? 0 : m.free ? 1 : 2;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
}

export function invalidateCommandModelCache(): void {
  cachedModels = null;
  cachedAt = 0;
}

/** Force a fresh discovery from the Command Code CLI. */
export function refreshCommandModels(): CommandModel[] {
  const discovered = discoverCommandModels().map(metaToModel);
  cachedModels = normalizeCatalog(discovered);
  cachedAt = Date.now();
  log.info("[opencode-commandcode] model catalog refreshed", {
    count: cachedModels.length,
  });
  return cachedModels;
}

/**
 * Live catalog (cached). Discovers via `cmd --list-models` on first use /
 * after TTL expiry — never a hardcoded product list.
 */
export function getCommandModels(): CommandModel[] {
  if (cachedModels && Date.now() - cachedAt < CATALOG_TTL_MS) {
    return cachedModels;
  }
  return refreshCommandModels();
}

/** Snapshot alias used by older call sites / tests. */
export function listCommandCodeModels(): CommandModel[] {
  return getCommandModels();
}

export function isLoginPlaceholderModel(id: string): boolean {
  return id === "login";
}

export function resolveCommandModelId(modelId: string): string {
  const cleaned = modelId.replace(/^command-code\//, "").trim();
  if (!cleaned || cleaned === DEFAULT_MODEL_ID || cleaned === "laguna") {
    return LAGUNA_MODEL_ID;
  }

  const models = getCommandModels();
  const exact = models.find(
    (m) => m.id === cleaned || m.resolvedId === cleaned,
  );
  if (exact) return exact.resolvedId;

  if (!cleaned.includes("/")) {
    const bySuffix = models.find((m) =>
      m.resolvedId.toLowerCase().endsWith(`/${cleaned.toLowerCase()}`),
    );
    if (bySuffix) return bySuffix.resolvedId;
  }

  // Case-insensitive full id match
  const ci = models.find(
    (m) => m.resolvedId.toLowerCase() === cleaned.toLowerCase(),
  );
  if (ci) return ci.resolvedId;

  // Pass through unknown ids to the gateway (BYO / newly listed models).
  return cleaned;
}

export function findCommandModel(modelId: string): CommandModel | undefined {
  const cleaned = modelId.replace(/^command-code\//, "").trim();
  const models = getCommandModels();
  const resolved = resolveCommandModelId(cleaned);
  return (
    models.find((m) => m.id === cleaned || m.resolvedId === cleaned) ||
    models.find((m) => m.resolvedId === resolved) ||
    models.find((m) => m.resolvedId.toLowerCase() === resolved.toLowerCase())
  );
}

export function buildEffortVariants(
  model: CommandModel,
): Record<string, { effort: CommandEffort } | { disabled: true }> {
  if (isLoginPlaceholderModel(model.id)) return {};
  const supported =
    model.efforts && model.efforts.length > 0
      ? model.efforts
      : model.reasoning
        ? [...EFFORT_LEVELS]
        : [];
  if (supported.length === 0) return {};

  const variants: Record<
    string,
    { effort: CommandEffort } | { disabled: true }
  > = Object.fromEntries(supported.map((effort) => [effort, { effort }]));
  for (const key of GENERATED_VARIANT_KEYS) {
    if (!(key in variants)) variants[key] = { disabled: true };
  }
  return variants;
}

export function buildConfigVariants(
  model: CommandModel,
): Record<string, { effort: CommandEffort } | { disabled: true }> {
  return buildEffortVariants(model);
}
