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
    MERAKI_DEV_DEVICE_SERIAL: "Q2XX-DEV1-SER1",
    MERAKI_PROD_NAME: "Production",
    MERAKI_PROD_NETWORK_ID: "N_prod123",
    MERAKI_PROD_NETWORK_NAME: "PROD",
    MERAKI_PROD_DEVICE_SERIAL: "Q2XX-PROD-SER1",
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

test("same-origin call supplying a DIFFERENT org id is refused, not coerced; no upstream call", async () => {
  const spy = forbidUpstreamFetch();
  try {
    const req = makeRequest({
      headers: {
        "cf-connecting-ip": freshIp(),
        origin: "https://devnet-mcp.example.com",
        "x-user-meraki-org": "999999", // differs from configured 111111
      },
      body: { method: "GET", path: "/api/v1/organizations/{organizationId}/networks", env: "dev" },
    });
    const res = await handleSandboxCall(req, baseEnv());
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.match(json.error, /organization/);
    assert.equal(spy.wasCalled(), false, "org override must never reach the upstream Meraki API");
  } finally {
    spy.restore();
  }
});

test("same-origin call supplying a DIFFERENT network id is refused, not coerced; no upstream call", async () => {
  const spy = forbidUpstreamFetch();
  try {
    const req = makeRequest({
      headers: {
        "cf-connecting-ip": freshIp(),
        origin: "https://devnet-mcp.example.com",
        "x-user-meraki-network": "N_someone_elses_network",
      },
      body: { method: "GET", path: "/api/v1/networks/{networkId}/devices", env: "dev" },
    });
    const res = await handleSandboxCall(req, baseEnv());
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.match(json.error, /network/);
    assert.equal(spy.wasCalled(), false, "network override must never reach the upstream Meraki API");
  } finally {
    spy.restore();
  }
});

test("same-origin call supplying a DIFFERENT device serial is refused, not coerced; no upstream call", async () => {
  const spy = forbidUpstreamFetch();
  try {
    const req = makeRequest({
      headers: {
        "cf-connecting-ip": freshIp(),
        origin: "https://devnet-mcp.example.com",
        "x-user-meraki-serial": "Q2XX-SOME-OTHR",
      },
      body: { method: "GET", path: "/api/v1/devices/{serial}", env: "dev" },
    });
    const res = await handleSandboxCall(req, baseEnv());
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.match(json.error, /device/);
    assert.equal(spy.wasCalled(), false, "serial override must never reach the upstream Meraki API");
  } finally {
    spy.restore();
  }
});

test("with the allow-config absent (no server org id configured), the request is refused, not defaulted", async () => {
  const spy = forbidUpstreamFetch();
  try {
    const req = makeRequest({
      headers: { "cf-connecting-ip": freshIp(), origin: "https://devnet-mcp.example.com" },
      body: { method: "GET", path: "/api/v1/organizations/{organizationId}/networks", env: "dev" },
    });
    const env = baseEnv({ MERAKI_SANDBOX_ORG_ID: "" });
    const res = await handleSandboxCall(req, env);
    assert.equal(res.status, 422);
    const json = await res.json();
    assert.ok(Array.isArray(json.unresolved) && json.unresolved.length > 0);
    assert.equal(spy.wasCalled(), false, "missing config must fail closed, never fall back permissively");
  } finally {
    spy.restore();
  }
});

test("user-supplied key may target their own org/network even cross-origin", async () => {
  const spy = mockUpstreamFetch(200, { ok: true });
  try {
    const req = makeRequest({
      headers: {
        "cf-connecting-ip": freshIp(),
        origin: "https://some-other-app.example.com",
        "x-user-meraki-key": "user-own-key",
        "x-user-meraki-org": "999999",
        "x-user-meraki-network": "N_users_own_network",
      },
      body: { method: "GET", path: "/api/v1/networks/{networkId}/devices", env: "dev" },
    });
    const res = await handleSandboxCall(req, baseEnv());
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.usedUserKey, true);
    assert.equal(json.networkId, "N_users_own_network");
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

test("rapid write calls from one IP are throttled with 429 once the budget is exhausted", async () => {
  const spy = forbidUpstreamFetch();
  try {
    const ip = freshIp();
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const req = makeRequest({
        headers: { "cf-connecting-ip": ip }, // no Origin -> denied anyway, still exercises the limiter first
        body: { method: "POST", path: "/api/v1/networks/{networkId}/devices", env: "dev", body: {} },
      });
      const res = await handleSandboxCall(req, baseEnv());
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `expected a 429 among ${JSON.stringify(statuses)}`);
    assert.equal(spy.wasCalled(), false);
  } finally {
    spy.restore();
  }
});

test("every call emits one audit log line with the resolved target and outcome, and never the API key", async () => {
  const fetchSpy = mockUpstreamFetch(200, { ok: true });
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const req = makeRequest({
      headers: { "cf-connecting-ip": freshIp(), origin: "https://devnet-mcp.example.com" },
      body: { method: "GET", path: "/api/v1/networks/{networkId}/devices", env: "dev" },
    });
    const res = await handleSandboxCall(req, baseEnv());
    assert.equal(res.status, 200);
    assert.equal(lines.length, 1, "exactly one audit line per call");

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, "sandbox-call");
    assert.equal(entry.endpoint, "/api/sandbox-call");
    assert.equal(entry.method, "GET");
    assert.equal(entry.env, "dev");
    assert.equal(entry.resolvedNetworkId, "N_dev123");
    assert.equal(entry.usedServerKey, true);
    assert.equal(entry.outcome, "ok");
    assert.equal(entry.status, 200);
    assert.ok(!lines[0].includes("server-secret-key"), "the API key must never be logged");
  } finally {
    console.log = originalLog;
    fetchSpy.restore();
  }
});

test("a refused call also emits an audit line, recording the refusal outcome, not the API key", async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const req = makeRequest({
      headers: { "cf-connecting-ip": freshIp() }, // no Origin -> denied
      body: { method: "GET", path: "/api/v1/networks/{networkId}/devices", env: "dev" },
    });
    const res = await handleSandboxCall(req, baseEnv());
    assert.equal(res.status, 403);
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.outcome, "denied-origin");
    assert.equal(entry.status, 403);
    assert.ok(!lines[0].includes("server-secret-key"));
  } finally {
    console.log = originalLog;
  }
});
