import type {
  GcpConnectionRecord,
  GcpConnectionRepository,
  GcpGateway,
  GcpProvisioningInput,
  ProvisionedGcpConnection,
} from "./domain.js";

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
  if (connection.status === "connected") return connection;
  const current = await input.repository.findCurrent(connection.projectId);
  const superseded =
    current?.status === "connected" && current.id !== connection.id ? current : null;

  await input.repository.markProvisioning(connection.id);
  let accessToken: string | null = null;
  let provisioned: Awaited<ReturnType<GcpGateway["provision"]>> | null = null;
  let supersededCleanupAttempted = false;
  try {
    // This token intentionally remains a local variable and is never passed to
    // persistence. It exists only long enough to perform customer-authorized setup.
    ({ accessToken } = await input.gateway.exchangeCode(input.code));
    provisioned = await input.gateway.provision(
      provisioningInput(connection, accessToken, input.config),
    );
    await input.repository.ensureIngestKey(connection.id, connection.projectId);
    if (superseded) {
      supersededCleanupAttempted = true;
      await input.gateway.deprovision({
        connectionId: superseded.id,
        gcpProjectId: superseded.gcpProjectId,
        userAccessToken: accessToken,
        integrationProjectId: input.config.integrationProjectId,
        readerServiceAccountEmail: input.config.readerServiceAccountEmail,
        provisioned: await cleanupProvisioningResult(
          superseded,
          persistedProvisioningResult(superseded),
          input.repository,
        ),
      });
    }
    return await input.repository.markConnected(connection.id, provisioned, superseded?.id ?? null);
  } catch (error) {
    let message = error instanceof Error ? error.message : "GCP provisioning failed";
    if (accessToken && superseded && supersededCleanupAttempted) {
      try {
        await input.gateway.provision(provisioningInput(superseded, accessToken, input.config));
      } catch (restoreError) {
        const restoreMessage =
          restoreError instanceof Error ? restoreError.message : "unknown restore error";
        message = `${message}; previous connection restore failed: ${restoreMessage}`;
      }
    }
    if (accessToken && provisioned) {
      try {
        await input.gateway.deprovision({
          connectionId: connection.id,
          gcpProjectId: connection.gcpProjectId,
          userAccessToken: accessToken,
          integrationProjectId: input.config.integrationProjectId,
          readerServiceAccountEmail: input.config.readerServiceAccountEmail,
          provisioned: await cleanupProvisioningResult(connection, provisioned, input.repository),
        });
      } catch (cleanupError) {
        const cleanupMessage =
          cleanupError instanceof Error ? cleanupError.message : "unknown cleanup error";
        message = `${message}; cleanup failed: ${cleanupMessage}`;
      }
    }
    await input.repository.markFailed(connection.id, message);
    throw error;
  }
}

async function cleanupProvisioningResult(
  connection: GcpConnectionRecord,
  provisioned: ProvisionedGcpConnection,
  repository: GcpConnectionRepository,
): Promise<ProvisionedGcpConnection> {
  if (!provisioned.monitoringViewerGrantCreated) return provisioned;
  const removeGrant = await repository.prepareMonitoringGrantRemoval({
    connectionId: connection.id,
    gcpProjectId: connection.gcpProjectId,
    grantCreated: provisioned.monitoringViewerGrantCreated,
  });
  return { ...provisioned, monitoringViewerGrantCreated: removeGrant };
}

function provisioningInput(
  connection: GcpConnectionRecord,
  accessToken: string,
  config: GcpApplicationConfig,
): GcpProvisioningInput {
  return {
    connectionId: connection.id,
    gcpProjectId: connection.gcpProjectId,
    userAccessToken: accessToken,
    integrationProjectId: config.integrationProjectId,
    readerServiceAccountEmail: config.readerServiceAccountEmail,
    pushServiceAccountEmail: config.pushServiceAccountEmail,
    pushAudience: config.pushAudience,
    pushEndpoint: `${config.pushEndpoint.replace(/\/$/, "")}/${connection.id}`,
  };
}

function persistedProvisioningResult(connection: GcpConnectionRecord): ProvisionedGcpConnection {
  if (
    !connection.gcpProjectNumber ||
    !connection.topicName ||
    !connection.subscriptionName ||
    !connection.logSinkName ||
    !connection.logSinkWriterIdentity
  ) {
    throw new Error("Connected GCP connection is missing provisioned resource metadata");
  }
  return {
    gcpProjectNumber: connection.gcpProjectNumber,
    topicName: connection.topicName,
    subscriptionName: connection.subscriptionName,
    logSinkName: connection.logSinkName,
    logSinkWriterIdentity: connection.logSinkWriterIdentity,
    monitoringViewerGrantCreated: connection.monitoringViewerGrantCreated,
  };
}
