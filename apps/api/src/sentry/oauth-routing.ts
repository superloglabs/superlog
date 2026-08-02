const RESPONDER_STATE_PREFIX = "responder-v1.";

export type SentryOAuthCallbackRoute =
  | { kind: "superlog" }
  | { kind: "redirect"; location: string }
  | { kind: "invalid" };

export function routeSentryOAuthCallback(input: {
  state: string | undefined;
  requestUrl: string;
  allowedDestination: string | undefined;
}): SentryOAuthCallbackRoute {
  if (!input.state?.startsWith(RESPONDER_STATE_PREFIX)) return { kind: "superlog" };

  const segments = input.state.split(".");
  if (segments.length !== 3 || segments[0] !== "responder-v1" || !segments[2]) {
    return { kind: "invalid" };
  }
  const encodedDestination = segments[1];
  if (!encodedDestination || !/^[A-Za-z0-9_-]+$/.test(encodedDestination)) {
    return { kind: "invalid" };
  }

  let destinationText: string;
  try {
    const bytes = Buffer.from(encodedDestination, "base64url");
    if (bytes.toString("base64url") !== encodedDestination) return { kind: "invalid" };
    destinationText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "invalid" };
  }
  if (!input.allowedDestination || destinationText !== input.allowedDestination) {
    return { kind: "invalid" };
  }

  let destination: URL;
  let allowed: URL;
  try {
    destination = new URL(destinationText);
    allowed = new URL(input.allowedDestination);
  } catch {
    return { kind: "invalid" };
  }
  if (
    destination.protocol !== "https:" ||
    destination.username !== "" ||
    destination.password !== "" ||
    destination.search !== "" ||
    destination.hash !== "" ||
    destination.origin !== allowed.origin ||
    destination.pathname !== allowed.pathname
  ) {
    return { kind: "invalid" };
  }

  const queryIndex = input.requestUrl.indexOf("?");
  const rawQuery = queryIndex === -1 ? "" : input.requestUrl.slice(queryIndex);
  return { kind: "redirect", location: `${destinationText}${rawQuery}` };
}
