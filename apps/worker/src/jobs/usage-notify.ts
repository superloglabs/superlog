// Scheduled job: drain the usage-limit notifier out-of-band from the worker
// tick loop. The telemetry meter (in the tick) enqueues orgs that produced
// usage into the in-process `usageNotifier` singleton; this job evaluates that
// queued set on a cron and fires any newly-crossed 50/85/100% notifications
// (email via Resend + Slack). One bounded pass per fire — pg-boss owns the
// schedule and single-active semantics.
//
// Opts out (returns null → not scheduled) when billing is unconfigured
// (AUTUMN_SECRET_KEY unset), so stock/self-host builds schedule nothing.
import { usageNotifier } from "../billing/usage-notifier-ticker.js";
import type { JobDefinition } from "../jobs.js";
import { logger } from "../logger.js";

export const job: JobDefinition = {
  name: "usage-notify",
  // Every 5 minutes — usage moves slowly relative to a monthly cap, and this
  // bounds the per-run Autumn /customers call volume.
  schedule: "*/5 * * * *",
  create: () => {
    const notifier = usageNotifier;
    if (!notifier) return null;
    return async () => {
      const evaluated = await notifier.drain();
      if (evaluated > 0) {
        logger.info(
          { scope: "jobs.usage-notify", evaluated },
          "evaluated orgs for usage notifications",
        );
      }
    };
  },
};
