// Signed, short-lived OAuth `state` shared by the connector callbacks
// (Cloudflare, Vercel — mirroring the Slack connector's scheme). The state
// carries org/project/user so the public callback can trust who initiated the
// connect without a session cookie.

import crypto from "node:crypto";

export type OAuthStatePayload = {
  orgId: string;
  projectId: string;
  userId: string | null;
};

export function signState(p: OAuthStatePayload, secret: string): string {
  const body = `${p.orgId}.${p.projectId}.${p.userId ?? ""}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${Buffer.from(body, "utf8").toString("base64url")}.${sig}`;
}

export function verifyState(state: string, secret: string): OAuthStatePayload | null {
  const [payloadB64, sig] = state.split(".");
  if (!payloadB64 || !sig) return null;
  const body = Buffer.from(payloadB64, "base64url").toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const provided = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(provided, expectedBuf)) return null;
  const parts = body.split(".");
  if (parts.length !== 4) return null;
  const [orgId, projectId, userId, tsRaw] = parts as [string, string, string, string];
  if (!orgId || !projectId || !tsRaw) return null;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Date.now() - ts > 10 * 60 * 1000) return null;
  return { orgId, projectId, userId: userId || null };
}
