import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type Device, isDeviceIntegrationExpired, pollDeviceToken } from "./device-flow.js";

test("repeated token polling cannot extend the skill integration deadline", () => {
  const device: Device = {
    deviceCode: "device-code",
    userCode: "ABCD-EFGH",
    flow: "skill",
    createdAt: 1_000,
    expiresAt: 601_000,
    status: "approved",
    session: {
      cliToken: "cli-token",
      ingestKey: "ingest-key",
      userId: "user-id",
      orgId: "org-id",
      projectId: "project-id",
      userEmail: "owner@example.com",
      orgName: "Owner org",
    },
  };

  assert.equal(pollDeviceToken(device, 500_000).status, "approved");
  assert.equal(device.integrationExpiresAt, 1_100_000);
  assert.equal(pollDeviceToken(device, 550_000).status, "approved");
  assert.equal(device.integrationExpiresAt, 1_100_000);
  assert.equal(pollDeviceToken(device, 601_001).status, "expired");
  assert.equal(device.expiresAt, 601_000);
  assert.equal(isDeviceIntegrationExpired(device, 1_099_999), false);
  assert.equal(isDeviceIntegrationExpired(device, 1_100_001), true);
});
