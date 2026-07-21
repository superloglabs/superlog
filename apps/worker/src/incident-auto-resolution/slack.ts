import { type DB, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { buildIncidentUrl } from "../incident-route.js";
import {
  incidentBlocks,
  postIncidentThreadMessage,
  updateIncidentMainMessage,
} from "../infra/slack/incident-messages.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";

export async function postQuietIncidentResolvedSlackNotification(
  database: DB,
  input: { incidentId: string; message: string },
): Promise<void> {
  const incident = await database.query.incidents.findFirst({
    where: eq(schema.incidents.id, input.incidentId),
  });
  if (!incident) return;
  const project = await database.query.projects.findFirst({
    where: eq(schema.projects.id, incident.projectId),
  });
  if (!project) return;
  const org = await database.query.orgs.findFirst({
    where: eq(schema.orgs.id, project.orgId),
  });
  if (!org) return;

  await postIncidentThreadMessage(incident.id, input.message);
  const incidentUrl = buildIncidentUrl(WEB_ORIGIN, {
    orgSlug: org.slug,
    projectSlug: project.slug,
    incidentId: incident.id,
  });
  await updateIncidentMainMessage(
    incident.id,
    `:white_check_mark: ${incident.title} — Automatically resolved`,
    incidentBlocks({
      emoji: "white_check_mark",
      status: "Automatically resolved",
      title: incident.title,
      titleUrl: incidentUrl,
      tagline: "No linked errors recurred for 14 days.",
      service: incident.service,
      environment: incident.environment,
      buttons: [],
      incidentId: incident.id,
      showFeedbackButtons: true,
    }),
  );
}
