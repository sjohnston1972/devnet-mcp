import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkContentLength,
  readLimitedText,
  validateMessages,
  MAX_BODY_BYTES,
  MAX_MESSAGES,
  MAX_CONTENT_CHARS,
} from "../src/chat-request-guard.ts";

/* --------- checkContentLength --------- */

test("checkContentLength allows a missing header", () => {
  assert.deepEqual(checkContentLength(null), { ok: true });
});

test("checkContentLength allows a header under the cap", () => {
  assert.deepEqual(checkContentLength("1000"), { ok: true });
});

test("checkContentLength rejects a header over the cap with 413", () => {
  const r = checkContentLength(String(MAX_BODY_BYTES + 1));
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

/* --------- readLimitedText --------- */

function streamOf(str) {
  const bytes = new TextEncoder().encode(str);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

test("readLimitedText returns the full text when under the cap", async () => {
  const r = await readLimitedText(streamOf('{"a":1}'), MAX_BODY_BYTES);
  assert.equal(r.ok, true);
  assert.equal(r.text, '{"a":1}');
});

test("readLimitedText returns empty text for a null body", async () => {
  const r = await readLimitedText(null, MAX_BODY_BYTES);
  assert.equal(r.ok, true);
  assert.equal(r.text, "");
});

test("readLimitedText rejects a body over the cap even without a declared length", async () => {
  const big = "a".repeat(1000);
  const r = await readLimitedText(streamOf(big), 100);
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

test("readLimitedText bails out early instead of buffering the whole oversized stream", async () => {
  let enqueued = 0;
  const cap = 50;
  const chunk = new TextEncoder().encode("x".repeat(20));
  const stream = new ReadableStream({
    pull(controller) {
      // Would run forever if readLimitedText kept reading past the cap.
      if (enqueued > 10_000) {
        controller.close();
        return;
      }
      enqueued += 1;
      controller.enqueue(chunk);
    },
  });

  const r = await readLimitedText(stream, cap);
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
  // Should have stopped almost immediately, not consumed the whole stream.
  assert.ok(enqueued < 100, `expected an early bail-out, read ${enqueued} chunks`);
});

/* --------- validateMessages --------- */

test("validateMessages rejects a non-array", () => {
  const r = validateMessages(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test("validateMessages rejects an empty array", () => {
  const r = validateMessages([]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test("validateMessages accepts a normal short history", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  assert.deepEqual(validateMessages(msgs), { ok: true });
});

test("validateMessages rejects more than the max message count with 413", () => {
  const msgs = Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => ({
    role: "user",
    content: `m${i}`,
  }));
  const r = validateMessages(msgs);
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

test("validateMessages accepts exactly the max message count", () => {
  const msgs = Array.from({ length: MAX_MESSAGES }, (_, i) => ({
    role: "user",
    content: `m${i}`,
  }));
  assert.deepEqual(validateMessages(msgs), { ok: true });
});

test("validateMessages rejects a single oversized message content with 413", () => {
  const msgs = [{ role: "user", content: "a".repeat(MAX_CONTENT_CHARS + 1) }];
  const r = validateMessages(msgs);
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

test("validateMessages accepts content at exactly the cap", () => {
  const msgs = [{ role: "user", content: "a".repeat(MAX_CONTENT_CHARS) }];
  assert.deepEqual(validateMessages(msgs), { ok: true });
});

test("validateMessages rejects non-string content", () => {
  const r = validateMessages([{ role: "user", content: 12345 }]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});
