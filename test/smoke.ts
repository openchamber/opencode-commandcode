/**
 * Smoke + mocked gateway tests for opencode-commandcode.
 * Covers attachments, tools/MCP park-resume, compact, and usage — no live API required.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

async function main() {
  const {
    readCommandCodeApiKeyFromEnv,
  } = await import("../src/credentials.ts");
  const {
    buildEffortVariants,
    getCommandModels,
    refreshCommandModels,
    invalidateCommandModelCache,
    isLoginPlaceholderModel,
    resolveCommandModelId,
    findCommandModel,
  } = await import("../src/models.ts");
  const {
    discoverCommandModels,
    parseProviderModelCatalog,
  } = await import("../src/model-discover.ts");
  const {
    encodeCommandModelSelection,
    decodeCommandModelSelection,
    resolveCommandModelSelection,
  } = await import("../src/model-selection.ts");
  const {
    isCommandEffort,
    PROVIDER_ID,
    EFFORT_LEVELS,
    LAGUNA_MODEL_ID,
    DEFAULT_MODEL_ID,
  } = await import("../src/constants.ts");
  const { CommandCodePlugin, commandCodeMetadataExtractor } = await import("../src/index.ts");
  const {
    buildCommandAuthUrl,
    startCommandBrowserLogin,
    resetPendingCommandLogin,
    completeCommandBrowserLogin,
  } = await import("../src/auth-login.ts");
  const {
    startProxy,
    stopProxy,
    getProxyPort,
    getCommandProxyBaseUrl,
    setStreamGenerateForTests,
  } = await import("../src/proxy.ts");
  const {
    openaiContentToUserParts,
    openaiMessagesToWire,
    openaiToolsToWire,
    contentHasAttachments,
  } = await import("../src/prompt.ts");
  const {
    assessContext,
    compactWireMessages,
    estimateMessageTokens,
  } = await import("../src/compact.ts");
  const {
    resetUsageStore,
    recordTurnUsage,
    recordToolCall,
    getSessionUsage,
    totalUsageAcrossSessions,
    usageToOpenAI,
    withEstimatedCost,
  } = await import("../src/usage.ts");
  const { costFromProviderMetadata, usageFromFinishEvent } = await import("../src/gateway-types.ts");
  const {
    mapStreamEvent,
    buildGenerateBody,
    buildAuthHeaders,
    commandRetryDelayMs,
    isRetryableGatewayError,
    streamGenerate,
  } = await import(
    "../src/gateway.ts"
  );
  const {
    setMcpServers,
    getMcpServers,
    toWireName,
    toNativeName,
    isNativeMcpName,
    resetMcpNamesForTests,
  } = await import("../src/mcp-names.ts");

  // --- credentials ---
  assert.equal(
    readCommandCodeApiKeyFromEnv({ COMMAND_CODE_API_KEY: " tok " }),
    "tok",
  );
  assert.equal(readCommandCodeApiKeyFromEnv({}), null);

  // --- models (dynamic catalog) ---
  invalidateCommandModelCache();
  const models = await refreshCommandModels({
    fetchFn: async () => new Response(JSON.stringify({
      data: [
        {
          id: LAGUNA_MODEL_ID,
          name: "Laguna S 2.1",
          context_length: 256_000,
        },
        {
          id: "deepseek/deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          context_length: 1_000_000,
        },
      ],
    })),
  });
  assert.ok(models.length >= 1, "expected at least one discovered model");
  assert.equal(isLoginPlaceholderModel("login"), true);
  if (models.some((m) => m.resolvedId === LAGUNA_MODEL_ID)) {
    assert.equal(resolveCommandModelId("laguna"), LAGUNA_MODEL_ID);
    assert.equal(resolveCommandModelId("laguna-s-2.1-free"), LAGUNA_MODEL_ID);
    assert.equal(resolveCommandModelId(DEFAULT_MODEL_ID), LAGUNA_MODEL_ID);
    const laguna = findCommandModel("laguna")!;
    assert.equal(laguna.vision, false);
    assert.equal(laguna.free, true);
    assert.equal(laguna.contextWindow, 256_000);
    const variants = buildEffortVariants(laguna);
    assert.equal(typeof variants, "object");
  }
  assert.equal(
    new Set(models.map((m) => m.resolvedId.toLowerCase())).size,
    models.length,
    "catalog must expose each upstream model exactly once (no alias duplicates)",
  );
  assert.equal(
    models.filter((m) => m.resolvedId === LAGUNA_MODEL_ID).length,
    1,
    "Laguna must appear once in the picker",
  );

  assert.deepEqual(parseProviderModelCatalog({
    object: "list",
    data: [
      { id: "model/a", name: "Model A", context_length: 1_000_000 },
      { id: "", name: "invalid" },
    ],
  }), [{ id: "model/a", name: "Model A", contextLength: 1_000_000 }]);
  const fetched = await discoverCommandModels({
    fetchFn: async () => new Response(JSON.stringify({
      data: [{ id: "model/a", name: "Model A", context_length: 128_000 }],
    })),
  });
  assert.equal(fetched[0]?.id, "model/a");
  assert.equal(fetched[0]?.contextWindow, 128_000);

  const selection = resolveCommandModelSelection("laguna", "high");
  const encoded = encodeCommandModelSelection(selection);
  const decoded = decodeCommandModelSelection(encoded);
  assert.equal(decoded?.modelId, LAGUNA_MODEL_ID);
  assert.equal(decoded?.effort, "high");
  assert.equal(PROVIDER_ID, "command-code");
  for (const level of EFFORT_LEVELS) {
    assert.equal(isCommandEffort(level), true);
  }
  assert.ok(getCommandModels().length >= 1);

  // --- attachments (text-only Laguna strips images; files/pdfs inlined) ---
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const imageParts = openaiContentToUserParts(
    [
      { type: "text", text: "what color?" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${png}` },
      },
    ],
    false,
  );
  assert.ok(imageParts.some((p) => p.type === "text"));
  assert.ok(
    imageParts.some(
      (p) => p.type === "text" && p.text.includes("image omitted"),
    ),
  );
  assert.equal(
    imageParts.some((p) => p.type === "image"),
    false,
  );

  const visionParts = openaiContentToUserParts(
    [
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${png}` },
      },
    ],
    true,
  );
  assert.ok(visionParts.some((p) => p.type === "image"));

  const textFileB64 = Buffer.from("hello from attachment\nline2", "utf8").toString(
    "base64",
  );
  const fileParts = openaiContentToUserParts(
    [
      {
        type: "file",
        file: {
          filename: "notes.txt",
          media_type: "text/plain",
          data: textFileB64,
        },
      },
    ],
    false,
  );
  assert.ok(
    fileParts.some(
      (p) => p.type === "text" && p.text.includes("hello from attachment"),
    ),
  );

  const pdfParts = openaiContentToUserParts(
    [
      {
        type: "input_file",
        filename: "doc.pdf",
        media_type: "application/pdf",
        data: Buffer.from("%PDF-1.4").toString("base64"),
      },
    ],
    false,
  );
  assert.ok(
    pdfParts.some((p) => p.type === "text" && p.text.includes("attached_pdf")),
  );

  assert.equal(
    contentHasAttachments([
      { type: "image_url", image_url: { url: "x" } },
    ]),
    true,
  );

  const wired = openaiMessagesToWire(
    [
      { role: "system", content: "be concise" },
      {
        role: "user",
        content: [
          { type: "text", text: "summarize" },
          {
            type: "file",
            file: {
              filename: "a.md",
              media_type: "text/markdown",
              data: Buffer.from("# Title").toString("base64"),
            },
          },
        ],
      },
    ],
    { vision: false },
  );
  assert.equal(wired.system, "be concise");
  assert.ok(wired.messages.length >= 1);

  const tools = openaiToolsToWire([
    {
      type: "function",
      function: {
        name: "bash",
        description: "run shell",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mcp__filesystem__read",
        description: "mcp read",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.name, "bash");

  // --- MCP tool-name mapping (OpenCode native <-> Command Code wire) ---
  resetMcpNamesForTests();
  setMcpServers(["linear", "filesystem"]);
  assert.deepEqual([...getMcpServers()].sort(), ["filesystem", "linear"]);
  assert.equal(toWireName("linear_list_issues"), "mcp__linear__list_issues");
  assert.equal(toWireName("filesystem_read"), "mcp__filesystem__read");
  assert.equal(toWireName("bash"), "bash");
  assert.equal(toWireName("mcp__linear__list_issues"), "mcp__linear__list_issues");
  assert.equal(toNativeName("mcp__linear__list_issues"), "linear_list_issues");
  assert.equal(toNativeName("mcp__filesystem__read"), "filesystem_read");
  assert.equal(toNativeName("mcp__unknown__thing"), "mcp__unknown__thing");
  assert.equal(toNativeName("bash"), "bash");
  assert.equal(isNativeMcpName("linear_get_issue"), true);
  assert.equal(isNativeMcpName("bash"), false);

  // Wire conversion must rename MCP tools so the gateway agent sees them.
  const mappedTools = openaiToolsToWire([
    {
      type: "function",
      function: {
        name: "linear_list_issues",
        description: "list issues",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "bash",
        description: "shell",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  assert.equal(mappedTools[0]?.name, "mcp__linear__list_issues");
  assert.equal(mappedTools[1]?.name, "bash");

  // History conversion must rename MCP tool calls/results consistently.
  const wiredHistory = openaiMessagesToWire(
    [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "linear_list_issues", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "linear_list_issues",
        content: "[]",
      },
    ],
    { vision: false },
  );
  const histAssistant = wiredHistory.messages.find((m) => m.role === "assistant");
  const histToolCall = (histAssistant?.content as Array<{ toolName?: string }>)?.[0];
  assert.equal(histToolCall?.toolName, "mcp__linear__list_issues");
  const histTool = wiredHistory.messages.find((m) => m.role === "tool");
  const histResult = (histTool?.content as Array<{ toolName?: string }>)?.[0];
  assert.equal(histResult?.toolName, "mcp__linear__list_issues");
  resetMcpNamesForTests();

  // --- compact / context ---
  const adviceOk = assessContext(10_000, 256_000);
  assert.equal(adviceOk.tier, "ok");
  const adviceWarn = assessContext(210_000, 256_000);
  assert.equal(adviceWarn.tier, "warn");
  const adviceAuto = assessContext(240_000, 256_000);
  assert.equal(adviceAuto.shouldCompact, true);

  const longMsgs = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content:
      i % 2 === 0
        ? [{ type: "text" as const, text: `user ${i} ${"x".repeat(200)}` }]
        : [{ type: "text" as const, text: `asst ${i}` }],
  }));
  // insert tool results
  longMsgs.push({
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: "c1",
        toolName: "bash",
        output: { type: "text" as const, value: "old result ".repeat(50) },
      },
    ],
  } as any);
  const compacted = compactWireMessages(longMsgs as any, {
    sessionId: "sess-compact",
    keepTurns: 10,
    keepToolResults: 0,
  });
  assert.equal(compacted.compacted, true);
  assert.ok(estimateMessageTokens(wired.messages) > 0);

  // --- usage + mcp accounting ---
  resetUsageStore();
  recordTurnUsage(
    "sess-1",
    LAGUNA_MODEL_ID,
    256_000,
    {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
    },
  );
  recordToolCall("sess-1", "bash");
  recordToolCall("sess-1", "bash");
  recordToolCall("sess-1", "mcp__filesystem__read");
  const snap = getSessionUsage("sess-1")!;
  assert.equal(snap.usage.inputTokens, 100);
  assert.equal(snap.tools.find((t) => t.name === "bash")?.calls, 2);
  assert.equal(snap.tools.find((t) => t.name === "mcp__filesystem__read")?.mcp, true);
  const openaiUsage = usageToOpenAI(totalUsageAcrossSessions());
  // OpenAI contract: prompt_tokens is inclusive of cache read/write
  // (Command Code inputTokens excludes them, so 100 + 20 + 5 = 125).
  assert.equal(openaiUsage.prompt_tokens, 125);
  assert.equal(openaiUsage.completion_tokens, 50);
  assert.equal(openaiUsage.total_tokens, 175);
  assert.equal(openaiUsage.prompt_tokens_details?.cached_tokens, 20);
  assert.equal(openaiUsage.prompt_tokens_details?.cache_write_tokens, 5);

  const finishUsage = usageFromFinishEvent({
    totalUsage: {
      inputTokens: 100,
      outputTokens: 20,
      inputTokenDetails: { cacheReadTokens: 10, cacheWriteTokens: 5 },
      costUSD: 0.0012,
    },
  });
  assert.equal(finishUsage.inputTokens, 100);
  assert.equal(finishUsage.cacheReadTokens, 10);
  assert.equal(finishUsage.costUsd, 0.0012);
  const finishOpenAI = usageToOpenAI(finishUsage);
  assert.equal(finishOpenAI.prompt_tokens, 115);
  assert.equal(finishOpenAI.cost_usd, 0.0012);
  assert.equal(costFromProviderMetadata({
    providerMetadata: { gateway: { cost: "0.0042" } },
  }), 0.0042);
  const metadataExtractor = commandCodeMetadataExtractor().createStreamExtractor();
  metadataExtractor.processChunk({ usage: { cost_usd: 0.0042 } });
  assert.deepEqual(metadataExtractor.buildMetadata(), {
    copilot: { totalNanoAiu: 420_000_000 },
  });

  const estimated = withEstimatedCost(
    {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    { input: 0.435, output: 0.87, cache: { read: 0.003625, write: 0 } },
  );
  assert.equal(estimated.costUsd, 1.305);

  // --- gateway helpers ---
  const headers = buildAuthHeaders({ apiKey: "test-key", sessionId: "s1" });
  assert.equal(headers.Authorization, "Bearer test-key");
  assert.equal(headers["x-session-id"], "s1");
  assert.equal(commandRetryDelayMs(0), 1_000);
  assert.equal(commandRetryDelayMs(9), 10_000);
  assert.equal(isRetryableGatewayError({ status: 429 }), true);
  assert.equal(isRetryableGatewayError({ status: 503 }), true);
  assert.equal(isRetryableGatewayError({ status: 401 }), false);
  assert.equal(
    isRetryableGatewayError({ message: "Service temporarily unavailable" }),
    true,
  );
  assert.equal(
    isRetryableGatewayError({ message: "premium_credits_exhausted" }),
    false,
  );
  const body = buildGenerateBody({
    apiKey: "test-key",
    model: LAGUNA_MODEL_ID,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
  });
  assert.equal(body.params.model, LAGUNA_MODEL_ID);
  assert.equal(body.params.stream, true);
  assert.equal(body.skills, null, "match current Command Code CLI gateway body");
  assert.equal(body.config.isGitRepo, true);
  assert.ok(body.config.currentBranch);

  assert.deepEqual(mapStreamEvent({ type: "text-delta", text: "Hi" }), {
    kind: "text",
    text: "Hi",
  });
  assert.equal(mapStreamEvent({ type: "tool-call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } }).kind, "tool_call");
  assert.equal(
    mapStreamEvent({
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 1, outputTokens: 2 },
    }).kind,
    "finish",
  );

  const finishMapped = mapStreamEvent({
    type: "finish",
    finishReason: "stop",
    totalUsage: {
      inputTokens: 50,
      outputTokens: 10,
      reasoningTokens: 3,
      inputTokenDetails: { cacheReadTokens: 5, cacheWriteTokens: 2 },
      costUSD: 0.01,
    },
  });
  assert.equal(finishMapped.kind, "finish");
  if (finishMapped.kind === "finish") {
    assert.equal(finishMapped.usage.inputTokens, 50);
    assert.equal(finishMapped.usage.cacheReadTokens, 5);
    assert.equal(finishMapped.usage.cacheWriteTokens, 2);
    assert.equal(finishMapped.usage.reasoningTokens, 3);
    assert.equal(finishMapped.usage.costUsd, 0.01);
    const openai = usageToOpenAI(finishMapped.usage);
    // prompt_tokens follows the OpenAI contract: inclusive of cached tokens
    // (Command Code inputTokens excludes them, so 50 + 5 + 2 = 57).
    assert.equal(openai.prompt_tokens, 57);
    assert.equal(openai.completion_tokens, 10);
    assert.equal(openai.total_tokens, 67);
    assert.equal(openai.prompt_tokens_details?.cached_tokens, 5);
    assert.equal(openai.prompt_tokens_details?.cache_write_tokens, 2);
    assert.equal(openai.completion_tokens_details?.reasoning_tokens, 3);
    assert.equal(openai.cost_usd, 0.01);
  }

  const billedEvents = [];
  for await (const event of streamGenerate({
    apiKey: "test-key",
    model: LAGUNA_MODEL_ID,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    postStream: async () => new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 5, outputTokens: 2 },
        })}\n`));
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: "provider-metadata",
          providerMetadata: { gateway: { cost: "0.006" } },
        })}\n`));
        controller.close();
      },
    }),
  })) billedEvents.push(event);
  const billedFinish = billedEvents.find((event) => event.kind === "finish");
  assert.equal(billedFinish?.kind === "finish" ? billedFinish.usage.costUsd : undefined, 0.006);

  // CLI-compatible retry: transient stream error before visible output is
  // discarded, then the exact same request is retried.
  {
    let calls = 0;
    const retryEvents: string[] = [];
    for await (const event of streamGenerate({
      apiKey: "test-key",
      model: LAGUNA_MODEL_ID,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      postStream: async () => {
        calls++;
        const lines =
          calls === 1
            ? [{
                type: "error",
                error: {
                  message: "Service temporarily unavailable",
                  statusCode: 503,
                  isRetryable: true,
                },
              }]
            : [
                { type: "text-delta", text: "retry-ok" },
                { type: "finish", finishReason: "stop" },
              ];
        return new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            for (const line of lines) {
              controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
            }
            controller.close();
          },
        });
      },
    })) {
      if (event.kind === "text") retryEvents.push(event.text);
    }
    assert.equal(calls, 2);
    assert.deepEqual(retryEvents, ["retry-ok"]);
  }

  // --- Browser OAuth URL ---
  const authUrl = buildCommandAuthUrl(5959, "test-state");
  assert.ok(authUrl.includes("commandcode.ai/studio/auth/cli"));
  assert.ok(authUrl.includes("callback="));
  assert.ok(authUrl.includes("localhost%3A5959") || authUrl.includes("localhost:5959"));
  assert.ok(authUrl.includes("state=test-state"));

  const pendingLogin = await startCommandBrowserLogin();
  const completion = completeCommandBrowserLogin();
  assert.ok(pendingLogin.url.includes("/studio/auth/cli"));
  assert.ok(pendingLogin.port >= 5959);
  // Callback server must answer Private Network Access preflight (Studio → localhost).
  try {
    const preflight = await fetch(
      `http://127.0.0.1:${pendingLogin.port}/callback`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://commandcode.ai",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Private-Network": "true",
        },
      },
    );
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "https://commandcode.ai",
    );
    assert.equal(
      preflight.headers.get("access-control-allow-private-network"),
      "true",
    );
    // Simulate Studio POST; callback returns tokens for OpenCode to persist.
    const post = await fetch(
      `http://127.0.0.1:${pendingLogin.port}/callback`,
      {
        method: "POST",
        headers: {
          Origin: "https://commandcode.ai",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          apiKey: "test-session-key-from-studio-callback",
          userId: "user_test",
          userName: "Test User",
          keyName: "opencode-oauth",
          state: pendingLogin.state,
        }),
      },
    );
    assert.equal(post.status, 200);
    const tokens = await completion;
    assert.equal(tokens.access, "test-session-key-from-studio-callback");
    assert.equal(tokens.key, "test-session-key-from-studio-callback");
  } finally {
    resetPendingCommandLogin();
  }

  // --- plugin auth method: automatic browser callback, no standalone API-key method ---
  {
    const hooks = await CommandCodePlugin({} as any);
    assert.ok(hooks.auth);
    const methods = hooks.auth!.methods;
    assert.equal(methods.length, 1);
    assert.ok(
      !methods.some(
        (m: any) =>
          m.type === "api" ||
          (typeof m.label === "string" &&
            m.label.toLowerCase().includes("enter command code api key")),
      ),
      "standalone Enter API key method must not be registered",
    );
    const goLogin = methods.find(
      (m: any) =>
        m.type === "oauth" &&
        typeof m.label === "string" &&
        m.label.includes("Login with Command Code"),
    ) as any;
    assert.ok(goLogin, "Go login oauth method missing");
    // Browser login completes through the local callback, so OpenCode must call
    // the plugin callback immediately and wait rather than ask for a pasted code.
    const authStart = await goLogin.authorize();
    assert.ok(authStart.url);
    assert.equal(authStart.method, "auto");
    if (authStart.url.includes("/studio/auth/cli")) {
      assert.ok(
        !/paste/i.test(authStart.instructions || ""),
        "automatic callback instructions must not ask for a pasted code",
      );
    }
    resetPendingCommandLogin();

    const lagunaModel = { id: LAGUNA_MODEL_ID, providerID: PROVIDER_ID };
    const smallOutput: { model?: unknown } = {};
    await hooks["experimental.provider.small_model"]!(
      { provider: { id: PROVIDER_ID, models: { [LAGUNA_MODEL_ID]: lagunaModel } } } as any,
      smallOutput as any,
    );
    assert.equal(smallOutput.model, lagunaModel);
    const otherOutput: { model?: unknown } = {};
    await hooks["experimental.provider.small_model"]!(
      { provider: { id: "other", models: { [LAGUNA_MODEL_ID]: lagunaModel } } } as any,
      otherOutput as any,
    );
    assert.equal(otherOutput.model, undefined);

    const titleHeaders = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]!(
      {
        sessionID: "title-session",
        agent: "title",
        model: { providerID: PROVIDER_ID, id: LAGUNA_MODEL_ID },
        message: { model: {} },
      } as any,
      titleHeaders,
    );
    assert.equal(titleHeaders.headers["x-opencode-commandcode-request-kind"], "title");
  }

  // --- plugin export ---
  assert.equal(typeof CommandCodePlugin, "function");
  assert.equal(PROVIDER_ID, "command-code");

  // --- proxy health + mocked chat (text, tools, usage, attachments) ---
  await stopProxy();
  resetUsageStore();

  const capturedGenerateParams: Array<Record<string, unknown>> = [];
  setStreamGenerateForTests(async function* (params) {
    capturedGenerateParams.push(params as unknown as Record<string, unknown>);
    // Simulate tool-call then finish on first turn with tools; plain text otherwise.
    const last = params.messages[params.messages.length - 1];
    const hasToolResult =
      last?.role === "tool" ||
      params.messages.some((m) => m.role === "tool");

    if (params.tools && params.tools.length > 0 && !hasToolResult) {
      yield {
        kind: "text",
        text: "Calling tool…",
      };
      yield {
        kind: "tool_call",
        id: "call_test_bash_1",
        name: "bash",
        arguments: JSON.stringify({ command: "echo hi" }),
      };
      yield {
        kind: "finish",
        finishReason: "tool_calls",
        usage: {
          inputTokens: 40,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
      return;
    }

    if (hasToolResult) {
      yield { kind: "text", text: "Tool said hi." };
      yield {
        kind: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: 60,
          outputTokens: 8,
          cacheReadTokens: 4,
          cacheWriteTokens: 0,
        },
      };
      return;
    }

    // Attachment-aware reply
    const blob = JSON.stringify(params.messages);
    if (blob.includes("attached_file") || blob.includes("attached_pdf") || blob.includes("image omitted")) {
      yield { kind: "text", text: "Saw your attachment." };
    } else {
      yield { kind: "reasoning", text: "thinking…" };
      yield { kind: "text", text: "Laguna hello." };
    }
    yield {
      kind: "finish",
      finishReason: "stop",
      usage: {
        inputTokens: 25,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  });

  const port = await startProxy(async () => "test-api-key");
  await startProxy();
  assert.ok(port > 0);
  assert.equal(getProxyPort(), port);
  assert.ok(getCommandProxyBaseUrl().includes(String(port)));

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);

  const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(modelsRes.status, 200);
  const modelsJson = (await modelsRes.json()) as { data: Array<{ id: string }> };
  assert.ok(modelsJson.data.some((m) => m.id.includes("laguna")));

  // Plain completion
  const chat1 = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-commandcode-session": "test-sess-plain",
    },
    body: JSON.stringify({
      model: "command-code/laguna-s-2.1-free",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Say hi" }],
    }),
  });
  assert.equal(chat1.status, 200);
  const chat1Text = await chat1.text();
  assert.ok(chat1Text.includes("Laguna hello."));
  assert.ok(chat1Text.includes("usage"));
  assert.ok(chat1Text.includes("[DONE]"));

  // Title generation uses the dedicated utility mode and no agent state.
  const titleResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-commandcode-session": "test-sess-title",
      "x-opencode-commandcode-request-kind": "title",
    },
    body: JSON.stringify({
      model: "laguna-s-2.1-free",
      stream: true,
      messages: [
        { role: "system", content: "You generate short session titles." },
        { role: "user", content: "Generate a title for this conversation:\nFix OAuth loading" },
      ],
      tools: [{ type: "function", function: { name: "should_not_run", parameters: {} } }],
    }),
  });
  assert.equal(titleResponse.status, 200);
  await titleResponse.text();
  const titleParams = capturedGenerateParams.at(-1)!;
  assert.equal(titleParams.mode, "title-gen");
  assert.equal(titleParams.sessionId, "title:test-sess-title");
  assert.equal(titleParams.maxTokens, 128);
  assert.deepEqual(titleParams.tools, []);
  assert.equal(titleParams.skills, undefined);
  assert.equal(titleParams.effort, undefined);

  // Attachment completion
  const chatAtt = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-commandcode-session": "test-sess-att",
    },
    body: JSON.stringify({
      model: "laguna",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read this" },
            {
              type: "file",
              file: {
                filename: "note.txt",
                media_type: "text/plain",
                data: Buffer.from("secret-note-content").toString("base64"),
              },
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${png}` },
            },
          ],
        },
      ],
    }),
  });
  assert.equal(chatAtt.status, 200);
  const attJson = (await chatAtt.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number };
  };
  assert.ok(attJson.choices[0]?.message.content.includes("attachment"));
  assert.ok(attJson.usage);

  // Tools park + resume
  const chatTools = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-commandcode-session": "test-sess-tools",
    },
    body: JSON.stringify({
      model: "laguna-s-2.1-free",
      stream: true,
      messages: [{ role: "user", content: "run echo" }],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "shell",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "mcp__demo__ping",
            description: "mcp ping",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    }),
  });
  assert.equal(chatTools.status, 200);
  const toolsText = await chatTools.text();
  assert.ok(toolsText.includes("call_test_bash_1"));
  assert.ok(toolsText.includes("tool_calls") || toolsText.includes('"bash"'));
  assert.ok(
    toolsText.includes('"prompt_tokens"') && !toolsText.includes('"prompt_tokens":0'),
    "parked tool-call turn must forward non-zero usage",
  );

  const chatResume = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-commandcode-session": "test-sess-tools",
    },
    body: JSON.stringify({
      model: "laguna-s-2.1-free",
      stream: true,
      messages: [
        { role: "user", content: "run echo" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_test_bash_1",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "echo hi" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_test_bash_1",
          content: "hi",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "shell",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
    }),
  });
  assert.equal(chatResume.status, 200);
  const resumeText = await chatResume.text();
  assert.ok(resumeText.includes("Tool said hi."));

  // Usage endpoint
  const usageRes = await fetch(`http://127.0.0.1:${port}/v1/usage`);
  assert.equal(usageRes.status, 200);
  const usageJson = (await usageRes.json()) as {
    total: { prompt_tokens: number; completion_tokens: number };
    sessions: unknown[];
  };
  assert.ok(usageJson.total.prompt_tokens > 0);
  assert.ok(Array.isArray(usageJson.sessions));
  assert.ok(usageJson.sessions.length > 0);

  const sessUsage = await fetch(
    `http://127.0.0.1:${port}/v1/usage/session/test-sess-tools`,
  );
  assert.equal(sessUsage.status, 200);
  const sessJson = (await sessUsage.json()) as {
    tools: Array<{ name: string; mcp: boolean; calls: number }>;
  };
  assert.ok(sessJson.tools.some((t) => t.name === "bash"));

  await stopProxy();

  // Dynamic port: when preferred 8797 is occupied by a non-proxy listener,
  // startProxy must bind another free port (not fail).
  {
    delete process.env.OPENCODE_COMMANDCODE_PROXY_PORT;
    let blocker: ReturnType<typeof Bun.serve> | null = null;
    try {
      try {
        blocker = Bun.serve({
          hostname: "127.0.0.1",
          port: 8797,
          fetch() {
            return new Response("blocked");
          },
        });
      } catch {
        // Another OpenCode process may already own the preferred port.
      }
      const dynPort = await startProxy(async () => "test-api-key");
      assert.ok(dynPort > 0);
      assert.notEqual(dynPort, 8797);
      assert.ok(getCommandProxyBaseUrl().includes(String(dynPort)));
      const healthDyn = await fetch(`http://127.0.0.1:${dynPort}/health`);
      assert.equal(healthDyn.status, 200);
      await stopProxy();
    } finally {
      blocker?.stop(true);
    }
  }

  // TypeScript build
  const build = spawnSync("bun", ["run", "build"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  if (build.status !== 0) {
    console.error(build.stdout);
    console.error(build.stderr);
    throw new Error("build failed");
  }

  console.log("ok — opencode-commandcode smoke tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
