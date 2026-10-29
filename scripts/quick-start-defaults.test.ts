import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const proxyEnv = readFileSync(new URL("../apps/proxy/.env.example", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const contributing = readFileSync(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");

test("quick-start guides use the proxy's default OTLP port", () => {
  const proxyPort = proxyEnv.match(/^PORT=(\d+)$/m)?.[1];

  assert.ok(proxyPort, "expected apps/proxy/.env.example to define PORT");
  assert.match(readme, new RegExp(`OTLP intake: \`http://localhost:${proxyPort}\``));
  assert.match(contributing, new RegExp(`OTLP proxy\\s+\\| http://localhost:${proxyPort}`));
});
