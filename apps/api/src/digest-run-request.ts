export type DigestRunConfiguration = {
  installationId: string | null;
  channelId: string | null;
};

export type DigestRunRequestStore = {
  findConfiguration(projectId: string): Promise<DigestRunConfiguration | null | undefined>;
  requestRun(projectId: string, requestedAt: Date): Promise<void>;
};

export type DigestRunRequestResult =
  | { status: "not_configured" }
  | { status: "requested"; requestedAt: Date };

// Application service for a project's button-triggered, one-shot digest
// command. The worker owns ranking + Slack delivery; the API only validates
// the destination and persists intent, so a test send never mutates policy.
export async function requestDigestRunForProject(
  projectId: string,
  store: DigestRunRequestStore,
  now: () => Date = () => new Date(),
): Promise<DigestRunRequestResult> {
  const config = await store.findConfiguration(projectId);
  if (!config?.installationId || !config.channelId) return { status: "not_configured" };

  const requestedAt = now();
  await store.requestRun(projectId, requestedAt);
  return { status: "requested", requestedAt };
}
