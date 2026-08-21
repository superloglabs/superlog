import crypto from "node:crypto";
import { GCP_AUTHORIZATION_TTL_MS } from "./domain.js";

export type GcpAuthorizationIntent = {
  action: "disconnect";
  connectionId: string;
};

type GcpState = {
  authorizationId: string;
  issuedAt: number;
} & Partial<GcpAuthorizationIntent>;

export function signGcpState(
  authorizationId: string,
  secret: string,
  issuedAt = Date.now(),
  intent?: GcpAuthorizationIntent,
): string {
  const body = Buffer.from(
    JSON.stringify({ authorizationId, issuedAt, ...intent } satisfies GcpState),
    "utf8",
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyGcpState(state: string, secret: string, now = Date.now()): GcpState | null {
  const [body, signature] = state.split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<GcpState>;
    if (typeof parsed.authorizationId !== "string" || typeof parsed.issuedAt !== "number") {
      return null;
    }
    const hasIntent = parsed.action !== undefined || parsed.connectionId !== undefined;
    if (
      hasIntent &&
      (parsed.action !== "disconnect" ||
        typeof parsed.connectionId !== "string" ||
        parsed.connectionId.length === 0)
    ) {
      return null;
    }
    if (now - parsed.issuedAt > GCP_AUTHORIZATION_TTL_MS) return null;
    return {
      authorizationId: parsed.authorizationId,
      issuedAt: parsed.issuedAt,
      ...(hasIntent
        ? { action: parsed.action as "disconnect", connectionId: parsed.connectionId as string }
        : {}),
    };
  } catch {
    return null;
  }
}
