import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTolerantJson } from "../public/parse-tolerant-json.js";

test("strict-valid JSON parses unchanged", () => {
  const raw = '{"a": 1, "b": "two", "c": [true, null]}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, false);
  assert.deepEqual(r.value, { a: 1, b: "two", c: [true, null] });
  assert.equal(r.error, undefined);
});

test('repairs "key: value" colon-inside-string bug (digits stay numeric)', () => {
  const raw = '{"destPort: 443"}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  // Digit-only values are emitted unquoted (typed as number)
  assert.deepEqual(r.value, { destPort: 443 });
});

test('repairs "key: value" with non-numeric string value (quoted)', () => {
  const raw = '{"srcPort: any"}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { srcPort: "any" });
});

test('repairs "key: value" with numeric value (unquoted)', () => {
  const raw = '{"port: 80"}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { port: 80 });
});

test('repairs "key: value" with boolean (unquoted)', () => {
  const raw = '{"enabled: true"}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { enabled: true });
});

test("repairs trailing comma before }", () => {
  const raw = '{"a": 1, "b": 2,}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { a: 1, b: 2 });
});

test("repairs trailing comma before ]", () => {
  const raw = '{"xs": [1, 2, 3,]}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { xs: [1, 2, 3] });
});

test("drops empty-valued trailing member (the syslogEnabled bug)", () => {
  const raw = `{
        "rules": [
          {
            "comment": "Allow TCP traffic to subnet with HTTP servers",
            "policy": "allow",
            "protocol": "tcp",
            "srcPort": "any",
            "srcCidr": "any",
            "destPort": "80",
            "destCidr": "192.168.1.0/24",
            "syslogEnabled":
          }
        ]
      }`;
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, {
    rules: [
      {
        comment: "Allow TCP traffic to subnet with HTTP servers",
        policy: "allow",
        protocol: "tcp",
        srcPort: "any",
        srcCidr: "any",
        destPort: "80",
        destCidr: "192.168.1.0/24",
      },
    ],
  });
  assert.ok(!("syslogEnabled" in r.value.rules[0]));
});

test("drops empty-valued middle member", () => {
  const raw = '{"a": 1, "b":, "c": 3}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { a: 1, c: 3 });
});

test("drops empty-valued leading member", () => {
  const raw = '{"a":, "b": 2}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { b: 2 });
});

test("drops empty-valued only member", () => {
  const raw = '{"a":}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, {});
});

test("drops multiple consecutive empty-valued members", () => {
  const raw = '{"a": 1, "b":, "c":, "d": 4}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { a: 1, d: 4 });
});

test("drops multiple empty-valued at end", () => {
  const raw = '{"a": 1, "b":, "c":}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { a: 1 });
});

test("returns error for unfixable malformed JSON", () => {
  const raw = '{this is not json at all';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, false);
  assert.equal(r.value, null);
  assert.ok(r.error && r.error.length > 0);
});

test("repairedSource contains the cleaned JSON string", () => {
  const raw = '{"a":, "b": 1}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.equal(typeof r.repairedSource, "string");
  // Should re-parse cleanly
  assert.deepEqual(JSON.parse(r.repairedSource), { b: 1 });
});

test("strips # line comments (the Microsoft SIP rule bug)", () => {
  const raw = `{
    "rules": [
      {
        "comment": "Microsoft SIP rule",
        "policy": "allow",
        "ipVersion": "ipv4",
        "protocol": "udp",
        "srcCidr": "any",
        "srcPort": "any",
        "dstCidr": "13.107.4.0/24", # Microsoft SIP subnet
        "dstPort": "5060", # SIP port
        "vlan": "any"
      }
    ]
  }`;
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, {
    rules: [
      {
        comment: "Microsoft SIP rule",
        policy: "allow",
        ipVersion: "ipv4",
        protocol: "udp",
        srcCidr: "any",
        srcPort: "any",
        dstCidr: "13.107.4.0/24",
        dstPort: "5060",
        vlan: "any",
      },
    ],
  });
});

test("strips // line comments", () => {
  const raw = `{
    "dstCidr": "52.112.0.0/14", // Teams media subnet
    "dstPort": "3478"
  }`;
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { dstCidr: "52.112.0.0/14", dstPort: "3478" });
});

test("strips comment on the last member, cleaning the leftover trailing comma", () => {
  const raw = `{
    "a": 1, # trailing comment
  }`;
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { a: 1 });
});

test("does not treat # inside a string value as a comment", () => {
  const raw = '{"color": "#ff0000", "tag": "a#b",}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { color: "#ff0000", tag: "a#b" });
});

test("does not treat // inside a URL string as a comment", () => {
  const raw = '{"url": "https://api.meraki.com/api/v1",}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { url: "https://api.meraki.com/api/v1" });
});

test("comment stripping respects escaped quotes inside strings", () => {
  const raw = '{"note": "say \\"hi\\" # not a comment", # real comment\n"b": 2}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { note: 'say "hi" # not a comment', b: 2 });
});

test("does not corrupt URLs containing colons inside strings", () => {
  const raw = '{"url": "https://example.com:8443/path"}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, false);
  assert.deepEqual(r.value, { url: "https://example.com:8443/path" });
});

test("does not corrupt CIDR strings (already-valid trailing member)", () => {
  const raw = '{"destCidr": "192.168.1.0/24"}';
  const r = parseTolerantJson(raw);
  assert.equal(r.repaired, false);
  assert.deepEqual(r.value, { destCidr: "192.168.1.0/24" });
});
