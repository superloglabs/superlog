import { PgBoss } from "pg-boss";
import { logger } from "./logger.js";
import { publishUserCreated } from "./user-created-events.js";

let queuePromise: Promise<PgBoss> | null = null;

function enabled(): boolean {
  return process.env.USER_CREATED_EVENTS_ENABLED === "true";
}

function queue(): Promise<PgBoss> {
  if (queuePromise) return queuePromise;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return Promise.reject(new Error("DATABASE_URL is not set"));
  const boss = new PgBoss({
    connectionString,
    schema: process.env.PGBOSS_SCHEMA || "pgboss",
    migrate: process.env.PGBOSS_MIGRATE !== "false",
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on("error", (error: Error) =>
    logger.error({ scope: "user-created-events", err: error.message }, "signup event queue error"),
  );
  queuePromise = boss.start();
  return queuePromise;
}

/** Best-effort generic user lifecycle event. Reconciliation consumers recover
 * a missed publish, so authentication must never fail when the queue is down. */
export async function enqueueUserCreated(user: {
  id: string;
  email: string;
  name?: string | null;
  createdAt: Date | string;
}): Promise<boolean> {
  if (!enabled()) return false;
  try {
    await publishUserCreated(await queue(), user);
    return true;
  } catch (error) {
    logger.error(
      { scope: "user-created-events", userId: user.id, err: error instanceof Error ? error.message : String(error) },
      "failed to publish user-created event",
    );
    return false;
  }
}
