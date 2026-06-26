// Pull a human-readable message out of an error thrown by `useFetcher`, which
// throws `Error("<status>: <body>")` where <body> is JSON like `{"error": "…"}`.
// Used by the org create/delete settings cards so their error handling stays
// consistent.
export function fetchErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(/^\d+:\s*(.*)$/s);
  const payload = match?.[1] ?? raw;
  try {
    const parsed = JSON.parse(payload) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {}
  return payload || fallback;
}
