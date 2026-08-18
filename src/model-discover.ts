/** Live Command Code model discovery without a local CLI dependency. */
import type { CommandEffort } from "./constants.js";
import { LAGUNA_MODEL_ID } from "./constants.js";

export type ModelCostRates = {
  input: number;
  output: number;
  cache: { read: number; write: number };
};

export type DiscoveredModelMeta = {
  id: string;
  name: string;
  description?: string;
  contextWindow: number;
  maxTokens: number;
  vision: boolean;
  free: boolean;
  efforts: CommandEffort[];
  reasoning: boolean;
  cost?: ModelCostRates;
};

type ProviderModel = {
  id: string;
  name?: string;
  contextLength?: number;
};

const MODEL_CATALOG_URL = "https://api.commandcode.ai/provider/v1/models";
const DEFAULT_CONTEXT = 256_000;
const DEFAULT_OUTPUT = 32_768;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the public OpenAI-compatible model catalog at the network boundary. */
export function parseProviderModelCatalog(payload: unknown): ProviderModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  const models: ProviderModel[] = [];
  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) continue;
    const contextLength = typeof entry.context_length === "number"
      && Number.isFinite(entry.context_length)
      && entry.context_length > 0
      ? entry.context_length
      : undefined;
    models.push({
      id: entry.id.trim(),
      ...(typeof entry.name === "string" && entry.name.trim() ? { name: entry.name.trim() } : {}),
      ...(contextLength ? { contextLength } : {}),
    });
  }
  return models;
}

function displayNameFromId(id: string): string {
  const short = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return short.replace(/[-_]/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function fallbackCommandModels(): DiscoveredModelMeta[] {
  return [{
    id: LAGUNA_MODEL_ID,
    name: "Laguna S 2.1",
    contextWindow: DEFAULT_CONTEXT,
    maxTokens: DEFAULT_OUTPUT,
    vision: false,
    free: true,
    efforts: [],
    reasoning: true,
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  }];
}

export async function discoverCommandModels(options?: {
  fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  url?: string;
}): Promise<DiscoveredModelMeta[]> {
  const response = await (options?.fetchFn ?? fetch)(options?.url ?? MODEL_CATALOG_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Model catalog request failed (${response.status})`);
  const listed = parseProviderModelCatalog(await response.json());
  if (listed.length === 0) throw new Error("Model catalog response contained no models");
  return listed.map((model) => ({
    id: model.id,
    name: model.name ?? displayNameFromId(model.id),
    contextWindow: model.contextLength ?? DEFAULT_CONTEXT,
    maxTokens: DEFAULT_OUTPUT,
    // The public endpoint does not expose modalities. Passing images through
    // lets the authoritative upstream accept or reject them per model.
    vision: model.id !== LAGUNA_MODEL_ID,
    free: /(?:^|[-/])free(?:$|[-/])/i.test(model.id),
    efforts: [],
    reasoning: true,
    ...(model.id === LAGUNA_MODEL_ID
      ? { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }
      : {}),
  }));
}
