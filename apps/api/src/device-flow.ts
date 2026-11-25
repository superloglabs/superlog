export const DEVICE_TTL_MS = 10 * 60 * 1000;

// CLI devices release a gateway session after the GitHub installation gate.
// Skill devices release only an ingest key and may then launch integration
// installation flows from the user's browser.
export type DeviceFlow = "cli" | "skill";

export type DeviceSession = {
  cliToken: string;
  ingestKey: string;
  userId: string;
  orgId: string;
  projectId: string;
  userEmail: string;
  orgName: string;
};

export type Device = {
  deviceCode: string;
  userCode: string;
  flow: DeviceFlow;
  createdAt: number;
  expiresAt: number;
  // Opens once when the skill first receives its token, giving the user a
  // full click-through window without allowing repeated polls to renew it.
  integrationExpiresAt?: number;
  // user_linked holds CLI devices at their GitHub installation gate. Skill
  // devices transition directly to approved after account activation.
  status: "pending" | "user_linked" | "approved" | "expired";
  session?: DeviceSession;
};

export type DeviceTokenGrant =
  | { status: "expired" }
  | { status: "authorization_pending" }
  | { status: "approved"; session: DeviceSession };

export function pollDeviceToken(device: Device, now: number): DeviceTokenGrant {
  if (isDeviceExpired(device, now)) return { status: "expired" };
  if (device.status !== "approved" || !device.session) {
    return { status: "authorization_pending" };
  }
  if (device.flow === "skill" && device.integrationExpiresAt === undefined) {
    device.integrationExpiresAt = now + DEVICE_TTL_MS;
  }
  return { status: "approved", session: device.session };
}

export function isDeviceExpired(device: Device, now: number): boolean {
  return now > device.expiresAt;
}

export function isDeviceIntegrationExpired(device: Device, now: number): boolean {
  return now > (device.integrationExpiresAt ?? device.expiresAt);
}

// Devices waiting for approval, kept in this process. Anyone can start a
// device flow, so the store drops devices an hour after their last deadline
// and refuses new ones while it is full.
export const MAX_DEVICES = 10_000;
// Expired devices are kept this long past their last deadline, so a late
// poll or activation still gets the expired answer.
export const EXPIRED_DEVICE_GRACE_MS = 60 * 60 * 1000;

export type DeviceStore = ReturnType<typeof createDeviceStore>;

export function createDeviceStore({ maxDevices = MAX_DEVICES }: { maxDevices?: number } = {}) {
  const byDeviceCode = new Map<string, Device>();
  const byUserCode = new Map<string, Device>();
  let nextSweepAt = 0;

  function sweep(now: number): void {
    for (const [deviceCode, device] of byDeviceCode) {
      if (!isDeviceIntegrationExpired(device, now - EXPIRED_DEVICE_GRACE_MS)) continue;
      byDeviceCode.delete(deviceCode);
      if (byUserCode.get(device.userCode) === device) byUserCode.delete(device.userCode);
    }
    nextSweepAt = now + 60_000;
  }

  return {
    // False when the store is full of devices it still keeps.
    add(device: Device, now: number): boolean {
      if (now >= nextSweepAt || byDeviceCode.size >= maxDevices) sweep(now);
      if (byDeviceCode.size >= maxDevices) return false;
      byDeviceCode.set(device.deviceCode, device);
      byUserCode.set(device.userCode, device);
      return true;
    },
    byDeviceCode(deviceCode: string): Device | undefined {
      return byDeviceCode.get(deviceCode);
    },
    byUserCode(userCode: string): Device | undefined {
      return byUserCode.get(userCode);
    },
    size(): number {
      return byDeviceCode.size;
    },
  };
}
