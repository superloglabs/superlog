import { type DB, schema } from "@superlog/db";
import { and, eq, sql } from "drizzle-orm";
import {
  type OutcomeActionReceiptLock,
  outcomeActionReceiptKey,
} from "./outcome-action-receipts.js";

export function createDatabaseOutcomeActionReceiptLock(database: DB): OutcomeActionReceiptLock {
  return {
    async exclusive(args, task) {
      return database.transaction(async (tx) => {
        // The lock lives for the whole action, including provider mutation.
        // A concurrent replay waits, then reads the canonical receipt written
        // by the winner instead of executing the same tool use twice.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('agent_outcome_action'), hashtext(${`${args.agentRunId}:${args.toolUseId}`}))`,
        );
        return task({
          async load() {
            const event = await tx.query.incidentEvents.findFirst({
              where: and(
                eq(schema.incidentEvents.agentRunId, args.agentRunId),
                eq(schema.incidentEvents.dedupeKey, outcomeActionReceiptKey(args.toolUseId)),
              ),
              columns: { kind: true, detail: true },
            });
            if (!event) return null;
            if (
              event.kind !== "internal_agent_outcome_action_receipt" ||
              !event.detail ||
              typeof event.detail !== "object" ||
              Array.isArray(event.detail)
            ) {
              return { malformed: true };
            }
            return event.detail;
          },
          async save(detail) {
            await tx.insert(schema.incidentEvents).values({
              incidentId: args.incidentId,
              agentRunId: args.agentRunId,
              kind: "internal_agent_outcome_action_receipt",
              summary: null,
              detail,
              dedupeKey: outcomeActionReceiptKey(args.toolUseId),
              processedAt: new Date(),
            });
          },
        });
      });
    },
  };
}
