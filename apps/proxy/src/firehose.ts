// Helpers for the AWS Data Firehose HTTP-endpoint ingest path.
//
// CloudWatch Metric Streams and account-level Logs subscription filters deliver
// to our intake via Kinesis Firehose's "HTTP endpoint destination". Firehose
// sends a fixed set of headers (below) and a JSON envelope, and expects a
// strict response shape. The proxy authenticates the request (reusing the same
// ingest-key → project resolution as the OTLP path), stamps the tenant header,
// and forwards transparently to the collector's `awsfirehose` receiver, which
// decodes the records and produces the Firehose ack itself.
//
// Spec: https://docs.aws.amazon.com/firehose/latest/dev/httpdeliveryrequestresponse.html

/** `X-Amz-Firehose-Access-Key` — carries the project's ingest key verbatim. */
export const FIREHOSE_ACCESS_KEY_HEADER = "x-amz-firehose-access-key";
/**
 * `X-Amz-Firehose-Request-Id` — an opaque GUID Firehose keeps stable across
 * retries. The collector's `awsfirehose` receiver REQUIRES it (returns
 * `400 "missing request id in header"` without it), so the proxy must forward
 * it rather than strip it.
 */
export const FIREHOSE_REQUEST_ID_HEADER = "x-amz-firehose-request-id";
/**
 * `X-Amz-Firehose-Source-Arn` — the delivery-stream ARN, e.g.
 * `arn:aws:firehose:us-west-2:123456789012:deliverystream/name`. Its account-id
 * segment lets us cross-check that a stream is aimed at the project that owns
 * the matching cloud connection.
 */
export const FIREHOSE_SOURCE_ARN_HEADER = "x-amz-firehose-source-arn";

/** ARN shape: arn:aws:firehose:<region>:<account-id>:deliverystream/<name>. */
const FIREHOSE_ARN_PATTERN = /^arn:aws[a-z-]*:firehose:[a-z0-9-]+:(\d{12}):/;

/**
 * Parse the 12-digit AWS account id out of a Firehose delivery-stream ARN.
 * Returns null when the ARN is missing, malformed, or not a Firehose ARN — we
 * never want to attribute an account id we can't trust.
 */
export function parseAccountIdFromFirehoseArn(arn: string | null | undefined): string | null {
  if (!arn) return null;
  const match = FIREHOSE_ARN_PATTERN.exec(arn);
  return match?.[1] ?? null;
}

/**
 * Build the headers for the upstream POST to the collector's `awsfirehose`
 * receiver: stamp the resolved tenant (`x-superlog-project-id`, the same header
 * the `attributes/from_metadata` → `groupbyattrs` chain promotes for OTLP),
 * forward the required Firehose request id, and pass through content framing.
 *
 * Returns null when the request id is absent — there is no point forwarding a
 * request the receiver will reject; the caller fails fast with a 400 instead.
 */
export function buildFirehoseUpstreamHeaders(input: {
  projectId: string;
  requestId: string | null | undefined;
  contentType: string;
  contentEncoding?: string | null;
}): Record<string, string> | null {
  if (!input.requestId) return null;
  const headers: Record<string, string> = {
    "content-type": input.contentType,
    "x-superlog-project-id": input.projectId,
    [FIREHOSE_REQUEST_ID_HEADER]: input.requestId,
  };
  if (input.contentEncoding) headers["content-encoding"] = input.contentEncoding;
  return headers;
}

/** A Firehose endpoint response body. `errorMessage` is present only on failures. */
export interface FirehoseResponseBody {
  requestId: string;
  timestamp: number;
  errorMessage?: string;
}

/**
 * Build a Firehose-spec response body. The collector produces the success ack
 * for forwarded requests; the proxy uses this only for the requests it rejects
 * before the collector (missing/invalid key, account mismatch) so the failure
 * still surfaces with the request id in the customer's Firehose error logs.
 */
export function firehoseResponseBody(
  requestId: string,
  errorMessage?: string,
): FirehoseResponseBody {
  const body: FirehoseResponseBody = { requestId, timestamp: Date.now() };
  if (errorMessage !== undefined) body.errorMessage = errorMessage;
  return body;
}
