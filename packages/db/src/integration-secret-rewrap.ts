import {
  type SQL,
  and,
  asc,
  count,
  eq,
  getTableColumns,
  gt,
  isNotNull,
  isNull,
  ne,
  or,
} from "drizzle-orm";
import { type PgColumn, type PgTable, getTableConfig } from "drizzle-orm/pg-core";
import type { DB } from "./client.js";
import {
  ENCRYPTED_INTEGRATION_SECRET_COLUMNS,
  type EncryptedSecretColumn,
  encryptedSecretColumnLabel,
} from "./integration-secret-columns.js";
import {
  type IntegrationSecretKeyring,
  LEGACY_INTEGRATION_SECRET_KEY_VERSION,
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  integrationSecretKeyring,
} from "./integration-secrets.js";

/**
 * Re-encrypts ("rewraps") every `AGENT_SECRETS_KEY` envelope that is not on
 * the keyring's current version. Each row is updated with an optimistic guard
 * on its id, old key version and old ciphertext, so a concurrent writer always
 * wins and the rewrap never overwrites a newer value. Rows are scanned in id
 * order and already-current rows are skipped, so the command is idempotent and
 * can be re-run after an interruption. Plaintext and key material are never
 * logged or returned.
 */

const DEFAULT_BATCH_SIZE = 100;

export type RewrapOptions = {
  dryRun: boolean;
  batchSize?: number;
  keyring?: IntegrationSecretKeyring;
};

export type RewrapColumnReport = {
  table: string;
  column: string;
  /** Rows found on a non-current key version during this run. */
  pending: number;
  /** Pending rows by key version; `legacy_null` is a ciphertext with no recorded version. */
  pendingByVersion: Record<string, number>;
  /** Rows re-encrypted (or, in a dry run, rows that decrypt and would be). */
  rewrapped: number;
  /** Rows changed by another writer between read and update; left as they are. */
  conflicts: number;
  /** Rows that could not be decrypted or updated. */
  failed: number;
  /** Rows still on a non-current version after this run. */
  remaining: number;
};

export type RewrapFailure = {
  column: string;
  id: string;
  keyVersion: number | null;
  reason: string;
};

export type RewrapReport = {
  dryRun: boolean;
  currentVersion: number;
  configuredVersions: readonly number[];
  columns: RewrapColumnReport[];
  totals: Pick<RewrapColumnReport, "pending" | "rewrapped" | "conflicts" | "failed" | "remaining">;
  failures: RewrapFailure[];
};

export type EncryptedSecretRow = {
  id: string;
  ciphertext: Buffer | null;
  nonce: Buffer | string | null;
  keyVersion: number | null;
};

export type RewrapRowOutcome = "rewrapped" | "conflict";

export function parseRewrapArgs(args: string[]): { dryRun: boolean; batchSize: number } {
  let dryRun = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--batch-size=")) {
      batchSize = Number(arg.slice("--batch-size=".length));
      if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
        throw new Error("batch size must be a positive integer");
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { dryRun, batchSize };
}

function propertyKey(table: PgTable, column: PgColumn): string {
  for (const [key, candidate] of Object.entries(getTableColumns(table))) {
    if (candidate === column) return key;
  }
  throw new Error(`column ${column.name} is not on table ${getTableConfig(table).name}`);
}

function staleVersionFilter(entry: EncryptedSecretColumn, currentVersion: number): SQL {
  const filter = and(
    isNotNull(entry.ciphertext),
    or(isNull(entry.keyVersion), ne(entry.keyVersion, currentVersion)),
  );
  if (!filter) throw new Error("unreachable: empty rewrap filter");
  return filter;
}

function decodeNonce(entry: EncryptedSecretColumn, nonce: Buffer | string): Buffer {
  if (entry.nonceEncoding === "base64-text") {
    if (typeof nonce !== "string") throw new Error("expected a base64 text nonce");
    return Buffer.from(nonce, "base64");
  }
  return asBuffer(nonce, "nonce");
}

// postgres-js returns bytea as Buffer; other drivers (PGlite) return Uint8Array.
function asBuffer(value: Buffer | Uint8Array | string, name: string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.length);
  throw new Error(`expected a bytea ${name}`);
}

function encodeNonce(entry: EncryptedSecretColumn, nonce: Buffer): Buffer | string {
  return entry.nonceEncoding === "base64-text" ? nonce.toString("base64") : nonce;
}

function decryptRow(
  entry: EncryptedSecretColumn,
  row: EncryptedSecretRow,
  keyring: IntegrationSecretKeyring,
): string {
  if (row.ciphertext === null) throw new Error("ciphertext is missing");
  if (row.nonce === null) throw new Error("envelope is incomplete: nonce is missing");
  return decryptIntegrationSecret(
    {
      ciphertext: asBuffer(row.ciphertext, "ciphertext"),
      nonce: decodeNonce(entry, row.nonce),
      keyVersion: row.keyVersion ?? LEGACY_INTEGRATION_SECRET_KEY_VERSION,
    },
    keyring,
  );
}

