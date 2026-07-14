import crypto from "node:crypto";
import type { OutcomeActionExecution } from "../agent-runner-backend.js";

export type OutcomeActionReceiptArgs = {
  incidentId: string;
  agentRunId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
};

type OutcomeActionReceiptTransaction = {
  load(): Promise<Record<string, unknown> | null>;
  save(detail: Record<string, unknown>): Promise<void>;
};

export type OutcomeActionReceiptLock = {
  exclusive<T>(
    args: OutcomeActionReceiptArgs,
    task: (receipt: OutcomeActionReceiptTransaction) => Promise<T>,
  ): Promise<T>;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("outcome action input contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error(`outcome action input contains unsupported ${typeof value}`);
}

export function outcomeActionInputHash(input: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function receiptMismatch(): OutcomeActionExecution {
  return {
    handled: true,
    ok: false,
    payload: {
      ok: false,
      errors: ["Outcome action receipt does not match this tool call; refusing to execute it."],
    },
  };
}

function executionFromReceipt(
  detail: Record<string, unknown>,
  args: { toolName: string; inputHash: string },
): OutcomeActionExecution {
  if (
    detail.version !== 1 ||
    detail.toolName !== args.toolName ||
    detail.inputHash !== args.inputHash ||
    typeof detail.ok !== "boolean" ||
    !detail.payload ||
    typeof detail.payload !== "object" ||
    Array.isArray(detail.payload)
  ) {
    return receiptMismatch();
  }
  return {
    handled: true,
    ok: detail.ok,
    payload: detail.payload as Record<string, unknown>,
  };
}

export async function runOutcomeActionWithReceipt(
  lock: OutcomeActionReceiptLock,
  args: OutcomeActionReceiptArgs,
  execute: () => Promise<OutcomeActionExecution>,
): Promise<OutcomeActionExecution> {
  try {
    const inputHash = outcomeActionInputHash(args.input);
    return await lock.exclusive(args, async (receipt) => {
      const stored = await receipt.load();
      if (stored) return executionFromReceipt(stored, { toolName: args.toolName, inputHash });

      const execution = await execute();
      if (!execution.handled || execution.deferAck) return execution;
      await receipt.save({
        version: 1,
        toolName: args.toolName,
        inputHash,
        ok: execution.ok,
        payload: execution.payload,
      });
      return execution;
    });
  } catch {
    return { handled: true, deferAck: true };
  }
}

export function outcomeActionReceiptKey(toolUseId: string): string {
  return `agent_outcome_action:${toolUseId}`;
}
