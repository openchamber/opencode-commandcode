/**
 * OpenCode Command Code Auth Plugin
 *
 * Enables Command Code models inside OpenCode via:
 * 1. Command Code browser login with a local callback
 * 2. Local OpenAI-compatible proxy → api.commandcode.ai /alpha/generate
 * 3. Dynamic model catalog from the public Command Code API
 * 4. Tools/MCP park-resume, attachments, compact, and usage accounting
 *
 * Register in opencode.json:
 *   { "plugin": ["@openchamber/opencode-commandcode"] }
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  completeCommandBrowserLogin,
  getPendingCommandLogin,
  resetPendingCommandLogin,
  startCommandBrowserLogin,
} from "./auth-login.js";
import {
  DEFAULT_MODEL_ID,
  EFFORT_HEADER,
  LAGUNA_MODEL_ID,
  OPENAI_COMPATIBLE_NPM,
  PROVIDER_ID,
  REQUEST_KIND_HEADER,
  SESSION_HEADER,
} from "./constants.js";
import { log } from "./log.js";
import { readCommandCodeApiKeyFromEnv } from "./credentials.js";
import { setMcpServers } from "./mcp-names.js";
import {
  encodeCommandModelSelection,
  resolveCommandModelSelection,
} from "./model-selection.js";
import {
  buildConfigVariants,
  buildEffortVariants,
  getCommandModels,
  refreshCommandModels,
  type CommandModel,
} from "./models.js";
import {
  getCommandProxyBaseUrl,
  getProxyPort,
  startProxy,
} from "./proxy.js";

type CommandApiAuth = {
  type: "api" | "oauth";
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
};

function isCommandAuth(auth: unknown): auth is CommandApiAuth {
  if (!auth || typeof auth !== "object") return false;
  const a = auth as CommandApiAuth;
  return a.type === "api" || a.type === "oauth";
}

function authKey(auth: CommandApiAuth | null | undefined): string | null {
  if (!auth) return null;
  if (typeof auth.key === "string" && auth.key.trim()) return auth.key.trim();
  if (typeof auth.access === "string" && auth.access.trim()) {
    return auth.access.trim();
  }
  return null;
}

function zeroCost() {
  return {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  };
}

function buildProviderModel(
  model: CommandModel,
  id: string,
  baseURL: string,
): Record<string, unknown> {
  const variants = buildEffortVariants(model);
  const hasEffort = Object.values(variants).some(
    (v) => v && typeof v === "object" && "effort" in v,
  );
  return {
    id,
    providerID: PROVIDER_ID,
    api: {
      id,
      url: baseURL,
      npm: OPENAI_COMPATIBLE_NPM,
    },
    name:
      id === DEFAULT_MODEL_ID && model.id !== DEFAULT_MODEL_ID
        ? `Default (${model.name})`
        : model.name,
    capabilities: {
      temperature: true,
      reasoning: hasEffort,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: model.vision,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: true,
    },
    modalities: {
      input: model.vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    cost: model.cost ?? zeroCost(),
    limit: {
      context: model.contextWindow,
      output: model.maxTokens,
    },
    status: "active",
    options: {
      includeUsage: true,
    },
    headers: {},
    release_date: "",
    variants,
  };
}

function buildConfigModelEntry(model: CommandModel): Record<string, unknown> {
  const variants = buildConfigVariants(model);
  return {
    name: model.name,
    reasoning: model.reasoning,
    tool_call: true,
    modalities: {
      input: model.vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    capabilities: {
      tools: true,
      input: model.vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    limit: {
      context: model.contextWindow,
      output: model.maxTokens,
    },
    options: {
      includeUsage: true,
    },
    variants,
    cost: model.cost ?? zeroCost(),
  };
}

function buildProviderModels(
  models: CommandModel[],
): Record<string, unknown> {
  const baseURL = getCommandProxyBaseUrl();
  const providerModels = Object.fromEntries(
    models.map((model) => [
      model.id,
      buildProviderModel(model, model.id, baseURL),
    ]),
  );
  return providerModels;
}

function ensureProviderConfig(
  config: Record<string, any>,
  models: CommandModel[],
): void {
  if (!config.provider || typeof config.provider !== "object") {
    config.provider = {};
  }
  const existing = config.provider[PROVIDER_ID] ?? {};
  const existingOptions =
    existing.options && typeof existing.options === "object"
      ? existing.options
      : {};
  const existingModels =
    existing.models && typeof existing.models === "object"
      ? existing.models
      : {};

  const baseURL = getCommandProxyBaseUrl();
  const seededModels = Object.fromEntries(
    models.map((model) => [model.id, buildConfigModelEntry(model)]),
  );
  config.provider[PROVIDER_ID] = {
    ...existing,
    name:
      typeof existing.name === "string" && existing.name.trim()
        ? existing.name
        : "Command Code",
    npm: existing.npm ?? OPENAI_COMPATIBLE_NPM,
    options: {
      baseURL,
      apiKey: "command-code-proxy",
      includeUsage: true,
      ...existingOptions,
    },
    models: {
      ...seededModels,
      ...existingModels,
    },
  };
}

async function resolveAccessToken(
  getAuth: () => Promise<unknown>,
): Promise<string | null> {
  const auth = await getAuth();
  if (isCommandAuth(auth)) {
    const key = authKey(auth);
    if (key) return key;
  }

  return readCommandCodeApiKeyFromEnv();
}

async function loadRuntime(
  getAuth: () => Promise<unknown>,
  provider?: { models?: Record<string, unknown> },
): Promise<{ port: number; providerModels: Record<string, unknown> } | undefined> {
  await resolveAccessToken(getAuth);
  const models = await refreshCommandModels();
  await startProxy(async () => resolveAccessToken(getAuth));
  const providerModels = buildProviderModels(models);
  if (provider) provider.models = providerModels;
  return { port: getProxyPort() ?? 8797, providerModels };
}

/**
 * OpenCode plugin that provides Command Code authentication and model access.
 */
