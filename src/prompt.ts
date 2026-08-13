/**
 * Build Command Code wire messages from OpenAI-compatible chat messages,
 * including text, images, PDFs, and generic file attachments.
 *
 * Laguna S 2.1 is text-only — images become placeholders (matching Command Code
 * stripImages behavior) while text/PDF/file payloads are inlined when possible.
 */
import type {
  WireAssistantContent,
  WireMessage,
  WireTool,
  WireUserContent,
} from "./gateway-types.js";

const IMAGE_OMITTED =
  "[image omitted: the active model is text-only]";

function parseDataUrl(url: string): {
  mediaType: string;
  data: string;
} | null {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i.exec(
    url.trim(),
  );
  if (!match) return null;
  return {
    mediaType: (match[1] || "application/octet-stream").toLowerCase(),
    data: match[2],
  };
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function mediaLooksLikePdf(mediaType: string, urlHint = ""): boolean {
  return (
    mediaType.includes("pdf") ||
    /\.pdf(\?|#|$)/i.test(urlHint) ||
    (mediaType === "application/octet-stream" &&
      /\.pdf(\?|#|$)/i.test(urlHint))
  );
}

function mediaLooksLikeImage(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

function mediaLooksLikeText(mediaType: string, name = ""): boolean {
  if (mediaType.startsWith("text/")) return true;
  if (
    /json|xml|javascript|typescript|yaml|toml|markdown|csv|html|css/.test(
      mediaType,
    )
  ) {
    return true;
  }
  return /\.(txt|md|json|js|ts|tsx|jsx|py|rs|go|java|c|cpp|h|css|html|yml|yaml|toml|csv|xml|sh|bash|zsh|sql)$/i.test(
    name,
  );
}

function tryDecodeBase64Text(data: string, limit = 200_000): string | null {
  try {
    const buf = Buffer.from(data, "base64");
    if (buf.length > limit) {
      return (
        buf.subarray(0, limit).toString("utf8") +
        `\n…[truncated ${buf.length - limit} bytes]`
      );
    }
    const text = buf.toString("utf8");
    // Reject if mostly non-printable.
    const sample = text.slice(0, 2000);
    const bad = [...sample].filter((ch) => {
      const code = ch.charCodeAt(0);
      return code < 9 || (code > 13 && code < 32);
    }).length;
    if (bad > sample.length * 0.05) return null;
    return text;
  } catch {
    return null;
  }
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: string; text?: string };
      if (p.type === "text" && typeof p.text === "string") return p.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function contentHasAttachments(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const type = (part as { type?: unknown }).type;
    return (
      type === "image_url" ||
      type === "input_image" ||
      type === "file" ||
      type === "input_file" ||
      type === "image" ||
      type === "document"
    );
  });
}

type AttachmentSink = {
  texts: string[];
  images: Array<{ dataUrl: string; mimeType: string }>;
  vision: boolean;
};

function pushAttachmentPart(part: unknown, sink: AttachmentSink): void {
  if (!part || typeof part !== "object") return;
  const p = part as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type : "";

  if (type === "text" && typeof p.text === "string") {
    sink.texts.push(p.text);
    return;
  }

  if (type === "image_url" || type === "input_image" || type === "image") {
    const imageUrl = p.image_url ?? p.image ?? p.url;
    const url =
      typeof imageUrl === "string"
        ? imageUrl
        : imageUrl &&
            typeof imageUrl === "object" &&
            typeof (imageUrl as { url?: unknown }).url === "string"
          ? (imageUrl as { url: string }).url
          : typeof p.data === "string"
            ? `data:${typeof p.media_type === "string" ? p.media_type : "image/png"};base64,${p.data}`
            : null;
    if (!url) return;
    const parsed = parseDataUrl(url);
    if (parsed && mediaLooksLikeImage(parsed.mediaType)) {
      if (sink.vision) {
        sink.images.push({
          dataUrl: url,
          mimeType: parsed.mediaType,
        });
      } else {
        sink.texts.push(
          `<attached_image>\n${IMAGE_OMITTED}\n(media_type=${parsed.mediaType})\n</attached_image>`,
        );
      }
      return;
    }
    if (isHttpUrl(url)) {
      if (sink.vision) {
        sink.images.push({ dataUrl: url, mimeType: "image/*" });
      } else {
        sink.texts.push(
          `<attached_image>\n${IMAGE_OMITTED}\n(url=${url})\n</attached_image>`,
        );
      }
    }
    return;
  }

  if (type === "file" || type === "input_file" || type === "document") {
    const file = (p.file && typeof p.file === "object" ? p.file : p) as Record<
      string,
      unknown
    >;
    const url = typeof file.url === "string" ? file.url : null;
    const data = typeof file.data === "string" ? file.data : null;
    const mediaType =
      typeof file.media_type === "string"
        ? file.media_type
        : typeof file.mime_type === "string"
          ? file.mime_type
          : "application/octet-stream";
    const name =
      typeof file.filename === "string"
        ? file.filename
        : typeof file.name === "string"
          ? file.name
          : "";

    if (url) {
      const parsed = parseDataUrl(url);
      if (parsed) {
        handleBinaryAttachment(sink, parsed.mediaType, parsed.data, name);
        return;
      }
      if (isHttpUrl(url)) {
        sink.texts.push(
          `<attached_file name="${name || "remote"}" media_type="${mediaType}">\nRemote file URL: ${url}\n</attached_file>`,
        );
      }
      return;
    }
    if (data) {
      handleBinaryAttachment(sink, mediaType, data, name);
    }
  }
}

function handleBinaryAttachment(
  sink: AttachmentSink,
  mediaType: string,
  data: string,
  name: string,
): void {
  if (mediaLooksLikeImage(mediaType)) {
    const dataUrl = `data:${mediaType};base64,${data}`;
    if (sink.vision) {
      sink.images.push({ dataUrl, mimeType: mediaType });
    } else {
      sink.texts.push(
        `<attached_image name="${name}">\n${IMAGE_OMITTED}\n</attached_image>`,
      );
    }
    return;
  }

  if (mediaLooksLikePdf(mediaType, name)) {
    sink.texts.push(
      `<attached_pdf name="${name || "document.pdf"}">\n[PDF attachment base64 length=${data.length}. The active model is text-only; summarize from filename/context or ask the user for extracted text.]\n</attached_pdf>`,
    );
    return;
  }

  if (mediaLooksLikeText(mediaType, name)) {
    const decoded = tryDecodeBase64Text(data);
    if (decoded !== null) {
      sink.texts.push(
        `<attached_file name="${name || "file"}" media_type="${mediaType}">\n${decoded}\n</attached_file>`,
      );
      return;
    }
  }

  sink.texts.push(
    `<attached_file name="${name || "file"}" media_type="${mediaType}">\n[binary attachment, base64 length=${data.length}]\n</attached_file>`,
  );
}

export function openaiContentToUserParts(
  content: unknown,
  vision: boolean,
): WireUserContent {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(content)) return [];

  const sink: AttachmentSink = { texts: [], images: [], vision };
  for (const part of content) pushAttachmentPart(part, sink);

  const out: WireUserContent = [];
  for (const text of sink.texts) {
    if (text.trim()) out.push({ type: "text", text });
  }
  for (const img of sink.images) {
    out.push({
      type: "image",
      image: img.dataUrl,
      mimeType: img.mimeType,
    });
  }
  return out;
}

export type OpenAITool = {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type OpenAIMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

export function openaiToolsToWire(tools: OpenAITool[]): WireTool[] {
  return tools
    .map((t) => {
      const name = t.function?.name;
      if (!name) return null;
      return {
        name,
        description: t.function?.description || name,
        input_schema:
          (t.function?.parameters as Record<string, unknown>) || {
            type: "object",
            properties: {},
          },
      };
    })
    .filter((t): t is WireTool => Boolean(t));
}

/**
 * Convert a full OpenAI chat history into Command Code wire messages.
 * System messages are collected separately.
 */
export function openaiMessagesToWire(
  messages: OpenAIMessage[],
  options: { vision: boolean },
): { system: string; messages: WireMessage[] } {
  const systemParts: string[] = [];
  const wire: WireMessage[] = [];

  for (const msg of messages) {
    const role = msg.role || "";
    if (role === "system" || role === "developer") {
      const text = extractTextContent(msg.content).trim();
      if (text) systemParts.push(text);
      continue;
    }

    if (role === "user") {
      const parts = openaiContentToUserParts(msg.content, options.vision);
      if (parts.length > 0) wire.push({ role: "user", content: parts });
      continue;
    }

    if (role === "assistant") {
      const content: WireAssistantContent = [];
      const text = extractTextContent(msg.content).trim();
      if (text) content.push({ type: "text", text });
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const id = tc.id || "";
          const name = tc.function?.name || "";
          if (!id || !name) continue;
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function?.arguments || "{}") as Record<
              string,
              unknown
            >;
          } catch {
            input = { raw: tc.function?.arguments || "" };
          }
          content.push({
            type: "tool-call",
            toolCallId: id,
            toolName: name,
            input,
          });
        }
      }
      if (content.length > 0) wire.push({ role: "assistant", content });
      continue;
    }

    if (role === "tool") {
      const toolCallId = msg.tool_call_id || "";
      if (!toolCallId) continue;
      wire.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: msg.name || "",
            output: {
              type: "text",
              value: extractTextContent(msg.content),
            },
          },
        ],
      });
    }
  }

  return { system: systemParts.join("\n\n"), messages: wire };
}
