import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";

export const PROJECT_CONTEXT_MAX_LEN = 8000;

export function clampProjectContext(value: string): string {
  return value.slice(0, PROJECT_CONTEXT_MAX_LEN);
}

export async function getProjectContext(projectId: string): Promise<string> {
  const row = await db.query.projects.findFirst({
    where: eq(schema.projects.id, projectId),
    columns: { projectContext: true },
  });
  return row?.projectContext ?? "";
}

/** Overwrites the freeform context (clamped). Returns the stored value. */
export async function setProjectContext(projectId: string, value: string): Promise<string> {
  const projectContext = clampProjectContext(value);
  await db.update(schema.projects).set({ projectContext }).where(eq(schema.projects.id, projectId));
  return projectContext;
}
