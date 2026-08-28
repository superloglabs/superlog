import { strict as assert } from "node:assert";
import { test } from "node:test";
import { clickHouseClientConfig } from "./clickhouse-client.js";

test("the API discards stale ClickHouse sockets before reusing them", () => {
  const config = clickHouseClientConfig({});

  assert.deepEqual(config.keep_alive, {
    enabled: true,
    idle_socket_ttl: 2_500,
    eagerly_destroy_stale_sockets: true,
  });
});
