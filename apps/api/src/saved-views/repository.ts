import { db, schema } from "@superlog/db";
import { and, desc, eq, or } from "drizzle-orm";
import type { CreateSavedView, SavedView, SavedViewRepository, UpdateSavedView } from "./domain.js";

function toDomain(row: schema.SavedView): SavedView {
  return {
    ...row,
    state: row.state as SavedView["state"],
  };
}

export class DrizzleSavedViewRepository implements SavedViewRepository {
  async listAccessible(projectId: string, userId: string): Promise<SavedView[]> {
    const rows = await db.query.savedViews.findMany({
      where: and(
        eq(schema.savedViews.projectId, projectId),
        or(
          eq(schema.savedViews.visibility, "workspace"),
          eq(schema.savedViews.createdByUserId, userId),
        ),
      ),
      orderBy: [desc(schema.savedViews.updatedAt)],
    });
    return rows.map(toDomain);
  }

  async find(projectId: string, id: string): Promise<SavedView | null> {
    const row = await db.query.savedViews.findFirst({
      where: and(eq(schema.savedViews.id, id), eq(schema.savedViews.projectId, projectId)),
    });
    return row ? toDomain(row) : null;
  }

  async create(input: CreateSavedView): Promise<SavedView> {
    const [row] = await db
      .insert(schema.savedViews)
      .values({
        projectId: input.projectId,
        createdByUserId: input.createdByUserId,
        name: input.name,
        visibility: input.visibility,
        state: input.state,
      })
      .returning();
    if (!row) throw new Error("saved view insert returned no rows");
    return toDomain(row);
  }

  async update(projectId: string, id: string, input: UpdateSavedView): Promise<SavedView | null> {
    const [row] = await db
      .update(schema.savedViews)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.savedViews.id, id), eq(schema.savedViews.projectId, projectId)))
      .returning();
    return row ? toDomain(row) : null;
  }

  async delete(projectId: string, id: string): Promise<void> {
    await db
      .delete(schema.savedViews)
      .where(and(eq(schema.savedViews.id, id), eq(schema.savedViews.projectId, projectId)));
  }
}
