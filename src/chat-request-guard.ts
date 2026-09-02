/**
 * Server-side request-size and history caps for POST /api/chat.
 *
 * These run before any MCP/model call is made, and fail closed: a body that
 * cannot be shown to be within limits (e.g. a declared Content-Length above
 * the cap) is rejected without ever being read or parsed.
 */
export const MAX_BODY_BYTES = 256 * 1024; // 256 KB
export const MAX_MESSAGES = 40;
export const MAX_CONTENT_CHARS = 8000;

export interface GuardRejection {
  ok: false;
  status: number;
  error: string;
}

export interface GuardOk {
  ok: true;
}

export type GuardResult = GuardOk | GuardRejection;

export interface ReadOk {
  ok: true;
  text: string;
}

export type ReadResult = ReadOk | GuardRejection;

/** Fast-path rejection using the declared Content-Length header, before any read. */
export function checkContentLength(
  contentLengthHeader: string | null,
  maxBytes: number = MAX_BODY_BYTES,
): GuardResult {
  if (contentLengthHeader === null) return { ok: true };
  const declared = Number(contentLengthHeader);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, error: "request body too large" };
  }
  return { ok: true };
}

/**
 * Read a request body stream up to `maxBytes`, bailing out (and cancelling
 * the stream) as soon as the cap is exceeded, regardless of what
 * Content-Length claimed (a client can omit or lie about it).
 */
export async function readLimitedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<ReadResult> {
  if (!body) return { ok: true, text: "" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* best-effort */
      }
      return { ok: false, status: 413, error: "request body too large" };
    }
    chunks.push(value);
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(buf) };
}

interface ChatMessageLike {
  role?: unknown;
  content?: unknown;
}

/** Cap message count and per-message content length. Structural only. */
export function validateMessages(
  messages: unknown,
  opts: { maxMessages?: number; maxContentChars?: number } = {},
): GuardResult {
  const maxMessages = opts.maxMessages ?? MAX_MESSAGES;
  const maxContentChars = opts.maxContentChars ?? MAX_CONTENT_CHARS;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, status: 400, error: "No user message" };
  }

  if (messages.length > maxMessages) {
    return {
      ok: false,
      status: 413,
      error: `too many messages (max ${maxMessages})`,
    };
  }

  for (const raw of messages) {
    const m = raw as ChatMessageLike;
    if (typeof m?.content !== "string") {
      return { ok: false, status: 400, error: "message content must be a string" };
    }
    if (m.content.length > maxContentChars) {
      return {
        ok: false,
        status: 413,
        error: `message content too long (max ${maxContentChars} chars)`,
      };
    }
  }

  return { ok: true };
}
