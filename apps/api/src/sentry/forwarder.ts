import { SENTRY_WEBHOOK_FORWARDED_HEADER, type SentryWebhookForwarder } from "./application.js";

export function createSentryWebhookForwarder(input: {
  destinationUrl: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): SentryWebhookForwarder | undefined {
  const destinationUrl = input.destinationUrl?.trim();
  if (!destinationUrl) return undefined;
  let destination: URL;
  try {
    destination = new URL(destinationUrl);
  } catch {
    throw new Error("Sentry webhook forwarding destination must be an HTTP URL");
  }
  if (destination.protocol !== "http:" && destination.protocol !== "https:") {
    throw new Error("Sentry webhook forwarding destination must be an HTTP URL");
  }
  const fetchImpl = input.fetchImpl ?? fetch;

  return async (delivery) => {
    const response = await fetchImpl(destination, {
      method: "POST",
      headers: {
        ...delivery.headers,
        [SENTRY_WEBHOOK_FORWARDED_HEADER]: "1",
      },
      body: delivery.rawBody,
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
    });
    if (!response.ok) {
      throw new Error(`Sentry webhook forwarding failed (${response.status})`);
    }
  };
}
