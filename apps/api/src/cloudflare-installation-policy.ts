export type CloudflareWorkerWiringMode = {
  autoWire: boolean;
  wireAfterConnect: boolean;
};

const WORKER_SIGNALS = ["traces", "logs"] as const;

/** Active and retained retry slugs that an explicit bulk unwire must remove. */
export function cloudflareWorkerDestinationRemovalSlugs(
  destinations: Record<string, string> | null | undefined,
): { traces: string[]; logs: string[] } {
  const removalSlugs = { traces: [] as string[], logs: [] as string[] };
  for (const signal of WORKER_SIGNALS) {
    const pendingPrefix = `__previous_${signal}_`;
    const slugs = new Set<string>();
    const active = destinations?.[signal];
    if (active) slugs.add(active);
    for (const [key, slug] of Object.entries(destinations ?? {})) {
      if (key.startsWith(pendingPrefix) && slug) slugs.add(slug);
    }
    removalSlugs[signal] = [...slugs];
  }
  return removalSlugs;
}

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
