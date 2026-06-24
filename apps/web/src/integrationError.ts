// Turns a failed "connect integration" request into a message we can actually
// show the user. The connect buttons (GitHub, Slack, …) navigate away on
// success; on failure the mutation rejects and — without this — nothing happens,
// so the button looks dead. `fetcher` throws `Error("<status>: <body>")`, which
// we decode here into something human-readable.

export function describeIntegrationConnectError(err: unknown, integration: string): string {
  const raw = (err instanceof Error ? err.message : String(err)).trim();
  const match = /^(\d{3}):\s*([\s\S]*)$/.exec(raw);
  const status = match ? Number(match[1]) : null;

  // 503 = the server has no credentials for this integration. This is the
  // common self-hosted / local-dev case: the API returns 503 from
  // /api/<integration>/install-url when the app/OAuth env vars are unset.
  if (status === 503) {
    return `${integration} isn't configured on this server yet. The server needs ${integration} credentials set before you can connect.`;
  }
  if (status === 401 || status === 403) {
    return `Your session can't start the ${integration} connection. Try signing in again.`;
  }

  const detail = extractDetail(match?.[2] ?? raw);
  return detail
    ? `Couldn't start the ${integration} connection: ${detail}`
    : `Couldn't start the ${integration} connection. Please try again.`;
}

// The error body is usually a JSON envelope like `{"error":"…"}`; pull the
// message out of it when we can, otherwise fall back to the raw text.
function extractDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const value = (parsed as { error: unknown }).error;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    /* not JSON — use the raw text */
  }
  return trimmed;
}
