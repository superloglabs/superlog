// Drive proxyToAnthropic directly against real Anthropic with the CF-injected
// headers that our orange-cloud front would add. Before the header allowlist
// fix, this reproduces the CF Error 1000; after, it should pass through to a
// real Anthropic status (200 on valid key, 401 on bogus).
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @superlog/api exec tsx scripts/test-proxy.ts

import "dotenv/config";
import { proxyToAnthropic } from "../src/gateway.js";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const body = JSON.stringify({
  model: "claude-sonnet-4-6",
  max_tokens: 16,
  messages: [{ role: "user", content: "say hi in 3 words" }],
});

// Simulate the request exactly as it arrives at our gateway when api.superlog.sh
// is orange-clouded on Cloudflare: CF injects its own tracing + client-ip
// headers, which are what triggered Anthropic's CF edge to return Error 1000
// before we started stripping them.
const req = new Request("https://api.superlog.sh/v1/messages", {
  method: "POST",
  headers: {
    authorization: "Bearer superlog_cli_fake",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "user-agent": "anthropic-sdk-node",
    "cf-connecting-ip": "203.0.113.42",
    "cf-ray": "deadbeefcafe-SJC",
    "cf-visitor": '{"scheme":"https"}',
    "cf-ipcountry": "US",
    "x-forwarded-for": "203.0.113.42",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "api.superlog.sh",
  },
  body,
});

console.log("--- inbound headers (what the gateway sees) ---");
for (const [k, v] of req.headers) console.log(`  ${k}: ${v}`);

const resp = await proxyToAnthropic(req, "/v1/messages", key);
const text = await resp.text();
console.log(`\n--- upstream response ---`);
console.log("status:", resp.status);
console.log("server:", resp.headers.get("server"));
console.log("body:", text.slice(0, 400));

if (resp.status === 403 && text.includes("DNS points to prohibited IP")) {
  console.error("\nFAIL: still hitting CF Error 1000 — header strip did not work");
  process.exit(2);
}
console.log("\nOK: upstream reached Anthropic cleanly (no CF 1000)");
