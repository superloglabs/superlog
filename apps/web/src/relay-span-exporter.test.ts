import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-web";
import { createRelaySpanExporter } from "./relay-span-exporter.ts";

type Call = { url: string; init: RequestInit };

function recordingFetch(response: () => Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

function exportOnce(exporter: ReturnType<typeof createRelaySpanExporter>) {
  return new Promise<ExportResult>((resolve) => exporter.export([] as ReadableSpan[], resolve));
}

const BODY = new TextEncoder().encode('{"resourceSpans":[]}');

test("posts spans to the relay with the session cookie and no credentials of its own", async () => {
  const { calls, fetchImpl } = recordingFetch(async () => new Response(null, { status: 200 }));
  const exporter = createRelaySpanExporter({
    url: "https://api.example.com/api/browser-telemetry/v1/traces",
    fetch: fetchImpl,
    serialize: () => BODY,
  });

  const result = await exportOnce(exporter);

  assert.equal(result.code, ExportResultCode.SUCCESS);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call?.url, "https://api.example.com/api/browser-telemetry/v1/traces");
  assert.equal(call?.init.method, "POST");
  assert.equal(call?.init.credentials, "include");
  const headers = new Headers(call?.init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), null);
  assert.equal(call?.init.body, BODY);
});

test("reports a failed export for a non-2xx response", async () => {
  const { fetchImpl } = recordingFetch(async () => new Response(null, { status: 401 }));
  const exporter = createRelaySpanExporter({
    url: "https://api.example.com/t",
    fetch: fetchImpl,
    serialize: () => BODY,
  });

  const result = await exportOnce(exporter);

  assert.equal(result.code, ExportResultCode.FAILED);
});

test("reports a failed export when the request throws", async () => {
  const { fetchImpl } = recordingFetch(async () => {
    throw new TypeError("network down");
  });
  const exporter = createRelaySpanExporter({
    url: "https://api.example.com/t",
    fetch: fetchImpl,
    serialize: () => BODY,
  });

  const result = await exportOnce(exporter);

  assert.equal(result.code, ExportResultCode.FAILED);
});

test("bypasses an instrumented fetch so exports do not trace themselves", async () => {
  const original = recordingFetch(async () => new Response(null, { status: 200 }));
  const wrapped = recordingFetch(async () => new Response(null, { status: 200 }));
  Object.assign(wrapped.fetchImpl, { __original: original.fetchImpl });
  const exporter = createRelaySpanExporter({
    url: "https://api.example.com/t",
    fetch: wrapped.fetchImpl,
    serialize: () => BODY,
  });

  await exportOnce(exporter);

  assert.equal(original.calls.length, 1);
  assert.equal(wrapped.calls.length, 0);
});

test("only uses keepalive for bodies within the browser's keepalive budget", async () => {
  const { calls, fetchImpl } = recordingFetch(async () => new Response(null, { status: 200 }));
  const small = createRelaySpanExporter({
    url: "https://api.example.com/t",
    fetch: fetchImpl,
    serialize: () => BODY,
  });
  const large = createRelaySpanExporter({
    url: "https://api.example.com/t",
    fetch: fetchImpl,
    serialize: () => new Uint8Array(70 * 1024),
  });

  await exportOnce(small);
  await exportOnce(large);

  assert.equal(calls[0]?.init.keepalive, true);
  assert.equal(calls[1]?.init.keepalive, false);
});

test("stops exporting after shutdown", async () => {
  const { calls, fetchImpl } = recordingFetch(async () => new Response(null, { status: 200 }));
  const exporter = createRelaySpanExporter({
    url: "https://api.example.com/t",
    fetch: fetchImpl,
    serialize: () => BODY,
  });

  await exporter.shutdown();
  const result = await exportOnce(exporter);

  assert.equal(result.code, ExportResultCode.FAILED);
  assert.equal(calls.length, 0);
});
