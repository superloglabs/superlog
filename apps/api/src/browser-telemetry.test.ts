import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import {
  BROWSER_TELEMETRY_BODY_BYTES,
  type BrowserTelemetryRelayConfig,
  browserTelemetryRelayConfigFromEnv,
  mountBrowserTelemetryRelay,
} from "./browser-telemetry.js";

type Vars = { userId: string };

type ForwardedRequest = { url: string; init: RequestInit };

function relayApp(config: BrowserTelemetryRelayConfig | null, upstream?: () => Promise<Response>) {
  const forwarded: ForwardedRequest[] = [];
  const app = new Hono<{ Variables: Vars }>();
  // Stand-in for the session middleware: a request carrying this header is a
  // signed-in user.
  app.use("/api/*", async (c, next) => {
    const userId = c.req.header("x-test-user");
    if (userId) c.set("userId", userId);
    await next();
  });
  mountBrowserTelemetryRelay(app, {
    config,
    fetch: async (url, init) => {
      forwarded.push({ url: String(url), init: init ?? {} });
      return upstream ? upstream() : new Response("{}", { status: 200 });
    },
  });
  return { app, forwarded };
}

const CONFIG: BrowserTelemetryRelayConfig = {
  tracesUrl: "http://collector.internal:4000/v1/traces",
  headers: { authorization: "Bearer server-side-key" },
};

const SPANS = JSON.stringify({ resourceSpans: [] });

function post(body: string, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-test-user": "user-1", ...headers },
  };
}

test("forwards a signed-in user's spans with the server-side headers", async () => {
  const { app, forwarded } = relayApp(CONFIG);

  const res = await app.request("/api/browser-telemetry/v1/traces", post(SPANS));

  assert.equal(res.status, 200);
  assert.equal(forwarded.length, 1);
  const [request] = forwarded;
  assert.equal(request?.url, CONFIG.tracesUrl);
  const headers = new Headers(request?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer server-side-key");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(Buffer.from(request?.init.body as ArrayBuffer).toString("utf8"), SPANS);
});

test("rejects requests without a session and forwards nothing", async () => {
  const { app, forwarded } = relayApp(CONFIG);

  const res = await app.request("/api/browser-telemetry/v1/traces", {
    method: "POST",
    body: SPANS,
    headers: { "content-type": "application/json" },
  });

  assert.equal(res.status, 401);
  assert.equal(forwarded.length, 0);
});

test("never forwards the caller's own credentials", async () => {
  const { app, forwarded } = relayApp(CONFIG);

  await app.request(
    "/api/browser-telemetry/v1/traces",
    post(SPANS, { authorization: "Bearer caller-token", cookie: "session=abc" }),
  );

  const headers = new Headers(forwarded[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer server-side-key");
  assert.equal(headers.get("cookie"), null);
});

test("forwards OTLP protobuf bodies with their content type", async () => {
  const { app, forwarded } = relayApp(CONFIG);

  const res = await app.request(
    "/api/browser-telemetry/v1/traces",
    post("\u0000\u0001", { "content-type": "application/x-protobuf" }),
  );

  assert.equal(res.status, 200);
  assert.equal(
    new Headers(forwarded[0]?.init.headers).get("content-type"),
    "application/x-protobuf",
  );
});

test("rejects content types other than OTLP JSON or protobuf", async () => {
  const { app, forwarded } = relayApp(CONFIG);

  const res = await app.request(
    "/api/browser-telemetry/v1/traces",
    post("hello", { "content-type": "text/plain" }),
  );

  assert.equal(res.status, 415);
  assert.equal(forwarded.length, 0);
});

test("rejects bodies over the relay limit", async () => {
  const { app, forwarded } = relayApp(CONFIG);

  const res = await app.request(
    "/api/browser-telemetry/v1/traces",
    post("x".repeat(BROWSER_TELEMETRY_BODY_BYTES + 1)),
  );

  assert.equal(res.status, 413);
  assert.equal(forwarded.length, 0);
});

test("drops spans quietly when no relay target is configured", async () => {
  const { app, forwarded } = relayApp(null);

  const res = await app.request("/api/browser-telemetry/v1/traces", post(SPANS));

  assert.equal(res.status, 204);
  assert.equal(forwarded.length, 0);
});

test("passes through the upstream status", async () => {
  const { app } = relayApp(CONFIG, async () => new Response("slow down", { status: 429 }));

  const res = await app.request("/api/browser-telemetry/v1/traces", post(SPANS));

  assert.equal(res.status, 429);
});

test("answers 502 when the upstream cannot be reached", async () => {
  const { app } = relayApp(CONFIG, async () => {
    throw new Error("connection refused");
  });

  const res = await app.request("/api/browser-telemetry/v1/traces", post(SPANS));

  assert.equal(res.status, 502);
});

test("reads a dedicated relay endpoint and headers from the environment", () => {
  const config = browserTelemetryRelayConfigFromEnv({
    BROWSER_TELEMETRY_OTLP_ENDPOINT: "https://intake.example.com/",
    BROWSER_TELEMETRY_OTLP_HEADERS: "Authorization=Bearer%20browser-key, x-extra = 1",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4000",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer server-key",
  });

  assert.deepEqual(config, {
    tracesUrl: "https://intake.example.com/v1/traces",
    headers: { Authorization: "Bearer browser-key", "x-extra": "1" },
  });
});

test("falls back to the API's own OTLP exporter settings", () => {
  const config = browserTelemetryRelayConfigFromEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4000",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer server-key",
  });

  assert.deepEqual(config, {
    tracesUrl: "http://collector.internal:4000/v1/traces",
    headers: { Authorization: "Bearer server-key" },
  });
});

test("does not send the API's exporter headers to a different relay endpoint", () => {
  const config = browserTelemetryRelayConfigFromEnv({
    BROWSER_TELEMETRY_OTLP_ENDPOINT: "https://other.example.com",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4000",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer server-key",
  });

  assert.deepEqual(config, { tracesUrl: "https://other.example.com/v1/traces", headers: {} });
});

test("does not fall back to the API exporter when the OTel SDK is disabled", () => {
  const exporterEnv = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4000",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer server-key",
    OTEL_SDK_DISABLED: "true",
  };
  assert.equal(browserTelemetryRelayConfigFromEnv(exporterEnv), null);
  assert.deepEqual(
    browserTelemetryRelayConfigFromEnv({
      ...exporterEnv,
      BROWSER_TELEMETRY_OTLP_ENDPOINT: "https://intake.example.com",
    }),
    { tracesUrl: "https://intake.example.com/v1/traces", headers: {} },
  );
});

test("is disabled without an endpoint or for a gRPC exporter", () => {
  assert.equal(browserTelemetryRelayConfigFromEnv({}), null);
  assert.equal(
    browserTelemetryRelayConfigFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4317",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
    }),
    null,
  );
});
