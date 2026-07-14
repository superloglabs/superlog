// Weekly-digest settings row logic: picking a channel is the enabling action,
// and the toggle pauses/resumes an already-configured digest.

export type WeeklyDigestChannelOption = { id: string; name: string };

export function weeklyDigestChannelSelection(
  next: string,
  channels: readonly WeeklyDigestChannelOption[],
): { channelId: string; channelName: string | null; enabled: true } | null {
  if (!next) return null;
  return {
    channelId: next,
    channelName: channels.find((c) => c.id === next)?.name ?? null,
    enabled: true,
  };
}

export function weeklyDigestToggleDisabled(state: {
  enabled: boolean;
  channelId: string;
  saving: boolean;
}): boolean {
  return state.saving || (!state.enabled && !state.channelId);
}

export function weeklyDigestStatusDescription(state: {
  enabled: boolean;
  channelId: string;
  channelName: string | null;
  lastRunLabel: string;
}): string {
  if (!state.channelId) return "Pick a channel below to start posting";
  if (state.enabled)
    return `Posting to #${state.channelName ?? state.channelId} · ${state.lastRunLabel}`;
  return `Paused · ${state.lastRunLabel}`;
}
