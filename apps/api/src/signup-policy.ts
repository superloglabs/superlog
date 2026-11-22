// New accounts are opt-in per deployment. Production keeps sign-ups closed
// unless SIGNUPS_ENABLED=true; other environments stay open unless
// SIGNUPS_ENABLED=false. The environment resolves like the API's
// deployment environment: SUPERLOG_ENV, then NODE_ENV.
export function newSignupsOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.SIGNUPS_ENABLED?.trim().toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  const deployment = (env.SUPERLOG_ENV ?? env.NODE_ENV ?? "development").trim().toLowerCase();
  return deployment !== "production";
}

export const SIGNUPS_CLOSED_MESSAGE = "New sign-ups are closed.";
