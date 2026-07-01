export type InstructionsSyncInput = {
  /** Whether the underlying settings query has actually resolved. */
  settingsLoaded: boolean;
  /** The latest instructions value coming from the server. */
  serverValue: string;
  /** The current local draft in the editor. */
  draft: string;
  /**
   * The server value the draft was last reconciled to, or `null` if the editor
   * has never seeded from a resolved query yet. The editor is "clean" when
   * `draft === syncedValue`.
   */
  syncedValue: string | null;
  /** Whether the editor is currently expanded. */
  expanded: boolean;
};

export type InstructionsSyncResult = {
  draft: string;
  syncedValue: string;
  expanded: boolean;
};

/**
 * Decide how an instructions editor should reconcile its local draft with the
 * server value.
 *
 * Rules (returns `null` when no state change is needed):
 *  - Do nothing until the settings query has actually resolved — seeding from
 *    the placeholder "" emitted while the query is pending would leave the
 *    field stuck empty on a cold load.
 *  - On the first resolved value, seed the draft (and expand when there are
 *    saved instructions).
 *  - When the server value changes and the editor is clean (no local edits),
 *    follow it — so a background refetch or an edit made elsewhere is picked up
 *    instead of being permanently ignored.
 *  - When the user has unsaved edits, never clobber them. The one exception is
 *    when the server catches up to exactly the draft (e.g. right after the
 *    user's own save lands): reconcile the bookkeeping without touching the
 *    draft, so the editor becomes clean again and resumes following the server.
 */
export function syncInstructionsDraft(input: InstructionsSyncInput): InstructionsSyncResult | null {
  const { settingsLoaded, serverValue, draft, syncedValue, expanded } = input;
  if (!settingsLoaded) return null;

  const seed = (value: string): InstructionsSyncResult => ({
    draft: value,
    syncedValue: value,
    expanded: expanded || value.length > 0,
  });

  // First resolved value — seed the draft from the server.
  if (syncedValue === null) return seed(serverValue);

  // Already reconciled to this exact server value: nothing to do.
  if (serverValue === syncedValue) return null;

  // Clean editor (no local edits) — follow the new server value.
  if (draft === syncedValue) return seed(serverValue);

  // The server caught up to the draft (e.g. our own save landed) — reconcile
  // the bookkeeping without disturbing the draft.
  if (draft === serverValue) return { draft, syncedValue: serverValue, expanded };

  // Genuine conflict: keep the user's in-progress edits.
  return null;
}
