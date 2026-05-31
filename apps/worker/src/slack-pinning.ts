// Helpers for keeping incident Slack threads pinned to the channel where they
// were originally rooted, even when the project's Slack route changes later.
//
// The worker historically used `fetchSlackTarget(projectId)` (i.e. the
// project's *current* route) for both new roots and follow-ups, while reading
// `thread_ts` from the incident row (which was set when the root was posted in
// whatever channel was current *then*). When the route changed, follow-ups
// shipped to the new channel with a thread_ts that didn't exist there: Slack
// silently dropped the thread_ts on chat.postMessage (loose top-level posts)
// and returned message_not_found on chat.update (closing edits silently lost).
// Production telemetry has incidents whose anchors are stale by weeks.
//
// The pinning fix is: follow-ups go to the channel of the thread root, not the
// project's current route. Only when Slack reports the anchor is unreachable
// do we drop it and lazily re-root in the current route.

export const STALE_SLACK_ANCHOR_ERRORS: ReadonlySet<string> = new Set([
  // Slack's chat.postMessage / chat.update return one of these when the
  // (channel, ts/thread_ts) tuple no longer points at a real conversation
  // we can reach.
  "thread_not_found",
  "message_not_found",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
]);

export function isStaleSlackAnchorError(error: string | null | undefined): boolean {
  return !!error && STALE_SLACK_ANCHOR_ERRORS.has(error);
}
