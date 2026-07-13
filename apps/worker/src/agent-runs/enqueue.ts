// Process-wide hook for enqueueing an agent-run advance job from code that
// can't (and shouldn't) hold a pg-boss reference — e.g. the incident workflow
// that creates runs. Unset (stock boot order, tests, degraded queue) it is a
// no-op: the minute sweep advances every active run regardless, so this hook
// only buys latency, never correctness.
let dispatch: ((agentRunId: string) => Promise<void>) | null = null;

export function setAgentRunJobDispatch(fn: ((agentRunId: string) => Promise<void>) | null): void {
  dispatch = fn;
}

export async function dispatchAgentRunJob(agentRunId: string): Promise<void> {
  if (!dispatch) return;
  await dispatch(agentRunId);
}
