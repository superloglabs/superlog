// Span exporter that posts browser spans to the API's telemetry relay.
//
// The relay authenticates the request with the user's session cookie and adds
// the intake credentials server-side, so the web bundle never carries an
// ingest key. The stock OTLP exporter cannot send cookies cross-origin, which
// is why this is a small exporter of its own.

import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-web";

// Browsers cap the total size of in-flight keepalive requests at 64 KiB.
const KEEPALIVE_BODY_BYTES = 60 * 1024;

type RelaySpanExporterOptions = {
  url: string;
  fetch?: typeof fetch;
  serialize?: (spans: ReadableSpan[]) => Uint8Array | undefined;
};

function unwrappedFetch(fetchImpl: typeof fetch): typeof fetch {
  // The fetch instrumentation wraps window.fetch; calling the original keeps
  // every export from producing a span that is itself exported.
  const original = (fetchImpl as { __original?: unknown }).__original;
  return typeof original === "function" ? (original as typeof fetch) : fetchImpl;
}

export function createRelaySpanExporter(options: RelaySpanExporterOptions): SpanExporter {
  const serialize =
    options.serialize ?? ((spans: ReadableSpan[]) => JsonTraceSerializer.serializeRequest(spans));
  let stopped = false;
  const pending = new Set<Promise<void>>();

  return {
    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
      if (stopped) {
        resultCallback({ code: ExportResultCode.FAILED, error: new Error("exporter shut down") });
        return;
      }
      const body = serialize(spans);
      if (!body) {
        resultCallback({ code: ExportResultCode.FAILED, error: new Error("serialization failed") });
        return;
      }
      const send = unwrappedFetch(options.fetch ?? globalThis.fetch);
      const request = send(options.url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: body as BodyInit,
        keepalive: body.byteLength <= KEEPALIVE_BODY_BYTES,
      })
        .then((response) => {
          resultCallback(
            response.ok
              ? { code: ExportResultCode.SUCCESS }
              : {
                  code: ExportResultCode.FAILED,
                  error: new Error(`telemetry relay returned ${response.status}`),
                },
          );
        })
        .catch((error: unknown) => {
          resultCallback({
            code: ExportResultCode.FAILED,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        })
        .finally(() => {
          pending.delete(request);
        });
      pending.add(request);
    },
    async forceFlush(): Promise<void> {
      await Promise.all(pending);
    },
    async shutdown(): Promise<void> {
      stopped = true;
      await Promise.all(pending);
    },
  };
}
