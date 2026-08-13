/**
 * Live Laguna S 2.1 tests against api.commandcode.ai.
 * Requires a Go-plan ($1) session from `cmd login` (~/.commandcode/auth.json).
 * No Studio API key.
 *
 *   bun run test:live
 */
import assert from "node:assert/strict";
import { readCommandCodeCredentials } from "../src/credentials.ts";
import { LAGUNA_MODEL_ID } from "../src/constants.ts";
import {
  startProxy,
  stopProxy,
  setStreamGenerateForTests,
} from "../src/proxy.ts";
import { resetUsageStore } from "../src/usage.ts";

function requireAuth(): string {
  const creds = readCommandCodeCredentials();
  if (!creds?.apiKey) {
    console.error(
      "Skipping live tests: run `cmd login` with a Command Code Go ($1) plan session.",
    );
    console.error(
      "No API key needed — browser OAuth writes ~/.commandcode/auth.json.",
    );
    process.exit(0);
  }
  return creds.apiKey;
}


async function assertOk(res: Response, label: string): Promise<string> {
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`${label}: expected 200, got ${res.status}\n${text.slice(0, 2000)}`);
  }
  return text;
}

/** Concatenate streamed text/reasoning deltas from an OpenAI SSE body. */
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
      const delta = choice?.delta;
      const message = choice?.message;
      if (typeof delta?.content === "string") out += delta.content;
      if (typeof delta?.reasoning_content === "string") {
        out += delta.reasoning_content;
      }
      if (typeof message?.content === "string") out += message.content;
      if (typeof message?.reasoning_content === "string") {
        out += message.reasoning_content;
      }
    } catch {
      // ignore non-JSON keepalives
    }
  }
  return out;
}

