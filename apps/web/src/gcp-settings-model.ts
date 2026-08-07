type GcpConnectionStatus = "pending" | "provisioning" | "connected" | "failed" | null;

const GCP_LOG_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export function gcpConnectAction(status: GcpConnectionStatus) {
  return status === "connected"
    ? {
        buttonLabel: "Change Google Cloud project",
      }
    : {
        buttonLabel: "Connect Google Cloud",
      };
}

export function gcpLogGroupLabel(logName: string): string {
  const encoded = logName.split("/logs/")[1] ?? logName;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function gcpLogDiscoveryRange(until: Date): { since: string; until: string } {
  return {
    since: new Date(until.getTime() - GCP_LOG_DISCOVERY_WINDOW_MS).toISOString(),
    until: until.toISOString(),
  };
}

export function mergeGcpLogNames(
  discoveredLogNames: readonly string[],
  excludedLogNames: readonly string[],
): string[] {
  return Array.from(new Set([...discoveredLogNames, ...excludedLogNames])).sort((a, b) =>
    gcpLogGroupLabel(a).localeCompare(gcpLogGroupLabel(b)),
  );
}

export function canToggleGcpLogGroup(
  currentlyEnabled: boolean,
  excludedCount: number,
  maxLogExclusions: number,
): boolean {
  return !currentlyEnabled || excludedCount < maxLogExclusions;
}
