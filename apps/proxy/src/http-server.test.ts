import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, createServer, request } from "node:http";
import test from "node:test";
import { configureHttpServerTimeouts } from "./http-server.js";

function getConnectionId(port: number, agent: Agent): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ port, path: "/", agent }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });
}

test("an upstream load balancer can own idle connection closure", async () => {
  const connectionIds = new WeakMap<object, number>();
  let nextConnectionId = 0;
  const server = createServer((req, res) => {
    let connectionId = connectionIds.get(req.socket);
    if (connectionId === undefined) {
      connectionId = ++nextConnectionId;
      connectionIds.set(req.socket, connectionId);
    }
    res.end(String(connectionId));
  });
  server.keepAliveTimeout = 20;
  configureHttpServerTimeouts(server, { HTTP_KEEP_ALIVE_TIMEOUT_MS: "0" });

  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");

    const firstConnection = await getConnectionId(address.port, agent);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const secondConnection = await getConnectionId(address.port, agent);

    assert.equal(secondConnection, firstConnection);
  } finally {
    agent.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("an invalid keep-alive timeout cannot silently disable idle closure", () => {
  const server = createServer();

  assert.throws(
    () => configureHttpServerTimeouts(server, { HTTP_KEEP_ALIVE_TIMEOUT_MS: "" }),
    /HTTP_KEEP_ALIVE_TIMEOUT_MS must be a nonnegative integer/,
  );
});

test("an oversized keep-alive timeout cannot collapse to an immediate Node timer", () => {
  const server = createServer();

  assert.throws(
    () =>
      configureHttpServerTimeouts(server, {
        HTTP_KEEP_ALIVE_TIMEOUT_MS: "2147482648",
      }),
    /HTTP_KEEP_ALIVE_TIMEOUT_MS must not exceed 2147482647/,
  );
});
