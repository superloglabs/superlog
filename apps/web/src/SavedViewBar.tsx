import { useEffect, useMemo, useRef, useState } from "react";
import {
  type SavedView,
  type SavedViewVisibility,
  useCreateSavedView,
  useDeleteSavedView,
  useSavedViews,
  useUpdateSavedView,
} from "./api.ts";
import { Btn, Input } from "./design/ui.tsx";
import { type SavedExploreViewState, savedViewStateEquals } from "./saved-view-state.ts";

export function SavedViewBar({
  projectId,
  source,
  currentState,
  activeViewId,
  onApply,
}: {
  projectId: string;
  source: "logs" | "traces";
  currentState: SavedExploreViewState;
  activeViewId: string | null;
  onApply: (state: SavedExploreViewState, savedViewId?: string) => void;
}) {
  const viewsQuery = useSavedViews(projectId);
  const createView = useCreateSavedView(projectId);
  const updateView = useUpdateSavedView(projectId);
  const deleteView = useDeleteSavedView(projectId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  const allViews = viewsQuery.data ?? [];
  const activeView = allViews.find((view) => view.id === activeViewId) ?? null;
  const dirty = activeView ? !savedViewStateEquals(activeView.state, currentState) : false;
  const visibleViews = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return allViews.filter(
      (view) =>
        view.state.source === source &&
        (!normalizedQuery || view.name.toLowerCase().includes(normalizedQuery)),
    );
  }, [allViews, query, source]);
  const personalViews = visibleViews.filter((view) => view.visibility === "personal");
  const workspaceViews = visibleViews.filter((view) => view.visibility === "workspace");

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  function selectView(view: SavedView) {
    onApply(view.state, view.id);
    setMenuOpen(false);
  }

  function removeView(view: SavedView) {
    if (!window.confirm(`Delete “${view.name}”?`)) return;
    deleteView.mutate(view.id, {
      onSuccess: () => {
        if (view.id === activeViewId) onApply(currentState);
      },
    });
  }

  return (
    <>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div ref={menuRef} className="relative min-w-0">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="flex h-8 max-w-[22rem] items-center gap-2 rounded-md border border-border bg-surface-2 px-3 text-[12px] font-medium text-fg transition-colors hover:border-border-strong"
            >
              <StarIcon filled={!!activeView} />
              <span className="truncate">{activeView?.name ?? "Saved views"}</span>
              {dirty && (
                <span className="flex items-center gap-1 text-[10px] font-normal text-warning">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                  Edited
                </span>
              )}
              <ChevronIcon />
            </button>

            {menuOpen && (
              <div className="absolute left-0 top-full z-30 mt-1.5 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-surface shadow-[0_16px_40px_-16px_rgba(0,0,0,0.7)]">
                <div className="border-b border-border p-2.5">
                  <Input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search saved views…"
                    className="h-8"
                  />
                </div>
                <div className="max-h-72 overflow-y-auto p-1.5">
                  <SavedViewGroup
                    label="Workspace"
                    views={workspaceViews}
                    activeViewId={activeViewId}
                    onSelect={selectView}
                    onDelete={removeView}
                  />
                  <SavedViewGroup
                    label="Personal"
                    views={personalViews}
                    activeViewId={activeViewId}
                    onSelect={selectView}
                    onDelete={removeView}
                  />
                  {!viewsQuery.isLoading && visibleViews.length === 0 && (
                    <p className="px-2.5 py-5 text-center text-[12px] text-subtle">
                      {query ? "No matching views" : `No saved ${source} views yet`}
                    </p>
                  )}
                  {viewsQuery.isLoading && (
                    <p className="px-2.5 py-5 text-center text-[12px] text-subtle">Loading…</p>
                  )}
                </div>
                <div className="border-t border-border p-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      setCreateOpen(true);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] font-medium text-fg hover:bg-surface-2"
                  >
                    <PlusIcon /> Save current view…
                  </button>
                </div>
              </div>
            )}
          </div>
          {activeView && (
            <span className="hidden text-[11px] text-subtle md:inline">
              {activeView.visibility === "workspace" ? "Workspace" : "Only you"}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {activeView && dirty && (
            <>
              <Btn size="sm" variant="ghost" onClick={() => selectView(activeView)}>
                Discard changes
              </Btn>
              {activeView.ownedByMe ? (
                <Btn
                  size="sm"
                  variant="secondary"
                  loading={updateView.isPending}
                  onClick={() =>
                    updateView.mutate(
                      { id: activeView.id, state: currentState },
                      { onSuccess: (updated) => onApply(updated.state, updated.id) },
                    )
                  }
                >
                  Update view
                </Btn>
              ) : (
                <Btn size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
                  Save as new
                </Btn>
              )}
            </>
          )}
          {!dirty && (
            <Btn size="sm" variant="ghost" onClick={() => setCreateOpen(true)}>
              <PlusIcon /> Save view
            </Btn>
          )}
        </div>
      </div>

      {createOpen && (
        <CreateSavedViewDialog
          source={source}
          pending={createView.isPending}
          error={createView.error}
          onClose={() => setCreateOpen(false)}
          onSave={(name, visibility) =>
            createView.mutate(
              { name, visibility, state: currentState },
              {
                onSuccess: (created) => {
                  setCreateOpen(false);
                  onApply(created.state, created.id);
                },
              },
            )
          }
        />
      )}
    </>
  );
}

function SavedViewGroup({
  label,
  views,
  activeViewId,
  onSelect,
  onDelete,
}: {
  label: string;
  views: SavedView[];
  activeViewId: string | null;
  onSelect: (view: SavedView) => void;
  onDelete: (view: SavedView) => void;
}) {
  if (views.length === 0) return null;
  return (
    <div className="mb-1 last:mb-0">
      <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-subtle">
        {label}
      </div>
      {views.map((view) => (
        <div
          key={view.id}
          className={`group flex items-center rounded-md transition-colors hover:bg-surface-2 ${
            view.id === activeViewId ? "bg-surface-2" : ""
          }`}
        >
          <button
            type="button"
            onClick={() => onSelect(view)}
            className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left"
          >
            <StarIcon filled={view.id === activeViewId} />
            <span className="flex-1 truncate text-[12px] text-fg">{view.name}</span>
            {view.id === activeViewId && <CheckIcon />}
          </button>
          {view.ownedByMe && (
            <button
              type="button"
              aria-label={`Delete ${view.name}`}
              onClick={() => onDelete(view)}
              className="mr-1 rounded p-1.5 text-subtle opacity-0 hover:bg-surface-3 hover:text-danger focus:opacity-100 group-hover:opacity-100"
            >
              <TrashIcon />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function CreateSavedViewDialog({
  source,
  pending,
  error,
  onClose,
  onSave,
}: {
  source: "logs" | "traces";
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSave: (name: string, visibility: SavedViewVisibility) => void;
}) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<SavedViewVisibility>("personal");

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <button
        type="button"
        aria-label="Close save view dialog"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <form
        className="relative w-full max-w-md rounded-lg border border-border bg-bg p-5 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedName = name.trim();
          if (trimmedName) onSave(trimmedName, visibility);
        }}
      >
        <div className="mb-5">
          <h3 className="text-[15px] font-semibold tracking-tight text-fg">Save current view</h3>
          <p className="mt-1 text-[12px] text-muted">
            Save this {source === "logs" ? "logs" : "traces"} query, filters, and time range.
          </p>
        </div>
        <label className="block text-[11px] font-medium text-muted" htmlFor="saved-view-name">
          Name
        </label>
        <Input
          id="saved-view-name"
          autoFocus
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={source === "logs" ? "Production errors" : "Slow checkout traces"}
          className="mt-2"
        />
        <fieldset className="mt-5">
          <legend className="text-[11px] font-medium text-muted">Who can see it?</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(
              [
                ["personal", "Personal", "Only you"],
                ["workspace", "Workspace", "Everyone in this workspace"],
              ] as const
            ).map(([value, title, description]) => (
              <label
                key={value}
                className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                  visibility === value
                    ? "border-border-strong bg-surface-2"
                    : "border-border hover:border-border-strong"
                }`}
              >
                <input
                  type="radio"
                  name="visibility"
                  value={value}
                  checked={visibility === value}
                  onChange={() => setVisibility(value)}
                  className="sr-only"
                />
                <span className="block text-[12px] font-medium text-fg">{title}</span>
                <span className="mt-1 block text-[10px] leading-4 text-subtle">{description}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p className="mt-3 text-[11px] text-danger">{error.message}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn type="submit" loading={pending} disabled={!name.trim()}>
            Save view
          </Btn>
        </div>
      </form>
    </div>
  );
}

function StarIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 ${filled ? "fill-warning text-warning" : "text-subtle"}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      className="h-3 w-3 text-subtle"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="h-3.5 w-3.5 text-success"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
    </svg>
  );
}
