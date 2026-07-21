import type { Hono } from "hono";
import { requestBodyLimit } from "../request-body-limits.js";
import { type SentryIssueEvent, hasValidSentrySignature, parseSentryIssueEvent } from "./domain.js";

export const SENTRY_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;

export type SentryPublicDependencies = {
  clientSecret: string | undefined;
  receiveIssueEvent: (event: SentryIssueEvent) => Promise<void>;
  revokeInstallation?: (installationId: string) => Promise<void>;
};

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountSentryPublic(app: Hono<any>, deps: SentryPublicDependencies): void {
  app.use("/sentry/webhook", requestBodyLimit(SENTRY_WEBHOOK_BODY_BYTES));
  app.post("/sentry/webhook", async (c) => {
    if (!deps.clientSecret) return c.json({ error: "sentry not configured" }, 503);
    const rawBody = await c.req.text();
    const signature = c.req.header("sentry-hook-signature") ?? "";
    if (!hasValidSentrySignature({ rawBody, signature, clientSecret: deps.clientSecret })) {
      return c.json({ error: "invalid signature" }, 401);
    }
    if (c.req.header("sentry-hook-resource") === "installation") {
      const payload = parseInstallationDeleted(rawBody);
      if (payload && deps.revokeInstallation) await deps.revokeInstallation(payload);
      return c.json({ accepted: !!payload }, 202);
    }
    if (c.req.header("sentry-hook-resource") !== "issue") {
      return c.json({ accepted: false }, 202);
    }
    const event = parseSentryIssueEvent(rawBody);
    if (!event) return c.json({ accepted: false }, 202);
    await deps.receiveIssueEvent(event);
    return c.json({ accepted: true }, 202);
  });
}

function parseInstallationDeleted(rawBody: string): string | null {
  try {
    const payload = JSON.parse(rawBody) as {
      action?: unknown;
      installation?: { uuid?: unknown };
    };
    return payload.action === "deleted" && typeof payload.installation?.uuid === "string"
      ? payload.installation.uuid
      : null;
  } catch {
    return null;
  }
}
