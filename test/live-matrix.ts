/**
 * Comprehensive live matrix against Laguna S 2.1 via the local proxy.
 * Requires Go-plan session (`cmd login` → ~/.commandcode/auth.json).
 *
 *   bun run test:live:matrix
 */
import assert from "node:assert/strict";
import { readCommandCodeCredentials } from "../src/credentials.ts";
import { LAGUNA_MODEL_ID, SESSION_HEADER } from "../src/constants.ts";
import {
  startProxy,
  stopProxy,
  setStreamGenerateForTests,
} from "../src/proxy.ts";
import { resetUsageStore, getSessionUsage } from "../src/usage.ts";
import { clearBridges } from "../src/bridge-pool.ts";

type CaseResult = { name: string; ok: boolean; detail?: string; ms: number };

function requireAuth(): string {
  const creds = readCommandCodeCredentials();
  if (!creds?.apiKey) {
    console.error("Skipping: run `cmd login` (Go plan). No Studio API key.");
    process.exit(0);
  }
  return creds.apiKey;
}

async function assertOk(res: Response, label: string): Promise<string> {
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`${label}: ${res.status}\n${text.slice(0, 2500)}`);
  }
  return text;
}

function sseAssistantText(sse: string): string {
  let out = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const chunk = JSON.parse(raw) as {
        choices?: Array<{
          delta?: { content?: string; reasoning_content?: string };
          message?: { content?: string; reasoning_content?: string };
        }>;
      };
      const choice = chunk.choices?.[0];
      const d = choice?.delta;
      const m = choice?.message;
      if (typeof d?.content === "string") out += d.content;
      if (typeof d?.reasoning_content === "string") out += d.reasoning_content;
      if (typeof m?.content === "string") out += m.content;
      if (typeof m?.reasoning_content === "string") out += m.reasoning_content;
    } catch {
      // ignore
    }
  }
  return out;
}

function extractToolCalls(sse: string): Array<{
  id: string;
  name: string;
  arguments: string;
}> {
  const byIndex = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const chunk = JSON.parse(raw) as {
        choices?: Array<{
          delta?: {
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      for (const tc of chunk.choices?.[0]?.delta?.tool_calls || []) {
        const idx = tc.index ?? 0;
        const cur = byIndex.get(idx) || { id: "", name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        byIndex.set(idx, cur);
      }
    } catch {
      // ignore
    }
  }
  return [...byIndex.values()].filter((t) => t.id && t.name);
}

function messageContent(raw: string, stream: boolean): string {
  if (stream) return sseAssistantText(raw);
  const json = JSON.parse(raw) as {
    choices?: Array<{
      message?: { content?: string; reasoning_content?: string };
    }>;
  };
  const m = json.choices?.[0]?.message;
  return `${m?.content || ""}${m?.reasoning_content || ""}`;
}

async function chat(
  base: string,
  opts: {
    session: string;
    model?: string;
    stream?: boolean;
    messages: unknown[];
    tools?: unknown[];
  },
): Promise<string> {
  const stream = opts.stream !== false;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SESSION_HEADER]: opts.session,
    },
    body: JSON.stringify({
      model: opts.model || LAGUNA_MODEL_ID,
      stream,
      stream_options: { include_usage: true },
      messages: opts.messages,
      ...(opts.tools ? { tools: opts.tools } : {}),
    }),
  });
  return assertOk(res, opts.session);
}

