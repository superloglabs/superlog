import type { schema } from "@superlog/db";

type AgentRunTrigger = schema.AgentRunTrigger;

type PrCopyContext = {
  incident: { id: string; title: string };
};

type PrCopyResult = {
  summary: string;
  proposedTitle?: string | null;
  linearTicket?: { id: string; url?: string | null } | null;
};

type PrCopyPr = {
  title?: string | null;
  body?: string | null;
};

export function buildLegacyPrReceiptTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.startsWith("[superlog]") ? trimmed : `[superlog] ${trimmed}`;
}

export function buildPrTitle(opts: {
  ctx: PrCopyContext;
  result: PrCopyResult;
  pr: PrCopyPr;
}): string {
  const explicit = opts.pr.title?.trim();
  // The explicit title already reflects repository and organization guidance;
  // delivery must not silently override required or forbidden conventions.
  if (explicit) return explicit;
  const proposed = opts.result.proposedTitle?.trim();
  if (proposed) return buildLegacyPrReceiptTitle(proposed);
  return buildLegacyPrReceiptTitle(opts.ctx.incident.title);
}

// Investigations a workspace member started on purpose. Every other run began
// from telemetry or an alert, and its input includes text that people outside
// the team can influence (error messages, log lines, alert payloads).
const MEMBER_STARTED_TRIGGERS: ReadonlySet<AgentRunTrigger> = new Set([
  "manual",
  "linear",
  "web_chat",
]);

export const AUTOMATIC_INVESTIGATION_PR_NOTE = [
  "> [!NOTE]",
  "> Superlog wrote this change during an automatic investigation. Its input included error messages, logs, and alerts that people outside your team can influence. Review it as you would a change from an outside contributor.",
].join("\n");

export function buildPrBody(opts: {
  incidentUrl: string;
  trigger: AgentRunTrigger;
  result: PrCopyResult;
  pr: PrCopyPr;
}): string {
  const explicit = opts.pr.body?.trim();
  const base =
    explicit ||
    [
      "# Summary",
      "",
      opts.result.summary.trim(),
      "",
      `[Incident on Superlog](${opts.incidentUrl})`,
    ].join("\n");
  const body = withLinearReference(base, opts.result.linearTicket);
  if (MEMBER_STARTED_TRIGGERS.has(opts.trigger)) return body;
  return `${body}\n\n${AUTOMATIC_INVESTIGATION_PR_NOTE}`;
}

// Deterministically stitch the filed Linear ticket into the PR body so the
// agent doesn't have to remember to (its body schema actively pushes toward a
// minimal body), and so Linear's GitHub integration auto-links the PR to the
// issue. We mention the id without a `Closes`/`Fixes` magic word on purpose —
// linking is always wanted, but auto-resolving the tracking issue on merge is a
// per-team call we don't make here. Skip if the body already names the ticket.
function withLinearReference(
  body: string,
  ticket: { id: string; url?: string | null } | null | undefined,
): string {
  if (!ticket?.id || body.includes(ticket.id)) return body;
  const reference = ticket.url ? `[${ticket.id}](${ticket.url})` : ticket.id;
  return `${body}\n\nLinear: ${reference}`;
}
