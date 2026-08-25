export type CloudflareWorkerWiringMode = {
  autoWire: boolean;
  wireAfterConnect: boolean;
};

/**
 * New connections require an explicit Worker selection. Reconnects preserve the
 * installation's existing preference so they do not undo a user's choice.
 */
export function cloudflareWorkerWiringMode(
  existingAutoWire: boolean | null,
): CloudflareWorkerWiringMode {
  const autoWire = existingAutoWire ?? false;
  return { autoWire, wireAfterConnect: autoWire };
}
