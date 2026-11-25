import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type Device,
  createDeviceStore,
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
    deviceCode: `device-${code}`,
    userCode: `USER-${code}`,
    flow: "cli",
    createdAt,
    expiresAt: createdAt + 600_000,
    status: "pending",
  };
}

test("the device store finds devices by either code", () => {
  const store = createDeviceStore({ maxDevices: 10 });
  const device = pendingDevice("A", 0);
  assert.equal(store.add(device, 0), true);
  assert.equal(store.byDeviceCode("device-A"), device);
  assert.equal(store.byUserCode("USER-A"), device);
  assert.equal(store.byUserCode("USER-B"), undefined);
});

test("the device store drops expired devices and refuses new ones when full", () => {
  const store = createDeviceStore({ maxDevices: 2 });
  assert.equal(store.add(pendingDevice("A", 0), 0), true);
  assert.equal(store.add(pendingDevice("B", 0), 0), true);
  assert.equal(store.add(pendingDevice("C", 1_000), 1_000), false);
  assert.equal(store.size(), 2);

  assert.equal(store.add(pendingDevice("D", 700_000), 700_000), true);
  assert.equal(store.byDeviceCode("device-A"), undefined);
  assert.equal(store.byUserCode("USER-B"), undefined);
  assert.equal(store.size(), 1);
});

test("the device store keeps a skill device through its integration window", () => {
  const store = createDeviceStore({ maxDevices: 1 });
  const device = {
    ...pendingDevice("A", 0),
    flow: "skill" as const,
    integrationExpiresAt: 1_200_000,
  };
  store.add(device, 0);
  assert.equal(store.add(pendingDevice("B", 700_000), 700_000), false);
  assert.equal(store.byUserCode("USER-A"), device);
});
