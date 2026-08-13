/**
 * Discover Command Code models dynamically from the installed CLI.
 * No hardcoded catalog — prefer `cmd --list-models`, enrich from bundled models.md.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import type { CommandEffort } from "./constants.js";
import { isCommandEffort, LAGUNA_MODEL_ID } from "./constants.js";
import { resolveCommandCodeExecutable } from "./executable-path.js";
import { log } from "./log.js";

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
};

/**
 * Command Code deliberately models vision support as an exclusion list. Read
 * that list from the installed CLI bundle so our capabilities stay in lockstep
 * with the exact CLI version making the same gateway request.
 */
function readCliTextOnlyModels(cmdPath: string | null): Set<string> | null {
  const root = findCommandCodePackageRoot(cmdPath);
  if (!root) return null;
  const bundle = join(root, "dist", "cli.mjs");
  if (!existsSync(bundle)) return null;
  try {
    const source = readFileSync(bundle, "utf8");
    const marker = source.indexOf('function isKnownTextOnlyModel');
    if (marker < 0) return null;
    const prefix = source.slice(Math.max(0, marker - 12_000), marker);
    const matches = [...prefix.matchAll(/new Set\((\[[^;]{1,12000}?\])\)/g)];
    for (const match of matches.reverse()) {
      try {
        const values = JSON.parse(match[1]) as unknown;
        if (
          Array.isArray(values) &&
          values.every((v) => typeof v === "string") &&
          values.includes(LAGUNA_MODEL_ID)
        ) {
          return new Set(values.map((id) => id.toLowerCase()));
        }
      } catch {
        // Minified bundle also contains Sets with symbolic array entries.
      }
    }
    return null;
  } catch (err) {
    log.warn(
      "[opencode-commandcode] could not read CLI modality registry",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

const DEFAULT_CONTEXT = 256_000;
const DEFAULT_OUTPUT = 32_768;
const HEADER_WORDS = new Set([
  "open",
  "source",
  "anthropic",
  "openai",
  "google",
  "sakana",
  "meta",
  "xai",
  "available",
  "pass",
  "docs",
  "the",
]);

function parseContextWindow(raw: string): number | null {
  const t = raw.trim();
  if (!t || t === "—") return null;
  const m = t.match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "").toUpperCase();
  if (unit === "K") return Math.round(n * 1_000);
  if (unit === "M") return Math.round(n * 1_000_000);
  if (unit === "B") return Math.round(n * 1_000_000_000);
  return Math.round(n);
}

function parseEfforts(raw: string): CommandEffort[] {
  if (!raw || raw.trim() === "—") return [];
  const out: CommandEffort[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const p = part.trim().toLowerCase();
    if (isCommandEffort(p)) out.push(p);
  }
  return out;
}

function looksLikeModelId(id: string): boolean {
  if (!id || id.length < 3) return false;
  if (HEADER_WORDS.has(id.toLowerCase())) return false;
  if (/^https?:/i.test(id)) return false;
  // provider/name or bare frontier ids
  if (id.includes("/")) return /^[A-Za-z0-9._@+-]+\/[A-Za-z0-9._@+-]+$/.test(id);
  return /^(claude-|gpt-|o\d)/i.test(id);
}

/** Parse `cmd --list-models` text output into id + description. */
export function parseListModelsOutput(text: string): Array<{
  id: string;
  description: string;
}> {
  const out: Array<{ id: string; description: string }> = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s{2,}(.+)$/);
    if (!m) continue;
    const id = m[1].trim();
    const description = m[2].trim();
    if (!looksLikeModelId(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, description });
  }
  return out;
}

/** Parse Command Code knowledge `models.md` table for richer metadata. */
export function parseModelsMarkdown(md: string): Map<string, DiscoveredModelMeta> {
  const map = new Map<string, DiscoveredModelMeta>();
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(
      /^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/,
    );
    if (!m) continue;
    const id = m[1].trim();
    const name = m[2].trim();
    const contextRaw = m[3].trim();
    const effortsRaw = m[4].trim();
    if (!looksLikeModelId(id)) continue;
    const efforts = parseEfforts(effortsRaw);
    const contextWindow = parseContextWindow(contextRaw) ?? DEFAULT_CONTEXT;
    const free = /free/i.test(id) || /\$0\/\$0/.test(line);
    const vision =
      /vision|multimodal|image/i.test(line) ||
      /kimi|minimax|gemini|inkling|step-/i.test(id);
    map.set(id, {
      id,
      name,
      contextWindow,
      maxTokens: DEFAULT_OUTPUT,
      vision,
      free,
      efforts,
      reasoning: efforts.length > 0,
    });
    // Case-insensitive alias for CLI lowercase ids
    map.set(id.toLowerCase(), map.get(id)!);
  }
  return map;
}

