export type SavedViewVisibility = "personal" | "workspace";

export type SavedViewState = {
  source: "logs" | "traces";
  range:
    | { type: "relative"; seconds: number; label: string }
    | { type: "absolute"; since: string; until: string };
  attrs: { key: string; value: string }[];
  severity?: string;
  statusCode?: string;
  groupBy?: string;
  tracesView?: "traces" | "spans";
};

export type SavedView = {
  id: string;
  projectId: string;
  createdByUserId: string;
  name: string;
  visibility: SavedViewVisibility;
  state: SavedViewState;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateSavedView = {
  projectId: string;
  createdByUserId: string;
  name: string;
  visibility: SavedViewVisibility;
  state: SavedViewState;
};

export type UpdateSavedView = {
  name?: string;
  visibility?: SavedViewVisibility;
  state?: SavedViewState;
};

export interface SavedViewRepository {
  listAccessible(projectId: string, userId: string): Promise<SavedView[]>;
  find(projectId: string, id: string): Promise<SavedView | null>;
  create(input: CreateSavedView): Promise<SavedView>;
  update(projectId: string, id: string, input: UpdateSavedView): Promise<SavedView | null>;
  delete(projectId: string, id: string): Promise<void>;
}
