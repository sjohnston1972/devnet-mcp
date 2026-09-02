import { test, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { MAX_BODY_BYTES, MAX_MESSAGES } from "../src/chat-request-guard.ts";

/**
 * Exercises the actual exported Worker `fetch` handler end-to-end (real
 * routing) rather than the guard helpers in isolation, specifically so we
 * can prove the rejection paths never reach the MCP/model call:
 * `globalThis.fetch` (used for every MCP call, and under the hood by the
 * Anthropic SDK) and `env.AI.run` (the Workers AI fallback) are both spied,
 * and the tests assert their call counts do not move on a 413 response.
 */

const SELF = "https://devnet-mcp.clydeford.net";

const realFetch = globalThis.fetch;
let fetchCalls = 0;

function installFetchSpy() {
  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    // The (allowed) "normal chat" test's MCP call gets a deliberately
    // failing response; handleChat treats MCP failures as a soft error
    // (caught and folded into the context block), so this doesn't block
    // the request from completing.
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

function chatRequest({ ip, body } = {}) {
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

test("an oversized body is rejected with 413 before any MCP/model call", async () => {
  const restoreFetch = installFetchSpy();
  try {
    const env = makeEnv();
    const ctx = makeCtx();
    const oversized = "a".repeat(MAX_BODY_BYTES + 5000);

    const res = await worker.fetch(
      chatRequest({ ip: "203.0.113.20", body: oversized }),
      env,
      ctx,
    );

    assert.equal(res.status, 413);
    assert.equal(fetchCalls, 0, "an oversized body must never reach MCP/model");
    assert.equal(env._aiRunCalls, 0);
  } finally {
    restoreFetch();
  }
});

test("a message array over the count cap is rejected with 413 before any upstream call", async () => {
  const restoreFetch = installFetchSpy();
  try {
    const env = makeEnv();
    const ctx = makeCtx();
    const messages = Array.from({ length: MAX_MESSAGES + 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
    }));
    const body = JSON.stringify({ messages });

    const res = await worker.fetch(chatRequest({ ip: "203.0.113.21", body }), env, ctx);

    assert.equal(res.status, 413);
    assert.equal(fetchCalls, 0, "an over-count history must never reach MCP/model");
    assert.equal(env._aiRunCalls, 0);
  } finally {
    restoreFetch();
  }
});

test("normal short chats are unaffected by the size/history caps", async () => {
  const restoreFetch = installFetchSpy();
  try {
    const env = makeEnv();
    const ctx = makeCtx();
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    }));
    const body = JSON.stringify({ messages });

    const res = await worker.fetch(chatRequest({ ip: "203.0.113.22", body }), env, ctx);
    await Promise.all(ctx._pending);

    assert.equal(res.status, 200);
  } finally {
    restoreFetch();
  }
});
