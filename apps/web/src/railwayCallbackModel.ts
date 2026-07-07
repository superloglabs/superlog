// Pure content model for the /connect/railway result page — the landing target
// of the Railway OAuth callback redirect. Split from the `.tsx` so the copy per
// outcome is unit-testable (mirrors vercelCallbackModel.ts).

import { type RailwayOutcome, parseRailwayOutcome } from "./onboarding/railwayConnectModel.ts";

export type RailwayCallbackView = {
  tone: "success" | "error";
  title: string;
  body: string;
  /**
   * Where "Back to Superlog" goes. Failures carry the outcome back to `/` so
   * the onboarding wizard (which reads `?railway=` there) resets out of its
   * waiting state when the consent happened in the same tab.
   */
  backHref: string;
  backLabel: string;
};

export function railwayCallbackView(raw: string | null | undefined): RailwayCallbackView {
  const outcome: RailwayOutcome = parseRailwayOutcome(raw ?? null);
  switch (outcome) {
    case "installed":
      return {
        tone: "success",
        title: "Railway connected",
        body: "We're pulling logs and infra metrics from the Railway projects you shared. First events typically appear in Superlog within a minute — you can close this tab.",
        // Carry the outcome so the onboarding wizard drops into the Railway
        // flow's connected panel (which waits for first events) instead of
        // bouncing back to the integration chooser.
        backHref: "/?railway=installed",
        backLabel: "Open Superlog",
      };
    case "no_projects":
      return {
        tone: "error",
        title: "No Railway projects were shared",
        body: "The grant went through, but no projects were selected on Railway's consent screen, so there is nothing to pull telemetry from. Nothing was connected. Connect again and pick at least one project.",
        backHref: "/?railway=no_projects",
        backLabel: "Back to Superlog",
      };
    case "denied":
      return {
        tone: "error",
        title: "Railway authorization was declined",
        body: "The request was cancelled on Railway's side, so nothing was connected. You can try again from Superlog whenever you're ready.",
        backHref: "/?railway=denied",
        backLabel: "Back to Superlog",
      };
    case "error":
      return {
        tone: "error",
        title: "We couldn't finish connecting Railway",
        body: "Something went wrong completing the connection, and nothing was connected. Go back to Superlog and try again — if it keeps failing, contact us.",
        backHref: "/?railway=error",
        backLabel: "Back to Superlog",
      };
    default:
      return {
        tone: "error",
        title: "No connection result found",
        body: "This page shows the result of a Railway connection, but the link is missing its outcome. Head back to Superlog and check the integration's status in settings.",
        backHref: "/",
        backLabel: "Back to Superlog",
      };
  }
}
