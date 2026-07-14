import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

// Compatibility bridge for the former org-scoped digest. A legacy setting is
// adopted by the project that owns its pinned Slack installation, but only
// while that project's nullable digestEnabled field is still unconfigured.
// This is idempotent and never overwrites a project-level choice.
export async function adoptLegacyOrgDigestSettings(db: DB, projectId?: string): Promise<number> {
  const legacyRows = await db
    .select({
      projectId: schema.slackInstallations.projectId,
      enabled: schema.orgAgentSettings.digestEnabled,
      installationId: schema.orgAgentSettings.digestSlackInstallationId,
      channelId: schema.orgAgentSettings.digestSlackChannelId,
      channelName: schema.orgAgentSettings.digestSlackChannelName,
      lastRunAt: schema.orgAgentSettings.digestLastRunAt,
      runRequestedAt: schema.orgAgentSettings.digestRunRequestedAt,
    })
    .from(schema.orgAgentSettings)
    .innerJoin(
      schema.slackInstallations,
      eq(schema.slackInstallations.id, schema.orgAgentSettings.digestSlackInstallationId),
    )
    .innerJoin(
      schema.projects,
      and(
        eq(schema.projects.id, schema.slackInstallations.projectId),
        eq(schema.projects.orgId, schema.orgAgentSettings.orgId),
      ),
    )
    .where(
      projectId
        ? and(
            eq(schema.slackInstallations.projectId, projectId),
            isNotNull(schema.orgAgentSettings.digestSlackChannelId),
          )
        : isNotNull(schema.orgAgentSettings.digestSlackChannelId),
    );

  let adopted = 0;
  for (const legacy of legacyRows) {
    if (!legacy.installationId || !legacy.channelId) continue;
    const existing = await db.query.projectAutomationSettings.findFirst({
      where: eq(schema.projectAutomationSettings.projectId, legacy.projectId),
    });
    const values = {
      digestEnabled: legacy.enabled,
      digestSlackInstallationId: legacy.installationId,
      digestSlackChannelId: legacy.channelId,
      digestSlackChannelName: legacy.channelName,
      digestLastRunAt: legacy.lastRunAt,
      digestRunRequestedAt: legacy.runRequestedAt,
      updatedAt: new Date(),
    };

    if (!existing) {
      const inserted = await db
        .insert(schema.projectAutomationSettings)
        .values({ projectId: legacy.projectId, ...values })
        .onConflictDoNothing()
        .returning({ id: schema.projectAutomationSettings.id });
      adopted += inserted.length;
      continue;
    }
    if (existing.digestEnabled !== null) continue;

    const updated = await db
      .update(schema.projectAutomationSettings)
      .set(values)
      .where(
        and(
          eq(schema.projectAutomationSettings.projectId, legacy.projectId),
          isNull(schema.projectAutomationSettings.digestEnabled),
        ),
      )
      .returning({ id: schema.projectAutomationSettings.id });
    adopted += updated.length;
  }
  return adopted;
}
