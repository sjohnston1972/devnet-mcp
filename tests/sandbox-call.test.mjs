import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSandboxCall } from "../src/index.ts";

const SANDBOX_URL = "https://devnet-mcp.example.com/api/sandbox-call";

function baseEnv(overrides = {}) {
  return {
    AI: {},
    ASSETS: {},
    MCP_URL: "",
    AI_MODEL: "",
    MERAKI_SANDBOX_API_KEY: "server-secret-key",
    MERAKI_SANDBOX_BASE: "https://api.meraki.com/api/v1",
    MERAKI_SANDBOX_ORG_ID: "111111",
    MERAKI_DEV_NAME: "Development",
    MERAKI_DEV_NETWORK_ID: "N_dev123",
    MERAKI_DEV_NETWORK_NAME: "DEV",
    MERAKI_PROD_NAME: "Production",
    MERAKI_PROD_NETWORK_ID: "N_prod123",
    MERAKI_PROD_NETWORK_NAME: "PROD",
    ...overrides,
  };
}

let nextIp = 0;
/** A fresh IP per test, so future per-IP rate limiting never interferes. */
function freshIp() {
  nextIp += 1;
  return `203.0.113.${nextIp}`;
}

/** Installs a fetch spy that fails the test loudly if the upstream Meraki
 * host is ever reached. Returns { restore, wasCalled }. */
function forbidUpstreamFetch() {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (...args) => {
    called = true;
    throw new Error(`unexpected outbound fetch to ${args[0]}`);
  };
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    wasCalled: () => called,
  };
}

function mockUpstreamFetch(status = 200, body = { ok: true }) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
  };
}

function makeRequest({ method = "POST", body, headers = {} } = {}) {
  return new Request(SANDBOX_URL, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("anonymous cross-origin call (no key, no Origin/Referer) is refused, no upstream call", async () => {
  const spy = forbidUpstreamFetch();
  try {
    const req = makeRequest({
      headers: { "cf-connecting-ip": freshIp() },
      body: { method: "GET", path: "/api/v1/networks/{networkId}/devices", env: "dev" },
    });
    const res = await handleSandboxCall(req, baseEnv());
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.match(json.error, /x-user-meraki-key/);
    assert.equal(spy.wasCalled(), false, "no outbound Meraki request should be made");
  } finally {
    spy.restore();
  }
});

test("anonymous call with a foreign Origin header is refused, no upstream call", async () => {
  const spy = forbidUpstreamFetch();
  try {
    const req = makeRequest({
      headers: { "cf-connecting-ip": freshIp(), origin: "https://evil.example.com" },
      body: { method: "POST", path: "/api/v1/networks/{networkId}/devices", env: "dev" },
    });
    const res = await handleSandboxCall(req, baseEnv());
    assert.equal(res.status, 403);
    assert.equal(spy.wasCalled(), false);
  } finally {
    spy.restore();
  }
});

test("legitimate in-app flow: same-origin, server key -> succeeds", async () => {
  const spy = mockUpstreamFetch(200, { ok: true });
  try {
    const req = makeRequest({
      headers: { "cf-connecting-ip": freshIp(), origin: "https://devnet-mcp.example.com" },
      body: { method: "GET", path: "/api/v1/networks/{networkId}/devices", env: "dev" },
    });
    const res = await handleSandboxCall(req, baseEnv());
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.usedUserKey, false);
    assert.equal(spy.calls.length, 1);
  } finally {
    spy.restore();
  }
});

test("user-supplied key still works cross-origin (origin gate only applies to the server key)", async () => {
  const spy = mockUpstreamFetch(200, { ok: true });
  try {
    const req = makeRequest({
      headers: {
        "cf-connecting-ip": freshIp(),
        origin: "https://some-other-app.example.com",
        "x-user-meraki-key": "user-own-key",
      },
      body: { method: "GET", path: "/api/v1/networks/{networkId}/devices", env: "dev" },
    });
    const res = await handleSandboxCall(req, baseEnv());
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.usedUserKey, true);
    assert.equal(spy.calls.length, 1);
  } finally {
    spy.restore();
  }
});
