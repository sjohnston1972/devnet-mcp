import { test } from "node:test";
import assert from "node:assert/strict";
import { toAnthropicTurns } from "../src/chat-history.ts";

test("keeps only the last N turns", () => {
  const msgs = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i}`,
  }));
  const out = toAnthropicTurns(msgs, 8);
  assert.equal(out.length, 8);
  assert.equal(out[0].content, "m4");
});

test("drops a leading assistant turn left by the window (first must be user)", () => {
  const msgs = [
    { role: "assistant", content: "orphan" },
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
  ];
  const out = toAnthropicTurns(msgs, 8);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant"]);
});

test("filters out non user/assistant roles", () => {
  const msgs = [
    { role: "system", content: "x" },
    { role: "user", content: "q" },
  ];
  assert.deepEqual(toAnthropicTurns(msgs, 8), [{ role: "user", content: "q" }]);
});

test("empty history returns empty array", () => {
  assert.deepEqual(toAnthropicTurns([], 8), []);
});

test("all-assistant history returns empty array", () => {
  assert.deepEqual(toAnthropicTurns([{ role: "assistant", content: "a" }], 8), []);
});
