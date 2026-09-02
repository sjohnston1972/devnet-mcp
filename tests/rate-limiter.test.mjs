import { test } from "node:test";
import assert from "node:assert/strict";
import { SlidingCounter } from "../src/rate-limiter.ts";

test("allows requests up to the limit within the window", () => {
  const rl = new SlidingCounter();
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) {
    const r = rl.check("1.1.1.1", 5, 60_000, now + i);
    assert.equal(r.allowed, true, `request ${i} should be allowed`);
  }
});

test("blocks the request that exceeds the limit, with a positive retry-after", () => {
  const rl = new SlidingCounter();
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) {
    rl.check("2.2.2.2", 5, 60_000, now + i);
  }
  const blocked = rl.check("2.2.2.2", 5, 60_000, now + 5);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterSeconds >= 1);
});

test("resets once the window has fully elapsed", () => {
  const rl = new SlidingCounter();
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) {
    rl.check("3.3.3.3", 5, 60_000, now + i);
  }
  assert.equal(rl.check("3.3.3.3", 5, 60_000, now + 5).allowed, false);
  // Window has fully elapsed — should reset.
  const afterWindow = rl.check("3.3.3.3", 5, 60_000, now + 60_000 + 1);
  assert.equal(afterWindow.allowed, true);
});

test("tracks separate keys independently", () => {
  const rl = new SlidingCounter();
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) {
    rl.check("4.4.4.4", 5, 60_000, now + i);
  }
  assert.equal(rl.check("4.4.4.4", 5, 60_000, now + 5).allowed, false);
  // A different key/IP has its own budget.
  assert.equal(rl.check("5.5.5.5", 5, 60_000, now + 5).allowed, true);
});
