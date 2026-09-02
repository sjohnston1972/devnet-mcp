import { test, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

/**
 * Exercises the actual exported Worker `fetch` handler end-to-end so we can
 * prove the 429 rejection path never reaches the MCP/model call:
 * `globalThis.fetch` (used for every MCP call) and `env.AI.run` (the
 * Workers AI fallback) are both spied, and the test asserts their call
 * counts do not move between the allowed request and the blocked one.
 */

const SELF = "https://devnet-mcp.clydeford.net";

const realFetch = globalThis.fetch;
let fetchCalls = 0;

function installFetchSpy() {
  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    // The allowed request's MCP call gets a deliberately failing response;
    // handleChat treats MCP failures as a soft error (caught and folded
    // into the context block), so this doesn't block the request.
    return new Response("mcp upstream unavailable in test", { status: 503 });
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

after(() => {
  globalThis.fetch = realFetch;
});

function makeEnv(overrides = {}) {
  let aiRunCalls = 0;
  const env = {
    AI: {
      run: async () => {
        aiRunCalls += 1;
        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      },
    },
    ASSETS: { fetch: async () => new Response("asset") },
    MCP_URL: "https://mcp.example/mcp",
    AI_MODEL: "@cf/test/model",
    ...overrides,
  };
  Object.defineProperty(env, "_aiRunCalls", { get: () => aiRunCalls });
  return env;
}

function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), _pending: pending };
}

function chatRequest({ ip, body }) {
  return new Request(`${SELF}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ip ? { "cf-connecting-ip": ip } : {}),
      origin: SELF,
    },
    body,
  });
}

test("over-limit /api/chat requests get 429 with retry-after and never reach MCP/model", async () => {
  const restoreFetch = installFetchSpy();
  try {
    const env = makeEnv({ CHAT_RATE_LIMIT_PER_MINUTE: "1" });
    const ctx = makeCtx();
    const ip = "203.0.113.10";
    const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });

    // First request: within the limit (1/min) — allowed through to the
    // upstream calls, so this should touch fetch (MCP) and AI.run.
    const first = await worker.fetch(chatRequest({ ip, body }), env, ctx);
    await Promise.all(ctx._pending);
    assert.equal(first.status, 200, "first request should be allowed");
    const fetchCallsAfterFirst = fetchCalls;
    const aiRunCallsAfterFirst = env._aiRunCalls;
    assert.ok(fetchCallsAfterFirst > 0, "the allowed request should have called MCP");
    assert.ok(aiRunCallsAfterFirst > 0, "the allowed request should have called the model");

    // Second request from the same IP within the same window: over limit.
    const second = await worker.fetch(chatRequest({ ip, body }), env, ctx);
    assert.equal(second.status, 429);
    assert.ok(second.headers.get("retry-after"));

    // No additional MCP or model calls happened for the rejected request.
    assert.equal(fetchCalls, fetchCallsAfterFirst, "no MCP call for the 429");
    assert.equal(env._aiRunCalls, aiRunCallsAfterFirst, "no model call for the 429");
  } finally {
    restoreFetch();
  }
});

test("normal single-user chatting stays under the default limit", async () => {
  const restoreFetch = installFetchSpy();
  try {
    const env = makeEnv(); // default 20/min (no override)
    const ctx = makeCtx();
    const ip = "203.0.113.11";
    const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });

    for (let i = 0; i < 5; i++) {
      const res = await worker.fetch(chatRequest({ ip, body }), env, ctx);
      await Promise.all(ctx._pending);
      assert.equal(res.status, 200, `request ${i} should not be throttled`);
    }
  } finally {
    restoreFetch();
  }
});

test("different IPs are throttled independently", async () => {
  const restoreFetch = installFetchSpy();
  try {
    const env = makeEnv({ CHAT_RATE_LIMIT_PER_MINUTE: "1" });
    const ctx = makeCtx();
    const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });

    const a1 = await worker.fetch(chatRequest({ ip: "203.0.113.12", body }), env, ctx);
    await Promise.all(ctx._pending);
    assert.equal(a1.status, 200);

    // A different IP still gets its own budget even though .12 just used theirs.
    const b1 = await worker.fetch(chatRequest({ ip: "203.0.113.13", body }), env, ctx);
    await Promise.all(ctx._pending);
    assert.equal(b1.status, 200);
  } finally {
    restoreFetch();
  }
});
