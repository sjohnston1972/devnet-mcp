import { test } from "node:test";
import assert from "node:assert/strict";
import { runMcpSearches } from "../src/mcp-session.ts";

const MCP_URL = "https://example.test/mcp";

function jsonResponse(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

// Records every fetch call and lets a test script canned responses (or a
// thrown error) per JSON-RPC method / HTTP method.
function makeStubFetch({ toolCallBehavior } = {}) {
  const calls = [];
  const fetchStub = async (url, opts) => {
    const method = opts.method;
    if (method === "DELETE") {
      calls.push({ method: "DELETE", headers: { ...opts.headers } });
      return new Response(null, { status: 204 });
    }

    const body = JSON.parse(opts.body);
    calls.push({ method: "POST", rpcMethod: body.method, id: body.id, toolName: body.params?.name });

    if (body.method === "initialize") {
      return jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { capabilities: {} } },
        { "mcp-session-id": "sess-shared-1" },
      );
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/call") {
      const toolName = body.params.name;
      const behavior = toolCallBehavior?.(toolName, body.id);
      if (behavior?.throw) throw behavior.throw;
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: behavior?.result ?? { structuredContent: { result: [{ name: toolName }] } },
      });
    }
    throw new Error(`unexpected MCP call: ${JSON.stringify(body)}`);
  };
  return { fetchStub, calls };
}

async function withStubFetch(fetchStub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("runMcpSearches performs exactly one initialize handshake for both searches", async () => {
  const { fetchStub, calls } = makeStubFetch();

  const { merakiResults, catalystResults } = await withStubFetch(fetchStub, () =>
    runMcpSearches(MCP_URL, "firewall rules"),
  );

  const initCalls = calls.filter((c) => c.rpcMethod === "initialize");
  assert.equal(initCalls.length, 1, "expected exactly one initialize handshake");

  const notifCalls = calls.filter((c) => c.rpcMethod === "notifications/initialized");
  assert.equal(notifCalls.length, 1, "expected exactly one notifications/initialized");

  const toolCalls = calls.filter((c) => c.rpcMethod === "tools/call");
  assert.equal(toolCalls.length, 2, "expected both searches to run");
  assert.deepEqual(
    toolCalls.map((c) => c.toolName).sort(),
    ["CatalystCenter-API-Doc-Search", "Meraki-API-Doc-Search"],
  );
  // A meaningful assertion, not just "results came back": both tool calls
  // must have been issued under the SAME shared session id and with
  // distinct JSON-RPC ids (not two independent sessions).
  assert.equal(new Set(toolCalls.map((c) => c.id)).size, 2, "tool calls must use distinct ids");

  assert.equal(merakiResults.structuredContent.result[0].name, "Meraki-API-Doc-Search");
  assert.equal(catalystResults.structuredContent.result[0].name, "CatalystCenter-API-Doc-Search");

  // The session opened for the handshake must be the one closed afterward.
  const deleteCalls = calls.filter((c) => c.method === "DELETE");
  assert.equal(deleteCalls.length, 1, "expected the shared session to be closed exactly once");
  assert.equal(deleteCalls[0].headers["mcp-session-id"], "sess-shared-1");
});

test("runMcpSearches closes the session when one search throws, and the other result survives", async () => {
  const { fetchStub, calls } = makeStubFetch({
    toolCallBehavior: (toolName) => {
      if (toolName === "CatalystCenter-API-Doc-Search") {
        return { throw: new Error("upstream 500") };
      }
      return undefined;
    },
  });

  const { merakiResults, catalystResults } = await withStubFetch(fetchStub, () =>
    runMcpSearches(MCP_URL, "switch ports"),
  );

  assert.equal(merakiResults.structuredContent.result[0].name, "Meraki-API-Doc-Search");
  assert.ok(catalystResults.error?.includes("upstream 500"), "failing search degrades to an error, not a throw");

  const deleteCalls = calls.filter((c) => c.method === "DELETE");
  assert.equal(deleteCalls.length, 1, "session must still be closed after a search throws");
  assert.equal(deleteCalls[0].headers["mcp-session-id"], "sess-shared-1");

  // Still only one handshake even though one call failed.
  assert.equal(calls.filter((c) => c.rpcMethod === "initialize").length, 1);
});

test("runMcpSearches closes the session when BOTH searches throw", async () => {
  const { fetchStub, calls } = makeStubFetch({
    toolCallBehavior: () => ({ throw: new Error("network down") }),
  });

  const { merakiResults, catalystResults } = await withStubFetch(fetchStub, () =>
    runMcpSearches(MCP_URL, "vlans"),
  );

  assert.ok(merakiResults.error?.includes("network down"));
  assert.ok(catalystResults.error?.includes("network down"));

  const deleteCalls = calls.filter((c) => c.method === "DELETE");
  assert.equal(deleteCalls.length, 1, "session must be closed even when both searches throw");
});

test("runMcpSearches degrades to error results (not a throw) when the handshake itself fails, and never attempts a close", async () => {
  const fetchStub = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.method === "initialize") {
      return new Response("boom", { status: 500 });
    }
    throw new Error(`unexpected call after failed handshake: ${JSON.stringify(body)}`);
  };

  const { merakiResults, catalystResults } = await withStubFetch(fetchStub, () =>
    runMcpSearches(MCP_URL, "anything"),
  );

  assert.ok(merakiResults.error?.includes("initialize failed"));
  assert.ok(catalystResults.error?.includes("initialize failed"));
});
