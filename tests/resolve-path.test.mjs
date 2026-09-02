import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePath } from "../src/resolve-path.ts";

test("resolves {serial} when a serial is provided", () => {
  const { resolvedPath, missing } = resolvePath("/api/v1/devices/{serial}/clients", {
    orgId: "123",
    netId: "N_1",
    serial: "Q2XX-XXXX-XXXX",
  });
  assert.equal(resolvedPath, "/api/v1/devices/Q2XX-XXXX-XXXX/clients");
  assert.deepEqual(missing, []);
});

test("resolves {organizationId} and {networkId} alongside {serial}", () => {
  const { resolvedPath, missing } = resolvePath(
    "/api/v1/organizations/{organizationId}/networks/{networkId}/devices/{serial}",
    { orgId: "123", netId: "N_1", serial: "Q2XX-XXXX-XXXX" },
  );
  assert.equal(resolvedPath, "/api/v1/organizations/123/networks/N_1/devices/Q2XX-XXXX-XXXX");
  assert.deepEqual(missing, []);
});

test("case/underscore variants resolve ({organization_id}, {ORG_ID}, {deviceSerial})", () => {
  const { resolvedPath, missing } = resolvePath(
    "/api/v1/organizations/{organization_id}/networks/{NET_ID}/devices/{deviceSerial}",
    { orgId: "123", netId: "N_1", serial: "Q2XX-XXXX-XXXX" },
  );
  assert.equal(resolvedPath, "/api/v1/organizations/123/networks/N_1/devices/Q2XX-XXXX-XXXX");
  assert.deepEqual(missing, []);
});

test("{serial} is reported missing when no serial is supplied", () => {
  const { resolvedPath, missing } = resolvePath("/api/v1/devices/{serial}/clients", {
    orgId: "123",
    netId: "N_1",
  });
  assert.equal(resolvedPath, "/api/v1/devices/{serial}/clients");
  assert.deepEqual(missing, ["{serial}"]);
});

test("unresolved placeholders of any kind end up in missing", () => {
  const { missing } = resolvePath("/api/v1/widgets/{widgetId}", {});
  assert.deepEqual(missing, ["{widgetId}"]);
});