export const CommandCodePlugin: Plugin = async (
  _input: PluginInput,
): Promise<Hooks> => {
  return {
    async config(config) {
      // Bind proxy first so provider baseURL matches the actual listening port.
      await startProxy();

      // Always seed the live catalog so the provider is discoverable.
      const models = await refreshCommandModels();
      ensureProviderConfig(config as Record<string, any>, models);

      // Seed native MCP server names (from `mcp:` in opencode config) so the
      // proxy can map tool names <server>_<tool> ↔ mcp__<server>__<tool>.
      // This is what lets the gateway agent see OpenCode's MCP tools and
      // lets OpenCode execute the calls natively via its own MCP clients.
      const mcpConfig = (config as Record<string, any>).mcp;
      if (mcpConfig && typeof mcpConfig === "object") {
        setMcpServers(
          Object.entries(mcpConfig as Record<string, unknown>)
            .filter(([, entry]) => {
              if (!entry || typeof entry !== "object") return true;
              return (entry as { enabled?: unknown }).enabled !== false;
            })
            .map(([name]) => name),
        );
      }
    },

    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      const messageModel = hookInput.message.model as {
        variant?: unknown;
      };
      const variant =
        typeof messageModel.variant === "string"
          ? messageModel.variant
          : undefined;
      const selected = resolveCommandModelSelection(
        hookInput.model.id,
        variant,
      );
      output.headers[EFFORT_HEADER] = encodeCommandModelSelection(selected);
      if (hookInput.sessionID) {
        output.headers[SESSION_HEADER] = hookInput.sessionID;
      }
      if (hookInput.agent === "title") {
        output.headers[REQUEST_KIND_HEADER] = "title";
      }
    },

    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      delete output.options.reasoningEffort;
    },

    "experimental.provider.small_model": async (hookInput, output) => {
      if (hookInput.provider.id !== PROVIDER_ID) return;
      output.model = Object.values(hookInput.provider.models)
        .find((model) => model.id === LAGUNA_MODEL_ID);
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        const runtime = await loadRuntime(
          async () => ctx.auth,
          provider,
        );
        return (runtime?.providerModels ?? {}) as Record<string, any>;
      },
    },

    auth: {
      provider: PROVIDER_ID,

      async loader(getAuth, provider) {
        const runtime = await loadRuntime(getAuth, provider);
        if (!runtime) return {};

        return {
          baseURL: getCommandProxyBaseUrl(),
          apiKey: "command-code-proxy",
          async fetch(
            requestInput: RequestInfo | URL,
            init?: RequestInit,
          ) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization");
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => key.toLowerCase() !== "authorization",
                );
              } else {
                delete (init.headers as Record<string, string>).authorization;
                delete (init.headers as Record<string, string>).Authorization;
              }
            }
            return fetch(requestInput, init);
          },
        };
      },

      methods: [
        {
          type: "oauth",
          label: "Login with Command Code",
          async authorize() {
            let current = getPendingCommandLogin();
            if (!current || current.completed) {
              current = await startCommandBrowserLogin();
            }

            return {
              url: current.url,
              instructions:
                "Open the URL and click Authorize. Return here after the browser says you're all set.",
              method: "auto" as const,
              async callback() {
                try {
                  const tokens = await completeCommandBrowserLogin();
                  await refreshCommandModels();
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh,
                    access: tokens.access,
                    expires: tokens.expires,
                  };
                } catch (err) {
                  resetPendingCommandLogin();
                  log.error(
                    "[opencode-commandcode] Command Code login failed",
                    err instanceof Error ? err.message : err,
                  );
                  return { type: "failed" as const };
                }
              },
            };
          },
        },
      ],
    },
  };
};

export default CommandCodePlugin;

export {
  getCommandModels,
  listCommandCodeModels,
  refreshCommandModels,
  invalidateCommandModelCache,
} from "./models.js";
export {
  startProxy,
  stopProxy,
  getCommandProxyBaseUrl,
  setStreamGenerateForTests,
} from "./proxy.js";
export {
  getSessionUsage,
  listSessionUsage,
  totalUsageAcrossSessions,
  resetUsageStore,
} from "./usage.js";
