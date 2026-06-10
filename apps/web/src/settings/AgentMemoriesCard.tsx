import { useState } from "react";
import {
  type AgentMemory,
  type AgentMemoryKind,
  useCreateProjectAgentMemory,
  useDeleteProjectAgentMemory,
  useProjectAgentMemories,
  useUpdateProjectAgentMemory,
} from "../api.ts";
import { Btn, FieldLabel, Input, Tile } from "../design/ui.tsx";

const MEMORY_KINDS: ReadonlyArray<{ id: AgentMemoryKind; label: string }> = [
  { id: "terminology", label: "Terminology" },
  { id: "infra", label: "Infra" },
  { id: "project", label: "Project" },
  { id: "feedback", label: "Feedback" },
];

const TITLE_MAX_LEN = 200;
const BODY_MAX_LEN = 4000;

export function AgentMemoriesCard({ projectId }: { projectId: string | undefined }) {
  const memoriesQ = useProjectAgentMemories(projectId);
  const memories = memoriesQ.data?.memories ?? [];
  const active = memories.filter((m) => m.status === "active");
  const archived = memories.filter((m) => m.status === "archived");

  return (
    <div className="flex flex-col gap-4">
      <NewMemoryTile projectId={projectId} />
      <Tile>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <FieldLabel>Active memories</FieldLabel>
            <span className="text-[12px] text-muted">
              Injected into every investigation prompt for this project.
            </span>
          </div>
          {memoriesQ.isLoading ? (
            <div className="text-[13px] text-muted">Loading…</div>
          ) : active.length === 0 ? (
            <div className="text-[13px] text-muted">
              No memories yet. The agent saves them as it learns from investigations and your
              replies; you can also add one above.
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {active.map((memory) => (
                <MemoryRow key={memory.id} memory={memory} projectId={projectId} />
              ))}
            </ul>
          )}
        </div>
      </Tile>
      {archived.length > 0 && (
        <Tile>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <FieldLabel>Archived</FieldLabel>
              <span className="text-[12px] text-muted">
                Kept for reference; never injected into prompts.
              </span>
            </div>
            <ul className="flex flex-col divide-y divide-border">
              {archived.map((memory) => (
                <MemoryRow key={memory.id} memory={memory} projectId={projectId} />
              ))}
            </ul>
          </div>
        </Tile>
      )}
    </div>
  );
}

function NewMemoryTile({ projectId }: { projectId: string | undefined }) {
  const create = useCreateProjectAgentMemory(projectId);
  const [kind, setKind] = useState<AgentMemoryKind>("terminology");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const canSave = title.trim().length > 0 && body.trim().length > 0 && !create.isPending;

  return (
    <Tile>
      <div className="space-y-2">
        <FieldLabel>Add a memory</FieldLabel>
        <div className="flex items-center gap-2">
          <KindPicker value={kind} onChange={setKind} />
          <Input
            value={title}
            placeholder="Short title, e.g. Sessions are called journeys"
            maxLength={TITLE_MAX_LEN}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <textarea
          value={body}
          rows={3}
          maxLength={BODY_MAX_LEN}
          placeholder="The fact itself, 1-4 sentences. e.g. Dashboards and alerts here say “journeys” wherever OTel says “sessions”."
          onChange={(e) => setBody(e.target.value)}
          className="w-full rounded-sm border border-border bg-surface-2 p-3 text-[13px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <Btn
            size="sm"
            variant="primary"
            disabled={!canSave}
            onClick={() =>
              create.mutate(
                { kind, title: title.trim(), body: body.trim() },
                {
                  onSuccess: () => {
                    setTitle("");
                    setBody("");
                  },
                },
              )
            }
          >
            Save memory
          </Btn>
          {create.isError && (
            <span className="text-[12px] text-danger">
              {create.error instanceof Error ? create.error.message : "Failed to save"}
            </span>
          )}
        </div>
      </div>
    </Tile>
  );
}

function KindPicker({
  value,
  onChange,
}: {
  value: AgentMemoryKind;
  onChange: (kind: AgentMemoryKind) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as AgentMemoryKind)}
      className="h-8 shrink-0 rounded-sm border border-border bg-surface-2 px-2 text-[13px] text-fg focus:border-border-strong focus:outline-none"
    >
      {MEMORY_KINDS.map((kind) => (
        <option key={kind.id} value={kind.id}>
          {kind.label}
        </option>
      ))}
    </select>
  );
}

function MemoryRow({
  memory,
  projectId,
}: {
  memory: AgentMemory;
  projectId: string | undefined;
}) {
  const update = useUpdateProjectAgentMemory(projectId);
  const remove = useDeleteProjectAgentMemory(projectId);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(memory.title);
  const [body, setBody] = useState(memory.body);
  const busy = update.isPending || remove.isPending;
  const archived = memory.status === "archived";

  if (editing) {
    return (
      <li className="space-y-2 py-3 first:pt-0 last:pb-0">
        <Input value={title} maxLength={TITLE_MAX_LEN} onChange={(e) => setTitle(e.target.value)} />
        <textarea
          value={body}
          rows={3}
          maxLength={BODY_MAX_LEN}
          onChange={(e) => setBody(e.target.value)}
          className="w-full rounded-sm border border-border bg-surface-2 p-3 text-[13px] text-fg focus:border-border-strong focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <Btn
            size="sm"
            variant="primary"
            disabled={busy || title.trim().length === 0 || body.trim().length === 0}
            onClick={() =>
              update.mutate(
                { id: memory.id, title: title.trim(), body: body.trim() },
                { onSuccess: () => setEditing(false) },
              )
            }
          >
            Save
          </Btn>
          <Btn
            size="sm"
            variant="ghost"
            onClick={() => {
              setTitle(memory.title);
              setBody(memory.body);
              setEditing(false);
            }}
          >
            Cancel
          </Btn>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted">
            {memory.kind}
          </span>
          {memory.source && (
            <span className="text-[11px] text-subtle">
              saved by {memory.source === "agent" ? "the agent" : "a teammate"}
            </span>
          )}
          <span className="truncate text-[13px] font-medium text-fg">{memory.title}</span>
        </div>
        <p className="whitespace-pre-wrap text-[13px] text-muted">{memory.body}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!archived && (
          <Btn size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </Btn>
        )}
        <Btn
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => update.mutate({ id: memory.id, status: archived ? "active" : "archived" })}
        >
          {archived ? "Restore" : "Archive"}
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            if (window.confirm("Delete this memory permanently?")) {
              remove.mutate(memory.id);
            }
          }}
        >
          Delete
        </Btn>
      </div>
    </li>
  );
}
