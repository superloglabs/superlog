import type { GcpConnectionRecord, GcpConnectionRepository, GcpGateway } from "./domain.js";

export type GcpApplicationConfig = {
  integrationProjectId: string;
  readerServiceAccountEmail: string;
  pushServiceAccountEmail: string;
  pushAudience: string;
  pushEndpoint: string;
};

export async function startGcpConnect(input: {
  projectId: string;
  userId: string;
  gcpProjectId: string;
  repository: GcpConnectionRepository;
  gateway: GcpGateway;
  config: GcpApplicationConfig;
  signState: (connectionId: string) => string;
}): Promise<{ connection: GcpConnectionRecord; url: string }> {
  const connection = await input.repository.create({
    projectId: input.projectId,
    gcpProjectId: input.gcpProjectId,
    readerServiceAccountEmail: input.config.readerServiceAccountEmail,
    createdBy: input.userId,
  });
  return {
    connection,
    url: input.gateway.authorizationUrl({ state: input.signState(connection.id) }),
  };
}

export async function completeGcpConnect(input: {
  connectionId: string;
  code: string;
  repository: GcpConnectionRepository;
  gateway: GcpGateway;
  config: GcpApplicationConfig;
}): Promise<GcpConnectionRecord> {
  const connection = await input.repository.findById(input.connectionId);
  if (!connection || connection.revokedAt) throw new Error("GCP connection not found");

  await input.repository.markProvisioning(connection.id);
  try {
    // This token intentionally remains a local variable and is never passed to
    // persistence. It exists only long enough to perform customer-authorized setup.
    const { accessToken } = await input.gateway.exchangeCode(input.code);
    const result = await input.gateway.provision({
      connectionId: connection.id,
      gcpProjectId: connection.gcpProjectId,
      userAccessToken: accessToken,
      integrationProjectId: input.config.integrationProjectId,
      readerServiceAccountEmail: input.config.readerServiceAccountEmail,
      pushServiceAccountEmail: input.config.pushServiceAccountEmail,
      pushAudience: input.config.pushAudience,
      pushEndpoint: `${input.config.pushEndpoint.replace(/\/$/, "")}/${connection.id}`,
    });
    await input.repository.ensureIngestKey(connection.id, connection.projectId);
    return await input.repository.markConnected(connection.id, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GCP provisioning failed";
    await input.repository.markFailed(connection.id, message);
    throw error;
  }
}
