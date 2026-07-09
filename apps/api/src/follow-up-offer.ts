// Confirm-gated follow-up offers for feedback. Feedback is noisier than PR
// review comments or Slack replies, so instead of auto-running the agent we
// post a button into the incident's Slack thread and only enqueue when a
// human clicks it (requestFollowUpAgentRun with confirmed=true — see the
// follow_up_confirm handler in slack.ts).
//
// Lives in its own module because feedback.ts and slack.ts already import
// from each other's domains; this only depends on @superlog/db.
import { db, schema } from "@superlog/db";
import { desc, eq } from "drizzle-orm";
import { logger } from "./logger.js";
// User-provided feedback must not be able to inject mentions (<!channel>,
// <@U…>) or links into the incident thread — escape the mrkdwn control chars.
import { escapeSlackLinkText as escapeSlackText } from "./slack-format.js";

const log = logger.child({ scope: "follow-up-offer" });

// kind=incident → refId is the incident UUID; kind=pr → refId is an
// agent_pull_requests UUID (when tracked). kind=issue and untracked PR refs
// don't bind to an incident, so no offer.
export async function resolveFeedbackIncidentId(
  feedback: Pick<schema.Feedback, "kind" | "refId">,
): Promise<string | null> {
  if (feedback.kind === "incident") {
    const incident = await db.query.incidents
      .findFirst({ where: eq(schema.incidents.id, feedback.refId), columns: { id: true } })
      .catch(() => null);
    return incident?.id ?? null;
  }
  if (feedback.kind === "pr") {
    const agentPr = await db.query.agentPullRequests
      .findFirst({
        where: eq(schema.agentPullRequests.id, feedback.refId),
        columns: { incidentId: true },
      })
      .catch(() => null);
    return agentPr?.incidentId ?? null;
  }
  return null;
}

// Best-effort: failures are logged and swallowed; the feedback insert must
// never depend on Slack availability.
export async function offerFollowUpForFeedback(feedback: schema.Feedback): Promise<void> {
  // PR-comment feedback already auto-triggers a follow-up run from the
  // GitHub webhook path — offering a button too would double-trigger.
  if (feedback.source === "pr_comment") return;

  const incidentId = await resolveFeedbackIncidentId(feedback);
  if (!incidentId) return;

  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  if (!incident?.slackChannelId || !incident.slackThreadTs) return;

  // Only offer when there is a finished run to follow up on — mirrors the
  // no_prior_run eligibility check so the button isn't shown when clicking
  // it could never work.
  const priorRun = await db.query.agentRuns.findFirst({
    where: eq(schema.agentRuns.incidentId, incidentId),
    orderBy: [desc(schema.agentRuns.createdAt)],
    columns: { state: true },
  });
  if (!priorRun || (priorRun.state !== "complete" && priorRun.state !== "failed")) return;

  const installation = incident.slackInstallationId
    ? await db.query.slackInstallations.findFirst({
        where: eq(schema.slackInstallations.id, incident.slackInstallationId),
      })
    : null;
  if (!installation?.botAccessToken) return;

  const preview = escapeSlackText(
    feedback.body.length > 280 ? `${feedback.body.slice(0, 277)}…` : feedback.body,
  );
  const text = `New feedback on this incident:\n>${preview}\nWant the agent to run a follow-up investigation that takes it into account?`;
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${installation.botAccessToken}`,
      },
      body: JSON.stringify({
        channel: incident.slackChannelId,
        thread_ts: incident.slackThreadTs,
        text,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text } },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                style: "primary",
                text: { type: "plain_text", text: "Run follow-up" },
                action_id: `follow_up_confirm:${feedback.id}`,
              },
            ],
          },
        ],
      }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      log.warn({ error: data.error, feedback_id: feedback.id }, "follow-up offer post failed");
    }
  } catch (err) {
    log.warn({ err, feedback_id: feedback.id }, "follow-up offer post threw");
  }
}
