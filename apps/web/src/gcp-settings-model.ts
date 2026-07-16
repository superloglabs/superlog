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
