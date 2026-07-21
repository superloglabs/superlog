// Pure content model for the /connect/vercel result page — the landing target
// of the Vercel OAuth callback redirect. Split from the `.tsx` so the copy per
// outcome is unit-testable (mirrors vercelConnectModel.ts).
//
// Why a dedicated page: the install screen opens in a new tab, so the callback
// redirect lands there — not in the tab running the onboarding wizard. The old
// The old root redirect made the outcome easy to miss. This page states the
// result explicitly, then returns to the onboarding state under `/app`.

import { type VercelOutcome, parseVercelOutcome } from "./onboarding/vercelConnectModel.ts";

export type VercelCallbackView = {
  tone: "success" | "error";
  title: string;
  body: string;
  /**
   * Where "Back to Superlog" goes. Failures carry the outcome back to `/app` so
   * the onboarding wizard (which reads `?vercel=` there) resets out of its
   * waiting state when the install happened in the same tab.
   */
  backHref: string;
  backLabel: string;
};

export function vercelCallbackView(raw: string | null | undefined): VercelCallbackView {
  const outcome: VercelOutcome = parseVercelOutcome(raw ?? null);
  switch (outcome) {
    case "installed":
      return {
        tone: "success",
        title: "Vercel connected",
        body: "The trace and log drains are set up. Telemetry will appear in Superlog as your deployments serve traffic — you can close this tab.",
        // Carry the outcome so the onboarding wizard drops into the Vercel
        // flow's connected panel instead of bouncing back to the chooser.
        backHref: "/app?vercel=installed",
        backLabel: "Open Superlog",
      };
    case "drains_unavailable":
      return {
        tone: "error",
        title: "Vercel Drains aren't available on your plan",
        body: "Vercel only offers Drains — the mechanism we use to stream telemetry automatically — on Pro or Enterprise teams. If this team is on Hobby or Pro Trial, Superlog can still help you finish setup with the prompt-based install path.",
        backHref: "/app?vercel=drains_unavailable",
        backLabel: "Back to Superlog",
      };
    case "denied":
      return {
        tone: "error",
        title: "Vercel authorization was declined",
        body: "The install was cancelled on Vercel's side, so nothing was connected. You can try again from Superlog whenever you're ready.",
        backHref: "/app?vercel=denied",
        backLabel: "Back to Superlog",
      };
    case "error":
      return {
        tone: "error",
        title: "We couldn't finish connecting Vercel",
        body: "Something went wrong completing the install, and nothing was connected. Go back to Superlog and try again — if it keeps failing, contact us.",
        backHref: "/app?vercel=error",
        backLabel: "Back to Superlog",
      };
    default:
      return {
        tone: "error",
        title: "No connection result found",
        body: "This page shows the result of a Vercel install, but the link is missing its outcome. Head back to Superlog and check the integration's status in settings.",
        backHref: "/app",
        backLabel: "Back to Superlog",
      };
  }
}
