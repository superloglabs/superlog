/**
 * Fast, pre-auth rejection of declared-empty OTLP ingest requests.
 *
 * An OTLP HTTP export with a zero-length body carries no records, so it can
 * never succeed — it's a permanent 400. The auth middleware, by contrast, hashes
 * the API key, reads the `api_keys` row, and writes `last_used_at` on every
 * request: a DB read *and* write per call. A misbehaving client looping empty
 * exports would otherwise pay that full per-request cost, and enough of them
 * saturate the shared proxy fleet's CPU until health checks fail and the load
 * balancer serves 5xx to every tenant.
 *
 * Recognising the empty body from the `Content-Length` header lets us reject it
 * before any of that work. Only the `Content-Length: 0` case is fast-rejected
 * here — a chunked request with no declared length that turns out to be empty
 * still falls through to the body-capture `EmptyBodyError` → 400 path; it just
 * isn't cheap. That gap is acceptable: real OTLP exporters set `Content-Length`.
 */

/** The 400 body sent for an empty ingest request, whether caught here or later. */
export const EMPTY_BODY_ERROR_MESSAGE = "empty OTLP request body; no records to ingest";

/**
 * True iff the `Content-Length` header is present and provably zero. Absent,
 * empty, or non-numeric values return false so the request takes the normal
 * path — this only fast-rejects a body we can cheaply prove carries no records.
 */
export function isDeclaredEmptyBody(contentLength: string | null | undefined): boolean {
  if (contentLength === null || contentLength === undefined) return false;
  // A run of zero digits (with optional surrounding whitespace) is the only
  // shape that means "empty". parseInt would coerce "0.5" / "0x0" to 0 and
  // wrongly reject them, so match the digits explicitly instead.
  return /^\s*0+\s*$/.test(contentLength);
}