/**
 * Re-encrypts one row with the keyring's current version. The update only
 * applies while the row still holds exactly the envelope that was read;
 * otherwise it reports a conflict and leaves the newer value in place.
 */
export async function rewrapEncryptedSecretRow(
  database: DB,
  entry: EncryptedSecretColumn,
  row: EncryptedSecretRow,
  keyring: IntegrationSecretKeyring = integrationSecretKeyring(),
): Promise<RewrapRowOutcome> {
  const plaintext = decryptRow(entry, row, keyring);
  const next = encryptIntegrationSecret(plaintext, keyring);
  if (row.ciphertext === null || row.nonce === null) throw new Error("envelope is incomplete");

  const updated = await database
    .update(entry.table)
    .set({
      [propertyKey(entry.table, entry.ciphertext)]: next.ciphertext,
      [propertyKey(entry.table, entry.nonce)]: encodeNonce(entry, next.nonce),
      [propertyKey(entry.table, entry.keyVersion)]: next.keyVersion,
    } as never)
    .where(
      and(
        eq(entry.id, row.id),
        row.keyVersion === null ? isNull(entry.keyVersion) : eq(entry.keyVersion, row.keyVersion),
        eq(entry.ciphertext, row.ciphertext),
        eq(entry.nonce, row.nonce),
      ),
    )
    .returning({ id: entry.id });
  return updated.length === 1 ? "rewrapped" : "conflict";
}

function failureReason(error: unknown): string {
  // Crypto and keyring errors carry no plaintext or key bytes; database errors
  // are reduced to their message.
  return error instanceof Error ? error.message : "unknown error";
}

async function rewrapColumn(
  database: DB,
  entry: EncryptedSecretColumn,
  keyring: IntegrationSecretKeyring,
  options: { dryRun: boolean; batchSize: number },
  failures: RewrapFailure[],
): Promise<RewrapColumnReport> {
  const label = encryptedSecretColumnLabel(entry);
  const report: RewrapColumnReport = {
    table: getTableConfig(entry.table).name,
    column: label,
    pending: 0,
    pendingByVersion: {},
    rewrapped: 0,
    conflicts: 0,
    failed: 0,
    remaining: 0,
  };
  const filter = staleVersionFilter(entry, keyring.currentVersion);

  let cursor: string | null = null;
  for (;;) {
    const rows = (await database
      .select({
        id: entry.id,
        ciphertext: entry.ciphertext,
        nonce: entry.nonce,
        keyVersion: entry.keyVersion,
      })
      .from(entry.table)
      .where(cursor === null ? filter : and(filter, gt(entry.id, cursor)))
      .orderBy(asc(entry.id))
      .limit(options.batchSize)) as EncryptedSecretRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = row.id;
      report.pending += 1;
      const versionKey = row.keyVersion === null ? "legacy_null" : String(row.keyVersion);
      report.pendingByVersion[versionKey] = (report.pendingByVersion[versionKey] ?? 0) + 1;
      try {
        if (options.dryRun) {
          decryptRow(entry, row, keyring);
          report.rewrapped += 1;
          continue;
        }
        const outcome = await rewrapEncryptedSecretRow(database, entry, row, keyring);
        if (outcome === "rewrapped") report.rewrapped += 1;
        else report.conflicts += 1;
      } catch (error) {
        report.failed += 1;
        failures.push({
          column: label,
          id: row.id,
          keyVersion: row.keyVersion,
          reason: failureReason(error),
        });
      }
    }
    if (rows.length < options.batchSize) break;
  }

  const [remaining] = await database.select({ value: count() }).from(entry.table).where(filter);
  report.remaining = Number(remaining?.value ?? 0);
  return report;
}

export async function rewrapIntegrationSecrets(
  database: DB,
  options: RewrapOptions,
): Promise<RewrapReport> {
  const keyring = options.keyring ?? integrationSecretKeyring();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const failures: RewrapFailure[] = [];
  const columns: RewrapColumnReport[] = [];
  for (const entry of ENCRYPTED_INTEGRATION_SECRET_COLUMNS) {
    columns.push(
      await rewrapColumn(database, entry, keyring, { dryRun: options.dryRun, batchSize }, failures),
    );
  }
  const totals = columns.reduce(
    (sum, column) => ({
      pending: sum.pending + column.pending,
      rewrapped: sum.rewrapped + column.rewrapped,
      conflicts: sum.conflicts + column.conflicts,
      failed: sum.failed + column.failed,
      remaining: sum.remaining + column.remaining,
    }),
    { pending: 0, rewrapped: 0, conflicts: 0, failed: 0, remaining: 0 },
  );
  return {
    dryRun: options.dryRun,
    currentVersion: keyring.currentVersion,
    configuredVersions: keyring.versions,
    columns,
    totals,
    failures,
  };
}

/** True when the run left nothing to do: no failures and, for a real run, nothing remaining. */
export function rewrapSucceeded(report: RewrapReport): boolean {
  if (report.totals.failed > 0) return false;
  return report.dryRun || report.totals.remaining === 0;
}
