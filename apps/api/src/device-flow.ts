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
