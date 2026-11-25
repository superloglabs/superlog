import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type Device,
  createDeviceRegistry,
  isDeviceIntegrationExpired,
  pollDeviceToken,
} from "./device-flow.js";

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

function pendingDevice(code: string, createdAt: number): Device {
  return {
    deviceCode: `dev-${code}`,
    userCode: code,
    flow: "cli",
    createdAt,
    expiresAt: createdAt + 600_000,
    status: "pending",
  };
}

test("the device registry drops expired devices and refuses new ones when full", () => {
  const registry = createDeviceRegistry({ maxDevices: 2 });
  assert.equal(registry.add(pendingDevice("AAAA", 0), 0), true);
  assert.equal(registry.add(pendingDevice("BBBB", 100_000), 100_000), true);
  // Full while both are live.
  assert.equal(registry.add(pendingDevice("CCCC", 200_000), 200_000), false);
  assert.equal(registry.byUserCode("CCCC"), undefined);
  // AAAA expires at 600_000; adding after that evicts it and makes room.
  assert.equal(registry.add(pendingDevice("DDDD", 600_001), 600_001), true);
  assert.equal(registry.byUserCode("AAAA"), undefined);
  assert.equal(registry.byDeviceCode("dev-AAAA"), undefined);
  assert.equal(registry.byUserCode("BBBB")?.deviceCode, "dev-BBBB");
  assert.equal(registry.byDeviceCode("dev-DDDD")?.userCode, "DDDD");
});

test("the device registry keeps an approved skill device for its integration window", () => {
  const registry = createDeviceRegistry({ maxDevices: 10 });
  const device = {
    ...pendingDevice("SKIL", 0),
    flow: "skill" as const,
    status: "approved" as const,
  };
  device.integrationExpiresAt = 1_000_000;
  registry.add(device, 0);
  registry.add(pendingDevice("LATE", 700_000), 700_000);
  assert.equal(registry.byUserCode("SKIL"), device);
  registry.add(pendingDevice("LAST", 1_000_001), 1_000_001);
  assert.equal(registry.byUserCode("SKIL"), undefined);
});
