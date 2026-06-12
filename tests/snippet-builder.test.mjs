import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseRelaxedFlow,
  extractRequestExample,
  buildCurlSnippet,
} from "../src/snippet-builder.ts";
import { detectMerakiCall } from "../public/detect-meraki-call.js";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const MERAKI_BASE = "https://api.meraki.com/api/v1";

/* --------- parseRelaxedFlow --------- */

test("parses flat object with typed scalars", () => {
  assert.deepEqual(parseRelaxedFlow("{a: 1, b: true, c: hello world, d: null}"), {
    a: 1,
    b: true,
    c: "hello world",
    d: null,
  });
});

test("parses nested objects and arrays", () => {
  assert.deepEqual(
    parseRelaxedFlow("{rules: [{policy: allow, destPort: 443}], syslogDefaultRule: true}"),
    { rules: [{ policy: "allow", destPort: 443 }], syslogDefaultRule: true },
  );
});

test("commas inside a scalar value rejoin the previous value", () => {
  assert.deepEqual(parseRelaxedFlow("{srcPort: 80,443, policy: allow}"), {
    srcPort: "80,443",
    policy: "allow",
  });
});

test("strips matching single quotes from scalars", () => {
  assert.deepEqual(parseRelaxedFlow("{policy: 'allow'}"), { policy: "allow" });
});

test("scalars with colons (timestamps) survive", () => {
  assert.deepEqual(parseRelaxedFlow("{expiresAt: 2018-03-13T00:00:00.090210Z}"), {
    expiresAt: "2018-03-13T00:00:00.090210Z",
  });
});

/* --------- extractRequestExample --------- */

test("extracts the L3 firewall rules request example (real spec)", () => {
  const example = extractRequestExample(fixture("mcp-l3-firewall").openapi_specification);
  assert.deepEqual(example, {
    rules: [
      {
        comment: "Allow TCP traffic to subnet with HTTP servers.",
        policy: "allow",
        protocol: "tcp",
        srcPort: "Any",
        srcCidr: "Any",
        destPort: 443,
        destCidr: "192.168.1.0/24",
        syslogEnabled: false,
      },
    ],
    syslogDefaultRule: true,
  });
});

test("extracts the auth-user request example with awkward scalars (real spec)", () => {
  const example = extractRequestExample(fixture("mcp-auth-user").openapi_specification);
  assert.deepEqual(example, {
    email: "miles@meraki.com",
    name: "Miles Meraki",
    password: "secret",
    accountType: "802.1X",
    emailPasswordToUser: false,
    isAdmin: false,
    authorizations: [{ ssidNumber: 1, expiresAt: "2018-03-13T00:00:00.090210Z" }],
  });
});

test("returns null when the operation has no requestBody (real GET spec)", () => {
  assert.equal(extractRequestExample(fixture("mcp-get-networks").openapi_specification), null);
});

test("returns null on garbage input instead of throwing", () => {
  assert.equal(extractRequestExample("requestBody example: {{{"), null);
  assert.equal(extractRequestExample(""), null);
});

/* --------- buildCurlSnippet --------- */

test("PUT snippet round-trips through detectMerakiCall with zero repairs", () => {
  const fx = fixture("mcp-l3-firewall");
  const snippet = buildCurlSnippet({
    method: fx.api_method,
    path: fx.api_path,
    spec: fx.openapi_specification,
    base: MERAKI_BASE,
  });
  assert.match(snippet, /^curl -X PUT \\$/m);
  assert.match(snippet, /X-Cisco-Meraki-API-Key: YOUR_API_KEY/);
  assert.ok(!snippet.includes("#"), "no comments in generated snippet");

  const call = detectMerakiCall(snippet);
  assert.ok(call, "detected");
  assert.equal(call.method, "PUT");
  assert.equal(call.path, "/api/v1/networks/{networkId}/appliance/firewall/l3FirewallRules");
  assert.ok(!call.bodyError, `bodyError: ${call.bodyError}`);
  assert.equal(call.bodyRepaired, false, "body must be strict JSON, no repair needed");
  assert.equal(call.body.rules[0].destCidr, "192.168.1.0/24");
});

test("GET snippet has no -d payload and round-trips", () => {
  const fx = fixture("mcp-get-networks");
  const snippet = buildCurlSnippet({
    method: fx.api_method,
    path: fx.api_path,
    spec: fx.openapi_specification,
    base: MERAKI_BASE,
  });
  assert.ok(!snippet.includes("-d "), "no body on GET");
  const call = detectMerakiCall(snippet);
  assert.equal(call.method, "GET");
  assert.equal(call.path, "/api/v1/organizations/{organizationId}/networks");
  assert.equal(call.body, null);
});

test("apostrophes in example values cannot break the bash single-quoted -d", () => {
  const spec =
    "requestBody: {content: {application/json: {schema: {type: object}, example: {comment: Bob's rule}}}, required: false}, responses: {200: {}}";
  const snippet = buildCurlSnippet({
    method: "put",
    path: "/networks/{networkId}/appliance/firewall/l3FirewallRules",
    spec,
    base: MERAKI_BASE,
  });
  const dBody = snippet.match(/-d '([\s\S]+)'\s*$/)?.[1] ?? "";
  assert.ok(!dBody.includes("'"), "no raw single quote inside -d '...'");
  const call = detectMerakiCall(snippet);
  assert.equal(call.body.comment, "Bob's rule");
});

test("write op without a parseable example still yields a bodyless snippet", () => {
  const snippet = buildCurlSnippet({
    method: "post",
    path: "/networks/{networkId}/merakiAuthUsers",
    spec: "no example here",
    base: MERAKI_BASE,
  });
  assert.match(snippet, /^curl -X POST \\$/m);
  assert.ok(!snippet.includes("-d "));
});
