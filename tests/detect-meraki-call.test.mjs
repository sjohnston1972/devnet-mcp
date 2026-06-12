import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectMerakiCall,
  normalizeMerakiPath,
} from "../public/detect-meraki-call.js";

/* --------- characterization: existing behavior --------- */

const SIP_SNIPPET = `curl -X PUT \\
  https://api.meraki.com/api/v1/networks/{networkId}/switch/accessControlLists \\
  -H 'Content-Type: application/json' \\
  -H 'X-Cisco-Meraki-API-Key: YOUR_API_KEY' \\
  -d '{
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
  }'`;

test("the failing Microsoft SIP snippet now yields a sendable body", () => {
  const call = detectMerakiCall(SIP_SNIPPET);
  assert.ok(call, "call detected");
  assert.equal(call.method, "PUT");
  assert.equal(call.path, "/api/v1/networks/{networkId}/switch/accessControlLists");
  assert.equal(call.bodyError, undefined);
  assert.equal(call.bodyRepaired, true);
  assert.equal(call.body.rules[0].dstCidr, "13.107.4.0/24");
  assert.equal(call.body.rules[0].dstPort, "5060");
});

test("detects GET with no body", () => {
  const call = detectMerakiCall(
    "curl https://api.meraki.com/api/v1/organizations/{organizationId}/networks",
  );
  assert.equal(call.method, "GET");
  assert.equal(call.body, null);
  assert.ok(!call.bodyError);
});

test("single-quoted -d body containing double quotes parses fully", () => {
  const call = detectMerakiCall(
    `curl -X POST https://api.meraki.com/api/v1/networks/{networkId}/merakiAuthUsers -d '{"name": "guest", "email": "g@x.com"}'`,
  );
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { name: "guest", email: "g@x.com" });
});

test("returns null for non-Meraki text", () => {
  assert.equal(detectMerakiCall("curl https://example.com/api/v1/things"), null);
});

test("normalizeMerakiPath forces literal IDs to placeholders", () => {
  assert.equal(
    normalizeMerakiPath("/api/v1/networks/N_123456/appliance/firewall/l3FirewallRules"),
    "/api/v1/networks/{networkId}/appliance/firewall/l3FirewallRules",
  );
  assert.equal(
    normalizeMerakiPath("/api/v1/organizations/549236/networks?perPage=10"),
    "/api/v1/organizations/{organizationId}/networks?perPage=10",
  );
  assert.equal(
    normalizeMerakiPath("/api/v1/devices/Q2XX-XXXX-XXXX/switch/ports"),
    "/api/v1/devices/{serial}/switch/ports",
  );
});

test("normalizeMerakiPath leaves templated segments alone", () => {
  assert.equal(
    normalizeMerakiPath("/api/v1/networks/{networkId}/switch/accessControlLists"),
    "/api/v1/networks/{networkId}/switch/accessControlLists",
  );
});

/* --------- bug fixes: body extraction --------- */

test("double-quoted -d body with escaped quotes is not truncated", () => {
  const call = detectMerakiCall(
    `curl -X PUT https://api.meraki.com/api/v1/networks/{networkId}/switch/accessControlLists -d "{\\"rules\\": [{\\"comment\\": \\"sip\\", \\"policy\\": \\"allow\\"}]}"`,
  );
  assert.equal(call.bodyError, undefined, `bodyError: ${call.bodyError}`);
  assert.deepEqual(call.body, {
    rules: [{ comment: "sip", policy: "allow" }],
  });
});

test("--data-binary bodies are detected", () => {
  const call = detectMerakiCall(
    `curl -X PUT https://api.meraki.com/api/v1/networks/{networkId}/appliance/firewall/l3FirewallRules --data-binary '{"rules": []}'`,
  );
  assert.deepEqual(call.body, { rules: [] });
});
