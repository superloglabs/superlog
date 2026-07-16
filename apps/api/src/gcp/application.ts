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

export async function completeGcpConnect(input: {
  connectionId: string;
  code?: string;
  userAccessToken?: string;
  gcpProjectNumber?: string;
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
    if (input.userAccessToken) {
      accessToken = input.userAccessToken;
    } else if (input.code) {
      ({ accessToken } = await input.gateway.exchangeCode(input.code));
    } else {
      throw new Error("Google OAuth authorization is required");
    }
    provisioned = await input.gateway.provision(
      provisioningInput(connection, accessToken, input.config, input.gcpProjectNumber),
    );
    await input.repository.ensureIngestKey(connection.id, connection.projectId);
    if (superseded) {
      supersededCleanupAttempted = true;
      await input.gateway.deprovision({
        connectionId: superseded.id,
        gcpProjectId: superseded.gcpProjectId,
        userAccessToken: accessToken,
        integrationProjectId: input.config.integrationProjectId,
        readerServiceAccountEmail: superseded.readerServiceAccountEmail,
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
      let restoreSuperseded = true;
      try {
        const latest = await input.repository.findById(superseded.id);
        restoreSuperseded = latest?.status === "connected" && !latest.revokedAt;
      } catch {
        // Preserve the original recovery behavior when persistence itself is unavailable.
      }
      if (restoreSuperseded) {
        try {
          await input.gateway.provision(provisioningInput(superseded, accessToken, input.config));
        } catch (restoreError) {
          const restoreMessage =
            restoreError instanceof Error ? restoreError.message : "unknown restore error";
          message = `${message}; previous connection restore failed: ${restoreMessage}`;
        }
      }
    }
    if (accessToken && provisioned) {
      try {
        await input.gateway.deprovision({
          connectionId: connection.id,
          gcpProjectId: connection.gcpProjectId,
          userAccessToken: accessToken,
          integrationProjectId: input.config.integrationProjectId,
          readerServiceAccountEmail: connection.readerServiceAccountEmail,
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
    readerServiceAccountEmail: connection.readerServiceAccountEmail,
    grantCreated: provisioned.monitoringViewerGrantCreated,
  });
  return { ...provisioned, monitoringViewerGrantCreated: removeGrant };
}

function provisioningInput(
  connection: GcpConnectionRecord,
  accessToken: string,
  config: GcpApplicationConfig,
  gcpProjectNumber?: string,
): GcpProvisioningInput {
  return {
    connectionId: connection.id,
    gcpProjectId: connection.gcpProjectId,
    ...(gcpProjectNumber ? { gcpProjectNumber } : {}),
    userAccessToken: accessToken,
    integrationProjectId: config.integrationProjectId,
    readerServiceAccountEmail: connection.readerServiceAccountEmail,
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
