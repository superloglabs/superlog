import assert from "node:assert/strict";
import test from "node:test";
import { configuredWebOrigins } from "./web-origins.js";

test("configured web origins include the canonical origin and valid aliases", () => {
  assert.deepEqual(
    configuredWebOrigins({
      WEB_ORIGIN: "https://telemetry.superlog.sh",
      WEB_ORIGIN_ALIASES: "https://superlog.sh, https://telemetry.superlog.sh",
    }),
    [
      "https://telemetry.superlog.sh",
      "https://superlog.sh",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
  );
});

test("configured web origins ignore malformed aliases", () => {
  assert.deepEqual(
    configuredWebOrigins({
      WEB_ORIGIN: "https://telemetry.superlog.sh",
      WEB_ORIGIN_ALIASES: "https://superlog.sh, javascript:alert(1), /relative",
    }),
    [
      "https://telemetry.superlog.sh",
      "https://superlog.sh",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
  );
});
