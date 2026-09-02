import { test } from "node:test";
import assert from "node:assert/strict";
import { sameOrigin } from "../src/security.ts";

function req(url, headers = {}) {
  return new Request(url, { method: "POST", headers });
}

test("allows a matching Origin header", () => {
  const r = req("https://devnet-mcp.clydeford.net/api/chat", {
    origin: "https://devnet-mcp.clydeford.net",
  });
  assert.equal(sameOrigin(r), true);
});

test("rejects a foreign Origin header", () => {
  const r = req("https://devnet-mcp.clydeford.net/api/chat", {
    origin: "https://evil.example",
  });
  assert.equal(sameOrigin(r), false);
});

test("rejects a malformed Origin header", () => {
  const r = req("https://devnet-mcp.clydeford.net/api/chat", {
    origin: "not-a-url",
  });
  assert.equal(sameOrigin(r), false);
});

test("falls back to a matching Referer when Origin is absent", () => {
  const r = req("https://devnet-mcp.clydeford.net/api/chat", {
    referer: "https://devnet-mcp.clydeford.net/",
  });
  assert.equal(sameOrigin(r), true);
});

test("rejects a foreign Referer when Origin is absent", () => {
  const r = req("https://devnet-mcp.clydeford.net/api/chat", {
    referer: "https://evil.example/",
  });
  assert.equal(sameOrigin(r), false);
});

test("allows the request when neither Origin nor Referer is present", () => {
  const r = req("https://devnet-mcp.clydeford.net/api/chat");
  assert.equal(sameOrigin(r), true);
});

test("works unmodified for localhost dev", () => {
  const ok = req("http://localhost:8787/api/chat", {
    origin: "http://localhost:8787",
  });
  assert.equal(sameOrigin(ok), true);

  const bad = req("http://localhost:8787/api/chat", {
    origin: "https://evil.example",
  });
  assert.equal(sameOrigin(bad), false);
});
