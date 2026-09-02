import { test } from "node:test";
import assert from "node:assert/strict";
import { callMcpToolWithSession, closeMcpSession } from "../src/mcp-session.ts";

const MCP_URL = "https://example.test/mcp";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function withStubFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("callMcpToolWithSession issues only a tools/call request (no initialize/notifications)", async () => {
  const calls = [];
  const session = { "content-type": "application/json", "mcp-session-id": "sess-1" };

  await withStubFetch(async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method: opts.method, rpcMethod: body?.method, id: body?.id });
    if (body?.method === "tools/call") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { structuredContent: { result: [{ name: "Widget" }] } },
      });
    }
    throw new Error(`unexpected fetch during callMcpToolWithSession: ${JSON.stringify(body)}`);
  }, async () => {
    const result = await callMcpToolWithSession(MCP_URL, session, "Some-Tool", { keyword: "x" }, 7);
    assert.equal(result.structuredContent?.result?.length, 1);
  });

  assert.equal(calls.length, 1, "should make exactly one HTTP call");
  assert.equal(calls[0].rpcMethod, "tools/call");
  assert.equal(calls[0].id, 7, "should use the caller-supplied JSON-RPC id");
  assert.ok(
    !calls.some((c) => c.rpcMethod === "initialize"),
    "must not perform a fresh handshake when a session is already open",
  );
});

test("two callMcpToolWithSession calls on one session use distinct ids and no extra handshake", async () => {
  const calls = [];
  const session = { "content-type": "application/json", "mcp-session-id": "sess-1" };

  await withStubFetch(async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    return jsonResponse({
      jsonrpc: "2.0",
      id: body.id,
      result: { structuredContent: { result: [] } },
    });
  }, async () => {
    await Promise.all([
      callMcpToolWithSession(MCP_URL, session, "Tool-A", {}, 2),
      callMcpToolWithSession(MCP_URL, session, "Tool-B", {}, 3),
    ]);
  });

  assert.equal(calls.length, 2);
  assert.equal(calls.filter((c) => c.method === "initialize").length, 0);
  const ids = calls.map((c) => c.id).sort();
  assert.deepEqual(ids, [2, 3]);
});

test("closeMcpSession sends a DELETE carrying the session's mcp-session-id header", async () => {
  const calls = [];
  const session = { "content-type": "application/json", "mcp-session-id": "sess-42" };

  await withStubFetch(async (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers });
    return new Response(null, { status: 204 });
  }, async () => {
    await closeMcpSession(MCP_URL, session);
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].headers["mcp-session-id"], "sess-42");
});

test("closeMcpSession is a no-op when the session has no mcp-session-id", async () => {
  const calls = [];
  const session = { "content-type": "application/json" };

  await withStubFetch(async (url, opts) => {
    calls.push(opts);
    return new Response(null, { status: 204 });
  }, async () => {
    await closeMcpSession(MCP_URL, session);
  });

  assert.equal(calls.length, 0);
});

test("closeMcpSession never throws even if the DELETE fails", async () => {
  const session = { "content-type": "application/json", "mcp-session-id": "sess-1" };

  await withStubFetch(async () => {
    throw new Error("network down");
  }, async () => {
    await assert.doesNotReject(() => closeMcpSession(MCP_URL, session));
  });
});
