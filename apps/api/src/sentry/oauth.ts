import crypto from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000;

export type SentryOAuthState = {
  orgId: string;
  projectId: string;
  userId: string;
  returnTo: "settings" | "onboarding";
};

export function buildSentryAuthorizeUrl(input: {
  appSlug: string;
  state: string;
}): string {
  const url = new URL(
    `/sentry-apps/${encodeURIComponent(input.appSlug)}/external-install/`,
    "https://sentry.io",
  );
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function signSentryState(input: SentryOAuthState, secret: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...input, issuedAt: now }), "utf8").toString(
    "base64url",
  );
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifySentryState(
  state: string,
  secret: string,
  now = Date.now(),
): SentryOAuthState | null {
  const [body, signature] = state.split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  if (
    typeof payload.orgId !== "string" ||
    typeof payload.projectId !== "string" ||
    typeof payload.userId !== "string" ||
    (payload.returnTo !== undefined &&
      payload.returnTo !== "settings" &&
      payload.returnTo !== "onboarding") ||
    typeof payload.issuedAt !== "number" ||
    now < payload.issuedAt ||
    now - payload.issuedAt > STATE_TTL_MS
  ) {
    return null;
  }
  return {
    orgId: payload.orgId,
    projectId: payload.projectId,
    userId: payload.userId,
    returnTo: payload.returnTo === "onboarding" ? "onboarding" : "settings",
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