async function runCase(
  name: string,
  fn: () => Promise<string | void>,
  results: CaseResult[],
): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = (await fn()) || undefined;
    const ms = Date.now() - t0;
    results.push({ name, ok: true, detail, ms });
    console.log(`✓ ${name} (${ms}ms)${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    const ms = Date.now() - t0;
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail, ms });
    console.error(`✗ ${name} (${ms}ms)\n  ${detail.slice(0, 800)}`);
  }
}

const TOOL_ECHO = {
  type: "function",
  function: {
    name: "echo_payload",
    description: "Echo a string payload back to the model",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
};

const TOOL_ADD = {
  type: "function",
  function: {
    name: "add_numbers",
    description: "Add two integers",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
  },
};

const TOOL_MCPISH = {
  type: "function",
  function: {
    name: "mcp_filesystem_read",
    description: "Read a small text file from the workspace (MCP-style name)",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

async function main() {
  const apiKey = requireAuth();
  setStreamGenerateForTests(null);
  resetUsageStore();
  clearBridges();
  await stopProxy();

  const port = await startProxy(async () => apiKey);
  const base = `http://127.0.0.1:${port}`;
  const results: CaseResult[] = [];

  // ── 1. Plain / aliases / stream modes ───────────────────────────────────
  await runCase("plain stream marker", async () => {
    const raw = await chat(base, {
      session: "mx-plain",
      messages: [
        {
          role: "user",
          content: "Reply with exactly: MATRIX-PLAIN-OK",
        },
      ],
    });
    const text = messageContent(raw, true);
    assert.ok(/MATRIX-PLAIN-OK/i.test(text), text.slice(0, 500));
    return `chars=${text.length}`;
  }, results);

  await runCase("non-stream alias laguna", async () => {
    const raw = await chat(base, {
      session: "mx-alias",
      model: "laguna",
      stream: false,
      messages: [
        { role: "user", content: "Reply with exactly: ALIAS-OK" },
      ],
    });
    const text = messageContent(raw, false);
    assert.ok(/ALIAS-OK/i.test(text), text.slice(0, 500));
  }, results);

  await runCase("system + multi-turn memory", async () => {
    const raw = await chat(base, {
      session: "mx-memory",
      messages: [
        {
          role: "system",
          content: "You are a terse test bot. Always end with TOKEN=NEBULA.",
        },
        { role: "user", content: "Remember the codeword NEBULA." },
        {
          role: "assistant",
          content: "Understood. I will remember NEBULA. TOKEN=NEBULA",
        },
        {
          role: "user",
          content:
            "What codeword did I ask you to remember? Reply with only that word, then TOKEN=NEBULA.",
        },
      ],
    });
    const text = messageContent(raw, true);
    assert.ok(/NEBULA/i.test(text), text.slice(0, 500));
  }, results);

  // ── 2. Different content shapes ─────────────────────────────────────────
  await runCase("unicode + markdown content", async () => {
    const raw = await chat(base, {
      session: "mx-unicode",
      messages: [
        {
          role: "user",
          content:
            "Echo this exact line (no quotes): 日本語テスト · café · 🚀 · `code`\nThen on a new line write: UNICODE-OK",
        },
      ],
    });
    const text = messageContent(raw, true);
    assert.ok(/UNICODE-OK/i.test(text), text.slice(0, 800));
    assert.ok(/日本語|café|🚀|code/i.test(text), text.slice(0, 800));
  }, results);

  await runCase("code block extraction", async () => {
    const raw = await chat(base, {
      session: "mx-code",
      messages: [
        {
          role: "user",
          content: [
            "Given this TypeScript, reply with only the exported function name.",
            "",
            "```ts",
            "export function computeLagunaHash(input: string): string {",
            "  return input.toUpperCase();",
            "}",
            "```",
            "",
            "Then append CODE-OK on the next line.",
          ].join("\n"),
        },
      ],
    });
    const text = messageContent(raw, true);
    assert.ok(/computeLagunaHash/i.test(text), text.slice(0, 500));
    assert.ok(/CODE-OK/i.test(text), text.slice(0, 500));
  }, results);

  await runCase("json + xml mixed prompt", async () => {
    const raw = await chat(base, {
      session: "mx-markup",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            'JSON: {"secret":"JX-19"}',
            "<meta><id>JX-19</id></meta>",
            "Reply with only the secret value JX-19 (required). Optionally append MARKUP-OK.",
          ].join("\n"),
        },
      ],
    });
    const text = messageContent(raw, false);
    assert.ok(/JX-19/i.test(text), text.slice(0, 500));
  }, results);

  // ── 3. Attachments ──────────────────────────────────────────────────────
  await runCase("text + pdf + image attachments", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const pdf = Buffer.from(
      "%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\nSECRET=PDF-551\n",
      "utf8",
    ).toString("base64");
    const raw = await chat(base, {
      session: "mx-attach",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Read the attached text file. Reply with its TOKEN value only, then ATTACH-OK.",
            },
            {
              type: "file",
              file: {
                filename: "token.txt",
                media_type: "text/plain",
                data: Buffer.from("TOKEN=ATTACH-991", "utf8").toString("base64"),
              },
            },
            {
              type: "file",
              file: {
                filename: "note.pdf",
                media_type: "application/pdf",
                data: pdf,
              },
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${png}` },
            },
          ],
        },
      ],
    });
    const text = messageContent(raw, false);
    assert.ok(/ATTACH-991|991/i.test(text), text.slice(0, 800));
  }, results);

  // ── 4. Tools: single, multi, MCP-style, park/resume ─────────────────────
  await runCase("tool park/resume add_numbers", async () => {
    const session = "mx-tool-add";
    const tools = [TOOL_ADD];
    const turn1 = await chat(base, {
      session,
      messages: [
        {
          role: "user",
          content:
            "Call add_numbers with a=100 and b=23. After the tool result, reply with only the sum and TOOL-ADD-OK.",
        },
      ],
      tools,
    });
    const calls = extractToolCalls(turn1);
    assert.ok(calls.length >= 1, turn1.slice(0, 1500));
    const call = calls[0];
    let args: { a?: number; b?: number } = {};
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      const a = turn1.match(/"a"\s*:\s*(\d+)/);
      const b = turn1.match(/"b"\s*:\s*(\d+)/);
      if (a && b) args = { a: Number(a[1]), b: Number(b[1]) };
    }
    const sum =
      typeof args.a === "number" && typeof args.b === "number"
        ? args.a + args.b
        : 123;
    const turn2 = await chat(base, {
      session,
      messages: [
        {
          role: "user",
          content:
            "Call add_numbers with a=100 and b=23. After the tool result, reply with only the sum and TOOL-ADD-OK.",
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify({
                  a: args.a ?? 100,
                  b: args.b ?? 23,
                }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: call.id,
          content: String(sum),
        },
      ],
      tools,
    });
    const text = messageContent(turn2, true);
    assert.ok(new RegExp(String(sum)).test(text), text.slice(0, 800));
    assert.ok(/TOOL-ADD-OK/i.test(text), text.slice(0, 800));
    return `sum=${sum}`;
  }, results);

  await runCase("MCP-style tool name park/resume", async () => {
    const session = "mx-tool-mcp";
    const tools = [TOOL_MCPISH];
    const turn1 = await chat(base, {
      session,
      messages: [
        {
          role: "user",
          content:
            "Use mcp_filesystem_read on path README.md. After the tool returns, reply with the word FOUND and MCP-OK.",
        },
      ],
      tools,
    });
    const calls = extractToolCalls(turn1);
    if (calls.length === 0) {
      // Model sometimes answers without tools — still assert request succeeded.
      const text = messageContent(turn1, true);
      assert.ok(text.length > 0, turn1.slice(0, 800));
      return "no-tool-call (accepted)";
    }
    const call = calls[0];
    const turn2 = await chat(base, {
      session,
      messages: [
        {
          role: "user",
          content:
            "Use mcp_filesystem_read on path README.md. After the tool returns, reply with the word FOUND and MCP-OK.",
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: call.arguments || '{"path":"README.md"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: call.id,
          content: "# opencode-commandcode\nFOUND-PAYLOAD",
        },
      ],
      tools,
    });
    const text = messageContent(turn2, true);
    assert.ok(/FOUND|MCP-OK/i.test(text), text.slice(0, 800));
  }, results);

  await runCase("two tools offered — pick one", async () => {
    const session = "mx-tool-choice";
    const tools = [TOOL_ECHO, TOOL_ADD];
    const turn1 = await chat(base, {
      session,
      messages: [
        {
          role: "user",
          content:
            "You must call echo_payload with text=PING. Do not call add_numbers.",
        },
      ],
      tools,
    });
    const calls = extractToolCalls(turn1);
    if (calls.length === 0) {
      const text = messageContent(turn1, true);
      assert.ok(text.length > 0, turn1.slice(0, 800));
      return "no-tool-call (accepted)";
    }
    const call = calls.find((c) => c.name === "echo_payload") || calls[0];
    const turn2 = await chat(base, {
      session,
      messages: [
        {
          role: "user",
          content:
            "You must call echo_payload with text=PING. Do not call add_numbers.",
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments:
                  call.name === "echo_payload"
                    ? '{"text":"PING"}'
                    : call.arguments || '{"a":1,"b":2}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: call.id,
          content: call.name === "echo_payload" ? "PING" : "3",
        },
      ],
      tools,
    });
    const text = messageContent(turn2, true);
    assert.ok(text.length > 0, text.slice(0, 500));
    return `called=${call.name}`;
  }, results);

  // ── 5. Large context / compact path ─────────────────────────────────────
  await runCase("large context ~30k tokens", async () => {
    // ~120k chars ≈ 30k tokens heuristic — well under 256k, exercises big body.
    const block = ("alpha-" + "x".repeat(80) + "\n").repeat(1400);
    const raw = await chat(base, {
      session: "mx-big-30k",
      stream: false,
      messages: [
        {
          role: "user",
          content: `${block}\n\nIgnore the filler. Reply with exactly: BIG-30K-OK`,
        },
      ],
    });
    const text = messageContent(raw, false);
    assert.ok(/BIG-30K-OK/i.test(text) || text.length > 0, text.slice(0, 500));
    const usage = getSessionUsage("mx-big-30k");
    return `prompt≈${usage?.usage.inputTokens ?? "?"}`;
  }, results);

  await runCase("large context ~90k tokens (tip/warn band)", async () => {
    // ~360k chars ≈ 90k tokens — tip tier (>=50% of 256k) on estimate path.
    const block = ("beta-" + "y".repeat(90) + "\n").repeat(3800);
    const raw = await chat(base, {
      session: "mx-big-90k",
      stream: false,
      messages: [
        {
          role: "user",
          content: `${block}\n\nIgnore the filler. Reply with exactly: BIG-90K-OK`,
        },
      ],
    });
    const text = messageContent(raw, false);
    assert.ok(/BIG-90K-OK/i.test(text) || text.length > 0, text.slice(0, 500));
    const usage = getSessionUsage("mx-big-90k");
    return `prompt≈${usage?.usage.inputTokens ?? "?"}`;
  }, results);

  await runCase("huge context ~180k tokens (compact tip in stream)", async () => {
    // ~720k chars ≈ 180k tokens — deep into the 256k window; expect success + tip.
    const block = ("gamma-" + "z".repeat(100) + "\n").repeat(6800);
    const raw = await chat(base, {
      session: "mx-huge-180k",
      stream: false,
      messages: [
        {
          role: "user",
          content: `${block}\n\nIgnore the filler. Reply with exactly: HUGE-180K-OK`,
        },
      ],
    });
    const text = messageContent(raw, false);
    assert.ok(/HUGE-180K-OK/i.test(text) || text.length > 0, text.slice(0, 500));
    const usage = getSessionUsage("mx-huge-180k");
    const prompt = usage?.usage.inputTokens ?? 0;
    assert.ok(prompt > 100_000, `expected huge prompt, got ${prompt}`);
    return `prompt≈${prompt}`;
  }, results);

  await runCase("many prior turns → client compact keepTurns", async () => {
    const history: Array<{ role: string; content: string }> = [
      { role: "system", content: "Be terse. End with COMPACT-HIST-OK." },
    ];
    for (let i = 0; i < 40; i++) {
      history.push({
        role: "user",
        content: `Turn ${i}: remember marker M${i}. Padding ${"z".repeat(200)}`,
      });
      history.push({
        role: "assistant",
        content: `Ack M${i}.`,
      });
    }
    history.push({
      role: "user",
      content:
        "What was the latest marker number I mentioned? Reply with M39 and COMPACT-HIST-OK.",
    });
    const raw = await chat(base, {
      session: "mx-hist-compact",
      stream: false,
      messages: history,
    });
    const text = messageContent(raw, false);
    assert.ok(/M39|COMPACT-HIST-OK/i.test(text), text.slice(0, 800));
  }, results);

  await runCase("many tool results → trim path", async () => {
    const messages: unknown[] = [
      {
        role: "user",
        content: "Summarize tool noise and end with TOOL-TRIM-OK.",
      },
    ];
    for (let i = 0; i < 18; i++) {
      const id = `call_trim_${i}`;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id,
            type: "function",
            function: {
              name: "echo_payload",
              arguments: JSON.stringify({ text: `noise-${i}` }),
            },
          },
        ],
      });
      messages.push({
        role: "tool",
        tool_call_id: id,
        content: `noise-result-${i} ${"n".repeat(400)}`,
      });
    }
    messages.push({
      role: "user",
      content: "Reply with exactly: TOOL-TRIM-OK",
    });
    const raw = await chat(base, {
      session: "mx-tool-trim",
      stream: false,
      messages,
      tools: [TOOL_ECHO],
    });
    const text = messageContent(raw, false);
    assert.ok(/TOOL-TRIM-OK/i.test(text) || text.length > 0, text.slice(0, 500));
  }, results);

  // ── 6. Usage + health ───────────────────────────────────────────────────
  await runCase("usage totals + session snapshot", async () => {
    const res = await fetch(`${base}/v1/usage`);
    const raw = await assertOk(res, "usage");
    const json = JSON.parse(raw) as {
      total: { prompt_tokens: number; completion_tokens: number };
      sessions: Array<{ id: string; contextWindow: number }>;
    };
    assert.ok(json.total.prompt_tokens > 0);
    assert.ok(json.sessions.length > 0);
    assert.equal(json.sessions[0]?.contextWindow, 256_000);
    return `sessions=${json.sessions.length} prompt=${json.total.prompt_tokens}`;
  }, results);

  await runCase("empty messages → 400", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SESSION_HEADER]: "mx-empty",
      },
      body: JSON.stringify({
        model: LAGUNA_MODEL_ID,
        stream: false,
        messages: [],
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.ok(/No user message|invalid/i.test(body), body.slice(0, 400));
  }, results);

  await stopProxy();

  const failed = results.filter((r) => !r.ok);
  console.log("\n── matrix summary ──");
  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.ms}ms${r.detail ? `  (${r.detail.slice(0, 120)})` : ""}`,
    );
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} passed`,
  );
  if (failed.length) {
    process.exit(1);
  }
  console.log("ok — live matrix passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
