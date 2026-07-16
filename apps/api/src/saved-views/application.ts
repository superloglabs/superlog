import type { CreateSavedView, SavedViewRepository, UpdateSavedView } from "./domain.js";

export function createSavedViewApplication(repository: SavedViewRepository) {
  return {
    list(projectId: string, userId: string) {
      return repository.listAccessible(projectId, userId);
    },
    create(input: CreateSavedView) {
      return repository.create(input);
    },
    async update(args: {
      projectId: string;
      id: string;
      userId: string;
      input: UpdateSavedView;
    }) {
      const existing = await repository.find(args.projectId, args.id);
      if (!existing) return { status: "not_found" as const };
      if (existing.createdByUserId !== args.userId) return { status: "forbidden" as const };
      const view = await repository.update(args.projectId, args.id, args.input);
      return view ? { status: "ok" as const, view } : { status: "not_found" as const };
    },
    async delete(args: { projectId: string; id: string; userId: string }) {
      const existing = await repository.find(args.projectId, args.id);
      if (!existing) return { status: "not_found" as const };
      if (existing.createdByUserId !== args.userId) return { status: "forbidden" as const };
      await repository.delete(args.projectId, args.id);
      return { status: "ok" as const };
    },
  };
}
