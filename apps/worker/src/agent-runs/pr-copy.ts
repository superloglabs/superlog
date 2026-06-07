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

function withSuperlogPrefix(title: string): string {
  const trimmed = title.trim();
  return trimmed.startsWith("[superlog]") ? trimmed : `[superlog] ${trimmed}`;
}

export function buildPrTitle(opts: {
  ctx: PrCopyContext;
  result: PrCopyResult;
  pr: PrCopyPr;
}): string {
  const explicit = opts.pr.title?.trim();
  if (explicit) return withSuperlogPrefix(explicit);
  const proposed = opts.result.proposedTitle?.trim();
  if (proposed) return withSuperlogPrefix(proposed);
  return withSuperlogPrefix(opts.ctx.incident.title);
}

export function buildPrBody(opts: {
  incidentUrl: string;
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
  return withLinearReference(base, opts.result.linearTicket);
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
