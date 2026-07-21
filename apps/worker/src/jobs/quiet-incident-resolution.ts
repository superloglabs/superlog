import { createQuietIncidentResolutionRepository } from "../incident-auto-resolution/repository.js";
import { postQuietIncidentResolvedSlackNotification } from "../incident-auto-resolution/slack.js";
import { runQuietIncidentResolutionSweep } from "../incident-auto-resolution/sweep.js";
import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";

export function createQuietIncidentResolutionJob(
  options: { run?: (deps: JobDeps) => Promise<number> } = {},
): JobDefinition {
  return {
    name: "quiet-incident-resolution",
    schedule: "0 3 * * *",
    create: (deps) => async () => {
      if (options.run) {
        await options.run(deps);
        return;
      }
      const repository = createQuietIncidentResolutionRepository(deps.db);
      await runQuietIncidentResolutionSweep({
        now: () => new Date(),
        listCandidates: repository.listCandidates,
        resolveIfStillQuiet: repository.resolveIfStillQuiet,
        postSlackNotification: (input) =>
          postQuietIncidentResolvedSlackNotification(deps.db, input),
        logger,
      });
    },
  };
}

export const job = createQuietIncidentResolutionJob();
