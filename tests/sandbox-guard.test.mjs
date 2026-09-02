import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameOrigin } from "../src/sandbox-guard.ts";

test("isSameOrigin: matching Origin header is same-origin", () => {
  const req = new Request("https://app.example.com/api/sandbox-call", {
    method: "POST",
    headers: { origin: "https://app.example.com" },
  });
  assert.equal(isSameOrigin(req, new URL("https://app.example.com/api/sandbox-call")), true);
});

test("isSameOrigin: mismatched Origin header is cross-origin", () => {
  const req = new Request("https://app.example.com/api/sandbox-call", {
    method: "POST",
    headers: { origin: "https://evil.example.com" },
  });
  assert.equal(isSameOrigin(req, new URL("https://app.example.com/api/sandbox-call")), false);
});

test("isSameOrigin: Referer used when Origin is absent", () => {
  const req = new Request("https://app.example.com/api/sandbox-call", {
    method: "POST",
    headers: { referer: "https://app.example.com/index.html" },
  });
  assert.equal(isSameOrigin(req, new URL("https://app.example.com/api/sandbox-call")), true);
});

test("isSameOrigin: fails closed when neither Origin nor Referer is present (raw curl)", () => {
  const req = new Request("https://app.example.com/api/sandbox-call", { method: "POST" });
  assert.equal(isSameOrigin(req, new URL("https://app.example.com/api/sandbox-call")), false);
});
