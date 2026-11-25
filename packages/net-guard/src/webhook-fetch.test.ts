import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { ResponseTooLargeError, webhookFetch } from "./index.js";

function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

describe("webhookFetch egress guard", () => {
  const orig = process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS;
  afterEach(() => {
    process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = orig ?? "";
  });

  it("blocks a loopback destination before the request is sent", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = "";
    let hit = false;
    const { server, port } = await listen((_req, res) => {
      hit = true;
      res.end("ok");
    });
    try {
      await assert.rejects(() =>
        webhookFetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" }),
      );
      assert.equal(hit, false, "loopback server must never be reached");
    } finally {
      server.close();
    }
  });

  it("delivers to an allowed destination and returns the status (escape hatch on)", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = "1";
    const { server, port } = await listen((_req, res) => {
      res.statusCode = 202;
      res.end("thanks");
    });
    try {
      const res = await webhookFetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" });
      assert.equal(res.status, 202);
    } finally {
      server.close();
    }
  });

  it("does not follow redirects", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = "1";
    let followed = false;
    const { server, port } = await listen((req, res) => {
      if (req.url === "/start") {
        res.statusCode = 302;
        res.setHeader("location", `http://127.0.0.1:${port}/followed`);
        res.end();
        return;
      }
      followed = true;
      res.end("should not happen");
    });
    try {
      const res = await webhookFetch(`http://127.0.0.1:${port}/start`, {
        method: "POST",
        body: "{}",
      });
      assert.ok(res.status < 200 || res.status >= 300, "redirect must not count as success");
      assert.equal(followed, false, "redirect target must never be fetched");
    } finally {
      server.close();
    }
  });

  it("stops reading a compressed reply that decodes past the size limit", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = "1";
    // 64 KiB on the wire, 64 MiB once decompressed.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 });
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(bomb);
    });
    try {
      const res = await webhookFetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        body: "{}",
        maxResponseBytes: 1024 * 1024,
      });
      await assert.rejects(() => res.text(), ResponseTooLargeError);
    } finally {
      server.close();
    }
  });

  it("stops reading an uncompressed reply past the default size limit", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = "1";
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let written = 0;
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const write = () => {
        while (written < 64) {
          written += 1;
          if (!res.write(chunk)) {
            res.once("drain", write);
            return;
          }
        }
        res.end();
      };
      res.on("error", () => undefined);
      write();
    });
    try {
      const res = await webhookFetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" });
      await assert.rejects(() => res.arrayBuffer(), ResponseTooLargeError);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("returns a reply within the limit unchanged", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = "1";
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(JSON.stringify({ ok: true })));
    });
    try {
      const res = await webhookFetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" });
      assert.deepEqual(await res.json(), { ok: true });
    } finally {
      server.close();
    }
  });
});
