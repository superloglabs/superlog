type GcpConnectionStatus = "pending" | "provisioning" | "connected" | "failed" | null;

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
