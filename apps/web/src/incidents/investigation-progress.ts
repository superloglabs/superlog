const INVESTIGATING_STATES = new Set(["queued", "repo_discovery", "running", "resuming"]);

export function isInvestigationInProgress(state: string | null | undefined): boolean {
  return state != null && INVESTIGATING_STATES.has(state);
}
