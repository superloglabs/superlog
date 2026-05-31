export const DEFAULT_ATTIO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function resolveAttioSyncIntervalMs(value: number | string | null | undefined): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_ATTIO_SYNC_INTERVAL_MS;
  }
  return parsed;
}
