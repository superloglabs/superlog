import crypto from "node:crypto";

type GcpState = { connectionId: string; issuedAt: number };

export function signGcpState(connectionId: string, secret: string): string {
  const body = Buffer.from(
    JSON.stringify({ connectionId, issuedAt: Date.now() } satisfies GcpState),
    "utf8",
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyGcpState(state: string, secret: string): GcpState | null {
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
    if (typeof parsed.connectionId !== "string" || typeof parsed.issuedAt !== "number") return null;
    if (Date.now() - parsed.issuedAt > 10 * 60 * 1000) return null;
    return { connectionId: parsed.connectionId, issuedAt: parsed.issuedAt };
  } catch {
    return null;
  }
}
