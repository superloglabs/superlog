type GcpConnectionStatus = "pending" | "provisioning" | "connected" | "failed" | null;

export function gcpConnectAction(status: GcpConnectionStatus) {
  return status === "connected"
    ? {
        buttonLabel: "Change Google Cloud project",
        inputLabel: "New Google Cloud project ID",
      }
    : {
        buttonLabel: "Connect Google Cloud",
        inputLabel: "Google Cloud project ID",
      };
}
