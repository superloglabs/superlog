import type { Hono } from "hono";
import { requestBodyLimit } from "../request-body-limits.js";
import { SENTRY_WEBHOOK_FORWARDED_HEADER, type SentryWebhookForwarder } from "./application.js";
import { type SentryIssueEvent, hasValidSentrySignature, parseSentryIssueEvent } from "./domain.js";

export const SENTRY_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;

export type SentryPublicDependencies = {
  clientSecret: string | undefined;
  receiveIssueEvent: (event: SentryIssueEvent) => Promise<void>;
  revokeInstallation?: (installationId: string) => Promise<void>;
  forwardWebhook?: SentryWebhookForwarder;
};

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountSentryPublic(app: Hono<any>, deps: SentryPublicDependencies): void {
  app.use("/sentry/webhook", requestBodyLimit(SENTRY_WEBHOOK_BODY_BYTES));
  app.post("/sentry/webhook", async (c) => {
    if (!deps.clientSecret) return c.json({ error: "sentry not configured" }, 503);
    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    const decodedBody = new TextDecoder().decode(rawBody);
    const signature = c.req.header("sentry-hook-signature") ?? "";
    if (!hasValidSentrySignature({ rawBody, signature, clientSecret: deps.clientSecret })) {
      return c.json({ error: "invalid signature" }, 401);
    }
    const localDelivery = receiveSentryWebhookLocally({
      rawBody: decodedBody,
      resource: c.req.header("sentry-hook-resource"),
      deps,
    });
    const forwardedDelivery =
      c.req.header(SENTRY_WEBHOOK_FORWARDED_HEADER) !== "1" && deps.forwardWebhook
        ? deps.forwardWebhook({ rawBody, headers: sentryWebhookHeaders(c.req.raw.headers) })
        : Promise.resolve();

    const [localResult, forwardedResult] = await Promise.allSettled([
      localDelivery,
      forwardedDelivery,
    ]);
    if (localResult.status === "rejected" || forwardedResult.status === "rejected") {
      const failures = [localResult, forwardedResult].flatMap((delivery) =>
        delivery.status === "rejected" ? [delivery.reason] : [],
      );
      throw new AggregateError(failures, "Sentry webhook delivery failed");
    }
    return c.json({ accepted: localResult.value }, 202);
  });
}

async function receiveSentryWebhookLocally(input: {
  rawBody: string;
  resource: string | undefined;
  deps: SentryPublicDependencies;
}): Promise<boolean> {
  if (input.resource === "installation") {
    const installationId = parseInstallationDeleted(input.rawBody);
    if (installationId && input.deps.revokeInstallation) {
      await input.deps.revokeInstallation(installationId);
    }
    return !!installationId;
  }
  if (input.resource !== "issue") return false;

  const event = parseSentryIssueEvent(input.rawBody);
  if (!event) return false;
  await input.deps.receiveIssueEvent(event);
  return true;
}

function sentryWebhookHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()].filter(
      ([name]) =>
        name === "content-type" || name === "request-id" || name.startsWith("sentry-hook-"),
    ),
  );
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
