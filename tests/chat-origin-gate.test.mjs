import { test, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

/**
 * Exercises the actual exported Worker `fetch` handler end-to-end so we can
 * prove the 403 rejection path never reaches the MCP/model call:
 * `globalThis.fetch` (used for every MCP call) and `env.AI.run` (the
 * Workers AI fallback) are both spied, and the tests assert they are never
 * invoked for a cross-origin request.
 */

const SELF = "https://devnet-mcp.clydeford.net";

const realFetch = globalThis.fetch;
let fetchCalls = 0;

function installFetchSpy() {
  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
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

test("a cross-origin POST /api/chat is rejected with 403 before any upstream call", async () => {
  const restoreFetch = installFetchSpy();
  try {
    const env = makeEnv();
    const ctx = makeCtx();
    const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });

    const res = await worker.fetch(
      new Request(`${SELF}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.30",
          origin: "https://evil.example",
        },
        body,
      }),
      env,
      ctx,
    );

    assert.equal(res.status, 403);
    assert.equal(fetchCalls, 0, "a cross-origin request must never reach MCP/model");
    assert.equal(env._aiRunCalls, 0);
  } finally {
    restoreFetch();
  }
});

test("a cross-origin POST /api/sandbox-call is rejected with 403", async () => {
  const env = makeEnv();
  const ctx = makeCtx();

  const res = await worker.fetch(
    new Request(`${SELF}/api/sandbox-call`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ method: "GET", path: "/api/v1/organizations" }),
    }),
    env,
    ctx,
  );
  assert.equal(res.status, 403);
});

test("same-origin POST /api/sandbox-call is not blocked by the origin gate", async () => {
  const env = makeEnv();
  const ctx = makeCtx();

  const res = await worker.fetch(
    new Request(`${SELF}/api/sandbox-call`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: SELF },
      body: JSON.stringify({ method: "GET", path: "/api/v1/organizations" }),
    }),
    env,
    ctx,
  );
  // No Meraki key configured in this env, so the handler itself replies
  // 503 — the point here is only that the origin gate did not 403 it.
  assert.notEqual(res.status, 403);
});

test("cross-origin GET /api/mcp-status and /api/sandbox-info are also rejected", async () => {
  const env = makeEnv();
  const ctx = makeCtx();

  const statusRes = await worker.fetch(
    new Request(`${SELF}/api/mcp-status`, { headers: { origin: "https://evil.example" } }),
    env,
    ctx,
  );
  assert.equal(statusRes.status, 403);

  const infoRes = await worker.fetch(
    new Request(`${SELF}/api/sandbox-info`, { headers: { origin: "https://evil.example" } }),
    env,
    ctx,
  );
  assert.equal(infoRes.status, 403);
});

test("cross-origin GET /api/health is deliberately left open (not a JSON API route gated here)", async () => {
  const env = makeEnv();
  const ctx = makeCtx();

  const res = await worker.fetch(
    new Request(`${SELF}/api/health`, { headers: { origin: "https://evil.example" } }),
    env,
    ctx,
  );
  assert.equal(res.status, 200);
});

test("legitimate same-origin chat use (and localhost dev) is unaffected", async () => {
  const restoreFetch = installFetchSpy();
  try {
    const env = makeEnv();
    const ctx = makeCtx();
    const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });

    const prodRes = await worker.fetch(
      new Request(`${SELF}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.40",
          origin: SELF,
        },
        body,
      }),
      env,
      ctx,
    );
    await Promise.all(ctx._pending);
    assert.equal(prodRes.status, 200);

    const devUrl = "http://localhost:8787";
    const devRes = await worker.fetch(
      new Request(`${devUrl}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.41",
          origin: devUrl,
        },
        body,
      }),
      env,
      ctx,
    );
    await Promise.all(ctx._pending);
    assert.equal(devRes.status, 200);
  } finally {
    restoreFetch();
  }
});
