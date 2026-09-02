import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameOrigin, resolveTarget, SlidingWindowRateLimiter } from "../src/sandbox-guard.ts";

const serverConfig = { orgId: "111111", networkId: "N_dev123", serial: "Q2XX-DEV1-SER1" };

test("resolveTarget: server key + no override headers uses the configured slot", () => {
  const d = resolveTarget(false, {}, serverConfig);
  assert.equal(d.ok, true);
  assert.equal(d.orgId, "111111");
  assert.equal(d.netId, "N_dev123");
});

test("resolveTarget: server key + mismatched org header is rejected, not coerced", () => {
  const d = resolveTarget(false, { org: "999999" }, serverConfig);
  assert.equal(d.ok, false);
  assert.equal(d.orgId, "");
  assert.match(d.reason, /organization/);
});

test("resolveTarget: server key + mismatched network header is rejected, not coerced", () => {
  const d = resolveTarget(false, { net: "N_other" }, serverConfig);
  assert.equal(d.ok, false);
  assert.equal(d.netId, "");
  assert.match(d.reason, /network/);
});

test("resolveTarget: server key + org header equal to configured value is a no-op, not an error", () => {
  const d = resolveTarget(false, { org: "111111", net: "N_dev123" }, serverConfig);
  assert.equal(d.ok, true);
  assert.equal(d.orgId, "111111");
  assert.equal(d.netId, "N_dev123");
});

test("resolveTarget: server key + mismatched serial header is rejected, not coerced", () => {
  const d = resolveTarget(false, { serial: "Q2XX-OTHR-DEV2" }, serverConfig);
  assert.equal(d.ok, false);
  assert.equal(d.serial, "");
  assert.match(d.reason, /device/);
});

test("resolveTarget: server key fails closed when server config is unset and a header is sent", () => {
  const d = resolveTarget(false, { org: "999999" }, { orgId: "", networkId: "" });
  assert.equal(d.ok, false);
});

test("resolveTarget: user-supplied key may target their own org/network", () => {
  const d = resolveTarget(true, { org: "999999", net: "N_other" }, serverConfig);
  assert.equal(d.ok, true);
  assert.equal(d.orgId, "999999");
  assert.equal(d.netId, "N_other");
});

test("resolveTarget: user-supplied key with no override headers falls back to server config", () => {
  const d = resolveTarget(true, {}, serverConfig);
  assert.equal(d.ok, true);
  assert.equal(d.orgId, "111111");
  assert.equal(d.netId, "N_dev123");
});

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

test("SlidingWindowRateLimiter: allows up to the limit, then blocks", () => {
  let now = 0;
  const limiter = new SlidingWindowRateLimiter(3, 1000, () => now);
  assert.equal(limiter.check("ip1"), true);
  assert.equal(limiter.check("ip1"), true);
  assert.equal(limiter.check("ip1"), true);
  assert.equal(limiter.check("ip1"), false, "4th call within the window must be blocked");
});

test("SlidingWindowRateLimiter: window slides, so old hits expire", () => {
  let now = 0;
  const limiter = new SlidingWindowRateLimiter(2, 1000, () => now);
  assert.equal(limiter.check("ip1"), true);
  assert.equal(limiter.check("ip1"), true);
  assert.equal(limiter.check("ip1"), false);
  now = 1500; // past the 1000ms window
  assert.equal(limiter.check("ip1"), true, "hits outside the window no longer count");
});

test("SlidingWindowRateLimiter: separate keys have separate budgets", () => {
  let now = 0;
  const limiter = new SlidingWindowRateLimiter(1, 1000, () => now);
  assert.equal(limiter.check("ip1"), true);
  assert.equal(limiter.check("ip2"), true, "a different key is not affected by ip1's budget");
  assert.equal(limiter.check("ip1"), false);
});
