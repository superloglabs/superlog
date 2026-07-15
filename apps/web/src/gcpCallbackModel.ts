export type GcpCallbackView = {
  tone: "success" | "error";
  title: string;
  body: string;
  backLabel: string;
  backHref: string;
};

export function gcpCallbackView(outcome: string | null | undefined): GcpCallbackView {
  if (outcome === "connected") {
    return {
      tone: "success",
      title: "Google Cloud connected",
      body: "Logs are streaming and bounded metric collection is enabled. Superlog pays for Pub/Sub and Monitoring API reads.",
      backLabel: "Back to settings",
      backHref: "/settings",
    };
  }
  if (outcome === "denied") {
    return {
      tone: "error",
      title: "Google Cloud access not granted",
      body: "Access was not granted, so nothing was changed. Return to settings when you're ready to try again.",
      backLabel: "Back to settings",
      backHref: "/settings",
    };
  }
  return {
    tone: "error",
    title: "Google Cloud setup failed",
    body: "We couldn't finish the connection. No user OAuth token was saved; return to settings to retry.",
    backLabel: "Back to settings",
    backHref: "/settings",
  };
}
