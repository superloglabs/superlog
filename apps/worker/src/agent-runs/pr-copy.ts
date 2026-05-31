type PrCopyContext = {
  incident: { id: string; title: string };
};

type PrCopyResult = {
  summary: string;
  proposedTitle?: string | null;
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
  if (explicit) return explicit;
  return [
    "# Summary",
    "",
    opts.result.summary.trim(),
    "",
    `[Incident on Superlog](${opts.incidentUrl})`,
  ].join("\n");
}
