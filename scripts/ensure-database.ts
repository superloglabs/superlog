#!/usr/bin/env tsx
// Idempotent CREATE DATABASE through the same host:port the rest of the
// stack will hit. Avoids the `docker exec` / `localhost:port` split-brain
// that bit us when orphan containers from removed worktrees still held the
// shared host port.

import postgres from "postgres";

const targetUrl = process.argv[2];
if (!targetUrl) {
  console.error("usage: ensure-database.ts <postgres-url>");
  process.exit(1);
}

const u = new URL(targetUrl);
const dbName = decodeURIComponent(u.pathname.replace(/^\//, ""));
if (!dbName) {
  console.error("no database name in url:", targetUrl);
  process.exit(1);
}

const adminUrl = new URL(targetUrl);
adminUrl.pathname = "/postgres";

const sql = postgres(adminUrl.toString(), { max: 1, idle_timeout: 5 });

try {
  const rows =
    await sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
  if (rows.length === 0) {
    await sql.unsafe(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    console.log(`created ${dbName}`);
  } else {
    console.log(`${dbName} already exists`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
