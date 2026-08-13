/**
 * OpenCode Command Code Auth Plugin
 *
 * Enables Command Code models inside OpenCode via:
 * 1. Go-plan browser login (`cmd login` style: open URL, then paste the key)
 * 2. Local OpenAI-compatible proxy → api.commandcode.ai /alpha/generate
 * 3. Dynamic model catalog from `cmd --list-models`
 * 4. Tools/MCP park-resume, attachments, compact, and usage accounting
 *
 * Register in opencode.json:
 *   { "plugin": ["@openchamber/opencode-commandcode"] }
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  completeCommandLoginWithCode,
  getPendingCommandLogin,
  resetPendingCommandLogin,
  startCommandBrowserLogin,
  syncCommandCodeCredentialsToOpenCode,
} from "./auth-login.js";
import {
  DEFAULT_MODEL_ID,
  EFFORT_HEADER,
  OPENAI_COMPATIBLE_NPM,
  PROVIDER_ID,
  SESSION_HEADER,
} from "./constants.js";
import { log } from "./log.js";
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
    cost: zeroCost(),
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
  input: PluginInput,
  getAuth: () => Promise<unknown>,
): Promise<string | null> {
  const auth = await getAuth();
  if (isCommandAuth(auth)) {
    const key = authKey(auth);
    if (key) return key;
  }

  const synced = syncCommandCodeCredentialsToOpenCode();
  if (synced) {
    try {
      await input.client.auth.set({
        path: { id: PROVIDER_ID },
        body: {
          type: "api",
          key: synced.key || synced.access,
        },
      });
    } catch {
      // auth.set may be unavailable in some hosts
    }
    return synced.access;
  }
  return null;
}

async function loadRuntime(
  input: PluginInput,
  getAuth: () => Promise<unknown>,
  provider?: { models?: Record<string, unknown> },
): Promise<{ port: number; providerModels: Record<string, unknown> } | undefined> {
  await resolveAccessToken(input, getAuth);
  const models = refreshCommandModels();
  await startProxy(async () => resolveAccessToken(input, getAuth));
  const providerModels = buildProviderModels(models);
  if (provider) provider.models = providerModels;
  return { port: getProxyPort() ?? 8797, providerModels };
}

/**
 * OpenCode plugin that provides Command Code authentication and model access.
 */
export const CommandCodePlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
  try {
    syncCommandCodeCredentialsToOpenCode();
  } catch (err) {
    log.warn(
      "[opencode-commandcode] CLI credential sync skipped",
      err instanceof Error ? err.message : err,
    );
  }

  return {
    async config(config) {
      // Bind proxy first so provider baseURL matches the actual listening port.
      await startProxy(async () => {
        try {
          const authClient = input.client.auth as {
            get?: (args: { path: { id: string } }) => Promise<unknown>;
          };
          if (typeof authClient.get === "function") {
            const auth = await authClient.get({ path: { id: PROVIDER_ID } });
            const payload =
              auth && typeof auth === "object" && "data" in auth
                ? (auth as { data: unknown }).data
                : auth;
            return resolveAccessToken(input, async () => payload);
          }
        } catch {
          // ignore
        }
        const synced = syncCommandCodeCredentialsToOpenCode();
        return synced?.access ?? null;
      });

      // Always seed the live catalog so the provider is discoverable.
      refreshCommandModels();
      ensureProviderConfig(config as Record<string, any>, getCommandModels());
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
    },

    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      delete output.options.reasoningEffort;
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        const runtime = await loadRuntime(
          input,
          async () => ctx.auth,
          provider,
        );
        return (runtime?.providerModels ?? {}) as Record<string, any>;
      },
    },

    auth: {
      provider: PROVIDER_ID,

      async loader(getAuth, provider) {
        const runtime = await loadRuntime(input, getAuth, provider);
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
          label: "Login with Command Code (Go $1)",
          async authorize() {
            // Prefer already-logged-in CLI session from `cmd login`.
            const synced = syncCommandCodeCredentialsToOpenCode();
            if (synced) {
              return {
                url: "https://commandcode.ai/docs/plans/go",
                instructions:
                  "Command Code Go-plan session found (from `cmd login`). Click Complete — no paste needed.",
                method: "auto" as const,
                async callback() {
                  return {
                    type: "success" as const,
                    refresh: synced.refresh,
                    access: synced.access,
                    expires: synced.expires,
                  };
                },
              };
            }

            let current = getPendingCommandLogin();
            if (!current || current.completed) {
              current = await startCommandBrowserLogin();
            }

            return {
              url: current.url,
              instructions:
                "Open the URL, click Authorize, then paste the API key Studio shows (or paste ok if the browser says you're all set). Same flow as `cmd login`.",
              method: "code" as const,
              async callback(code: string) {
                try {
                  const tokens = await completeCommandLoginWithCode(code);
                  refreshCommandModels();
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh,
                    access: tokens.access,
                    expires: tokens.expires,
                  };
                } catch (err) {
                  resetPendingCommandLogin();
                  log.error(
                    "[opencode-commandcode] Go-plan login failed",
                    err instanceof Error ? err.message : err,
                  );
                  return { type: "failed" as const };
                }
              },
            };
          },
        },
        {
          type: "oauth",
          label: "Use existing `cmd login` session",
          async authorize() {
            return {
              url: "https://commandcode.ai/docs/quickstart",
              instructions:
                "If you already ran `npm i -g command-code@latest && cmd login` (Go $1 plan), click Complete to sync ~/.commandcode/auth.json.",
              method: "auto" as const,
              async callback() {
                const again = syncCommandCodeCredentialsToOpenCode();
                if (!again) return { type: "failed" as const };
                return {
                  type: "success" as const,
                  refresh: again.refresh,
                  access: again.access,
                  expires: again.expires,
                };
              },
            };
          },
        },
      ],
    },
  };
};

export default CommandCodePlugin;

export { detectCommandCode } from "./detect.js";
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