function findCommandCodePackageRoot(cmdPath: string | null): string | null {
  if (!cmdPath) return null;
  let resolved = cmdPath;
  try {
    resolved = realpathSync(cmdPath);
  } catch {
    // keep
  }
  // Typical npm layout: .../node_modules/command-code/bin/... or .../command-code/...
  const parts = resolved.split(/[/\\]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === "command-code") {
      return parts.slice(0, i + 1).join("/");
    }
  }
  // Global shim: ~/.local/bin/cmd → ~/.local/lib/node_modules/command-code
  const binDir = dirname(resolved);
  const candidates = [
    join(binDir, "..", "lib", "node_modules", "command-code"),
    join(binDir, "..", "node_modules", "command-code"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "package.json"))) return c;
  }
  return null;
}

function findModelsMarkdown(cmdPath: string | null): string | null {
  const root = findCommandCodePackageRoot(cmdPath);
  if (!root) return null;
  const candidate = join(
    root,
    "dist",
    "bundled",
    "command-code-knowledge",
    "reference",
    "models.md",
  );
  return existsSync(candidate) ? candidate : null;
}

function displayNameFromId(id: string, description?: string): string {
  const short = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const pretty = short
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  if (description && /FREE/i.test(description)) return `${pretty} (free)`;
  return pretty;
}

function runListModels(cmdPath: string): string | null {
  try {
    const result = spawnSync(cmdPath, ["--list-models"], {
      encoding: "utf8",
      timeout: 20_000,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = `${result.stdout || ""}${result.stderr || ""}`;
    if (!out.trim()) return null;
    return out;
  } catch (err) {
    log.warn(
      "[opencode-commandcode] cmd --list-models failed",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Discover the live Command Code model catalog from the installed CLI.
 */
export function discoverCommandModels(): DiscoveredModelMeta[] {
  const cmdPath = resolveCommandCodeExecutable();
  const listText = cmdPath ? runListModels(cmdPath) : null;
  const listed = listText ? parseListModelsOutput(listText) : [];

  const mdPath = findModelsMarkdown(cmdPath);
  let mdMeta = new Map<string, DiscoveredModelMeta>();
  if (mdPath) {
    try {
      mdMeta = parseModelsMarkdown(readFileSync(mdPath, "utf8"));
    } catch (err) {
      log.warn(
        "[opencode-commandcode] failed reading models.md",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const byId = new Map<string, DiscoveredModelMeta>();
  const textOnly = readCliTextOnlyModels(cmdPath);

  // Prefer live CLI listing order; enrich from models.md when present.
  for (const row of listed) {
    const enrich =
      mdMeta.get(row.id) ||
      mdMeta.get(row.id.toLowerCase()) ||
      // CLI lowercases some ids; md keeps vendor casing
      [...mdMeta.values()].find(
        (m) => m.id.toLowerCase() === row.id.toLowerCase(),
      );
    const free =
      enrich?.free ||
      /free/i.test(row.id) ||
      /FREE/i.test(row.description || "");
    byId.set(row.id, {
      id: enrich?.id || row.id,
      name: enrich?.name || displayNameFromId(row.id, row.description),
      description: row.description,
      contextWindow: enrich?.contextWindow ?? DEFAULT_CONTEXT,
      maxTokens: enrich?.maxTokens ?? DEFAULT_OUTPUT,
      // The CLI's own registry is authoritative. Its behavior is: known
      // text-only models strip images; every other listed model accepts them.
      vision: textOnly
        ? !textOnly.has((enrich?.id || row.id).toLowerCase())
        : (enrich?.vision ?? false),
      free,
      efforts: enrich?.efforts ?? [],
      reasoning: enrich ? enrich.reasoning : true,
    });
  }

  // If CLI list failed, fall back to models.md alone.
  if (byId.size === 0 && mdMeta.size > 0) {
    for (const [key, meta] of mdMeta) {
      if (key !== meta.id) continue; // skip lowercase duplicates
      byId.set(meta.id, meta);
    }
  }

  // Absolute last resort so the provider stays selectable for live tests.
  if (byId.size === 0) {
    log.warn(
      "[opencode-commandcode] no live model catalog; temporary Laguna-only fallback",
    );
    byId.set(LAGUNA_MODEL_ID, {
      id: LAGUNA_MODEL_ID,
      name: "Laguna S 2.1 (free)",
      contextWindow: DEFAULT_CONTEXT,
      maxTokens: DEFAULT_OUTPUT,
      vision: false,
      free: true,
      efforts: [],
      reasoning: true,
    });
  }

  return [...byId.values()];
}