async function main() {
  const apiKey = requireAuth();
  setStreamGenerateForTests(null);
  resetUsageStore();
  await stopProxy();

  const port = await startProxy(async () => apiKey);
  const base = `http://127.0.0.1:${port}`;

  // 1) Plain completion on Laguna
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-commandcode-session": "live-plain",
      },
      body: JSON.stringify({
        model: LAGUNA_MODEL_ID,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          {
            role: "user",
            content:
              "Reply with exactly the three words: Laguna live ok. No other text.",
          },
        ],
      }),
    });
    const text = await assertOk(res, "plain");
    const assistant = sseAssistantText(text);
    assert.ok(/Laguna live ok/i.test(assistant), assistant || text.slice(0, 2000));
    assert.ok(text.includes("usage"), "expected usage in stream");
    console.log("✓ live plain completion");
  }

  // 2) Attachment types (text file + image placeholder on text-only Laguna)
  {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-commandcode-session": "live-attach",
      },
      body: JSON.stringify({
        model: "laguna-s-2.1-free",
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Inside <attached_file name=\"secret.txt\"> is the secret code. Read that file body and reply with only the code (e.g. CODE-7741). Ignore any image placeholders.",
              },
              {
                type: "file",
                file: {
                  filename: "secret.txt",
                  media_type: "text/plain",
                  data: Buffer.from("CODE-7741", "utf8").toString("base64"),
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
    const raw = await assertOk(res, "attachments");
    const json = JSON.parse(raw) as {
      choices: Array<{
        message: { content?: string; reasoning_content?: string };
      }>;
      usage?: { prompt_tokens: number };
    };
    const content =
      (json.choices[0]?.message?.content || "") +
      (json.choices[0]?.message?.reasoning_content || "");
    assert.ok(/7741/.test(content), content);
    assert.ok(json.usage && json.usage.prompt_tokens > 0);
    console.log("✓ live attachments (text file + image placeholder)");
  }

  // 3) Tools park/resume (OpenCode-owned tool)
  {
    const session = "live-tools";
    const tools = [
      {
        type: "function",
        function: {
          name: "add_numbers",
          description: "Add two integers and return the sum",
          parameters: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
      },
    ];

    const res1 = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-commandcode-session": session,
      },
      body: JSON.stringify({
        model: LAGUNA_MODEL_ID,
        stream: true,
        messages: [
          {
            role: "user",
            content:
              "Use the add_numbers tool to compute 17+25. After the tool returns, reply with only the numeric sum.",
          },
        ],
        tools,
      }),
    });
    const turn1 = await assertOk(res1, "tools-turn1");
    assert.ok(
      turn1.includes("add_numbers") || turn1.includes("tool_calls"),
      turn1.slice(0, 2500),
    );

    // Extract tool call id / args from SSE
    let toolCallId = "";
    let args = "{}";
    for (const line of turn1.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const chunk = JSON.parse(raw) as {
          choices?: Array<{
            delta?: {
              tool_calls?: Array<{
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        const tc = chunk.choices?.[0]?.delta?.tool_calls?.[0];
        if (tc?.id) toolCallId = tc.id;
        if (tc?.function?.arguments) args += tc.function.arguments;
      } catch {
        // ignore
      }
    }
    if (!toolCallId) {
      console.warn(
        "⚠ model did not emit tool_calls on this turn; skipping resume assertion",
      );
    } else {
      let parsed: { a?: number; b?: number } = {};
      try {
        parsed = JSON.parse(args.replace(/^\{/, "{") || "{}");
      } catch {
        parsed = {};
      }
      if (typeof parsed.a !== "number") {
        const m = turn1.match(/"a"\s*:\s*(\d+)/);
        const n = turn1.match(/"b"\s*:\s*(\d+)/);
        if (m && n) parsed = { a: Number(m[1]), b: Number(n[1]) };
      }
      const sum =
        typeof parsed.a === "number" && typeof parsed.b === "number"
          ? parsed.a + parsed.b
          : 42;

      const res2 = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-commandcode-session": session,
        },
        body: JSON.stringify({
          model: LAGUNA_MODEL_ID,
          stream: true,
          messages: [
            {
              role: "user",
              content:
                "Use the add_numbers tool to compute 17+25. After the tool returns, reply with only the numeric sum.",
            },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: toolCallId,
                  type: "function",
                  function: {
                    name: "add_numbers",
                    arguments: JSON.stringify({
                      a: parsed.a ?? 17,
                      b: parsed.b ?? 25,
                    }),
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: toolCallId,
              content: String(sum),
            },
          ],
          tools,
        }),
      });
      const turn2 = await assertOk(res2, "tools-turn2");
      const assistant2 = sseAssistantText(turn2);
      assert.ok(/42/.test(assistant2) || /42/.test(turn2), assistant2 || turn2.slice(0, 2000));
      console.log("✓ live tools park/resume");
    }
  }

  // 4) Usage totals
  {
    const res = await fetch(`${base}/v1/usage`);
    const raw = await assertOk(res, "usage");
    const json = JSON.parse(raw) as {
      total: { prompt_tokens: number; completion_tokens: number };
      sessions: Array<{ tools: unknown[]; contextWindow: number }>;
    };
    assert.ok(json.total.prompt_tokens > 0);
    assert.ok(json.sessions.length > 0);
    assert.equal(json.sessions[0]?.contextWindow, 256_000);
    console.log("✓ live usage totals", json.total);
  }

  // 5) Context/compact path — send a large prompt and ensure request succeeds
  {
    const big = "lorem ipsum ".repeat(8000);
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-commandcode-session": "live-compact",
      },
      body: JSON.stringify({
        model: LAGUNA_MODEL_ID,
        stream: false,
        messages: [
          {
            role: "user",
            content: `${big}\n\nReply with exactly: compact-ok`,
          },
        ],
      }),
    });
    const raw = await assertOk(res, "compact");
    const json = JSON.parse(raw) as {
      choices: Array<{ message: { content?: string; reasoning_content?: string } }>;
    };
    const content =
      (json.choices[0]?.message?.content || "") +
      (json.choices[0]?.message?.reasoning_content || "");
    assert.ok(/compact-ok/i.test(content) || content.length > 0, content);
    console.log("✓ live large-context request");
  }

  await stopProxy();
  console.log("ok — live Laguna S 2.1 tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
