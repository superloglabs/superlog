import { PgBoss } from "pg-boss";
import { logger } from "./logger.js";
import {
  publishUserCreated,
  type UserCreatedQueue,
} from "./user-created-events.js";

type User = {
  id: string;
  email: string;
  name?: string | null;
  createdAt: Date | string;
};

type PublisherDeps = {
  enabled: () => boolean;
  startQueue: () => Promise<UserCreatedQueue>;
  onError: (error: unknown, userId: string) => void;
};

export function createUserCreatedPublisher(deps: PublisherDeps): (user: User) => Promise<boolean> {
  let queuePromise: Promise<UserCreatedQueue> | null = null;

  const queue = (): Promise<UserCreatedQueue> => {
    if (queuePromise) return queuePromise;
    queuePromise = deps.startQueue().catch((error) => {
      queuePromise = null;
      throw error;
    });
    return queuePromise;
  };

  return async (user: User): Promise<boolean> => {
    if (!deps.enabled()) return false;
    try {
      await publishUserCreated(await queue(), user);
      return true;
    } catch (error) {
      deps.onError(error, user.id);
      return false;
    }
  };
}

async function startQueue(): Promise<PgBoss> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
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
  return boss.start();
}

/** Best-effort generic user lifecycle event. Reconciliation consumers recover
 * a missed publish, so authentication must never fail when the queue is down. */
export const enqueueUserCreated = createUserCreatedPublisher({
  enabled: () => process.env.USER_CREATED_EVENTS_ENABLED === "true",
  startQueue,
  onError: (error, userId) => {
    logger.error(
      { scope: "user-created-events", userId, err: error instanceof Error ? error.message : String(error) },
      "failed to publish user-created event",
    );
  },
});
