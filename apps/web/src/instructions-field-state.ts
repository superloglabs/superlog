export type InstructionsSyncInput = {
  /** Whether the field has already seeded its draft from the server. */
  loaded: boolean;
  /** Whether the underlying settings query has actually resolved. */
  settingsLoaded: boolean;
  /** The instructions value coming from the server. */
  serverValue: string;
  /** Whether the editor is currently expanded. */
  expanded: boolean;
};

export type InstructionsSyncResult = {
  draft: string;
  loaded: true;
  expanded: boolean;
};

/**
 * Decide how an instructions editor should seed its local draft from the
 * server value.
 *
 * The draft is seeded exactly once, and only after the settings query has
 * actually resolved — never from the placeholder empty value emitted while the
 * query is still pending. Returns `null` when no state change is needed (either
 * because the draft is already seeded, or because the server data hasn't loaded
 * yet), so the field doesn't clobber the user's in-progress edits on refetch.
 */
export function syncInstructionsDraft(input: InstructionsSyncInput): InstructionsSyncResult | null {
  if (input.loaded || !input.settingsLoaded) return null;
  return {
    draft: input.serverValue,
    loaded: true,
    expanded: input.expanded || input.serverValue.length > 0,
  };
}
