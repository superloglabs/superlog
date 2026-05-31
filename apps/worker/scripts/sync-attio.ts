import "../src/env.js";
import { createClient } from "@clickhouse/client";
import { closeDb, db } from "@superlog/db";
import { createAttioRestClient } from "../src/attio/client.js";
import { createAttioRepository } from "../src/attio/repository.js";
import { syncAttio } from "../src/attio/sync.js";

const apiKey = process.env.ATTIO_API_KEY?.trim();
if (!apiKey) {
  throw new Error("ATTIO_API_KEY is required");
}

const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: process.env.CLICKHOUSE_DB ?? "superlog",
});

try {
  const result = await syncAttio({
    repository: createAttioRepository({ db, clickhouse }),
    client: createAttioRestClient({
      apiKey,
      apiBase: process.env.ATTIO_API_BASE,
    }),
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length > 0) process.exitCode = 1;
} finally {
  await clickhouse.close();
  await closeDb();
}
