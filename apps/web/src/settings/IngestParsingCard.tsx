import { useEffect, useMemo, useRef, useState } from "react";
import {
  type IngestFilterState,
  type LogParseConfig,
  type LogParseSource,
  SEVERITY_LEVELS,
  type SeverityLevel,
  type SourceParseConfig,
  useAgentSettings,
  useIngestFilters,
  useLogParsePreview,
  useSaveAgentSettings,
  useSetIngestFilters,
} from "../api";
import { Btn } from "../design/ui";
import { SettingsCard, SettingsCardFooter, SettingsRow } from "./rows";

// ---------------------------------------------------------------------------
// The Ingest & parsing settings live as a small multi-screen "log pipeline":
//   1. a source chooser (which telemetry source to configure), then
//   2. a per-source stage view (Receive → Parse body → Detect severity → Route)
//      where Detect severity is the functional editor (keys + value mapping +
//      a live preview run against real recent log bodies).
// The config itself rides on the project's automation settings (logParseConfig),
// the same channel issueFilterConfig uses.
// ---------------------------------------------------------------------------

type Stage = "receive" | "parse" | "detect" | "route";

const STAGES: { value: Stage; label: string }[] = [
  { value: "receive", label: "Receive" },
  { value: "parse", label: "Parse body" },
  { value: "detect", label: "Detect severity" },
  { value: "route", label: "Route" },
];

const SOURCES: {
  id: LogParseSource;
  name: string;
  blurb: string;
}[] = [
  {
    id: "aws",
    name: "AWS CloudWatch",
    blurb: "Logs streamed from CloudWatch via Firehose. Levels live inside the JSON body.",
  },
  {
    id: "otlp",
    name: "OpenTelemetry SDKs",
    blurb: "Logs from your OTLP exporters. Usually carry a severity already; parsing fills the gaps.",
  },
];

// Dot color per canonical level — colored dot, neutral text (house style).
const LEVEL_DOT: Record<SeverityLevel, string> = {
  TRACE: "bg-subtle",
  DEBUG: "bg-muted",
  INFO: "bg-accent",
  WARN: "bg-warning",
  ERROR: "bg-danger",
  FATAL: "bg-danger",
};

const LEVEL_LABEL: Record<SeverityLevel, string> = {
  TRACE: "Trace",
  DEBUG: "Debug",
  INFO: "Info",
  WARN: "Warning",
  ERROR: "Error",
  FATAL: "Fatal",
};

// Value-mapping rows are grouped by canonical level, most severe first.
const MAP_ORDER: SeverityLevel[] = ["FATAL", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

// ---- UI-friendly draft shape (value map edited as an ordered list) ----------

type SourceDraft = {
  enabled: boolean;
  keys: string[];
  mappings: { raw: string; level: SeverityLevel }[];
};

type Draft = Record<LogParseSource, SourceDraft>;

const toSourceDraft = (c: SourceParseConfig): SourceDraft => ({
  enabled: c.enabled,
  keys: [...c.severityKeys],
  mappings: Object.entries(c.severityValueMap).map(([raw, level]) => ({ raw, level })),
});

const toDraft = (c: LogParseConfig): Draft => ({
  aws: toSourceDraft(c.aws),
  otlp: toSourceDraft(c.otlp),
});

const sourceDraftToConfig = (d: SourceDraft): SourceParseConfig => {
  const severityValueMap: Record<string, SeverityLevel> = {};
  for (const m of d.mappings) {
    const raw = m.raw.trim().toLowerCase();
    if (raw) severityValueMap[raw] = m.level;
  }
  return {
    enabled: d.enabled,
    severityKeys: d.keys.map((k) => k.trim()).filter(Boolean),
    severityValueMap,
  };
};

const draftToConfig = (d: Draft): LogParseConfig => ({
  aws: sourceDraftToConfig(d.aws),
  otlp: sourceDraftToConfig(d.otlp),
});

// Stable serialization for the dirty check. Key order *is* significant (drag to
// reorder), but value-map order is not — and jsonb round-trips can reorder it —
// so sort the mappings before comparing to avoid a spuriously-dirty state.
const canonicalDraft = (d: Draft): string => {
  const norm = (s: SourceDraft) => ({
    enabled: s.enabled,
    keys: s.keys,
    mappings: [...s.mappings].sort(
      (a, b) => a.raw.localeCompare(b.raw) || a.level.localeCompare(b.level),
    ),
  });
  return JSON.stringify({ aws: norm(d.aws), otlp: norm(d.otlp) });
};

// ---------------------------------------------------------------------------

export function IngestParsingSection({ projectId }: { projectId: string | undefined }) {
  const settings = useAgentSettings(projectId);
  const save = useSaveAgentSettings(projectId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [source, setSource] = useState<LogParseSource | null>(null);
  const [stage, setStage] = useState<Stage>("receive");

  // (Re)load the draft whenever the active project changes; otherwise keep
  // editing locally until saved (mirrors IssueFilterCard). Without the
  // projectId guard, switching projects would carry the previous project's
  // config into the new project and a save would clobber it.
  const loadedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (loadedFor.current === projectId) return;
    if (!settings.data) {
      // New project, its settings haven't loaded yet — drop the stale draft.
      if (draft !== null) setDraft(null);
      return;
    }
    setDraft(toDraft(settings.data.logParseConfig));
    loadedFor.current = projectId;
    setSource(null);
    setStage("receive");
  }, [projectId, settings.data, draft]);

  const remote = settings.data ? toDraft(settings.data.logParseConfig) : null;
  const dirty = useMemo(
    () => (draft && remote ? canonicalDraft(draft) !== canonicalDraft(remote) : false),
    [draft, remote],
  );

  if (!draft) {
    return <p className="text-[13px] text-muted">Loading…</p>;
  }

  const setSourceDraft = (s: LogParseSource, next: SourceDraft) =>
    setDraft({ ...draft, [s]: next });

  const onSave = () => {
    if (!projectId) return;
    save.mutate({ logParseConfig: draftToConfig(draft) });
  };

  if (source === null) {
    return (
      <PipelineChooser
        draft={draft}
        onPick={(s) => {
          setSource(s);
          setStage("receive");
        }}
      />
    );
  }

  const sourceMeta = SOURCES.find((s) => s.id === source)!;

  return (
    <section className="space-y-5">
      <button
        type="button"
        onClick={() => setSource(null)}
        className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-fg"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m15 18-6-6 6-6" />
        </svg>
        Ingest &amp; parsing
      </button>

      <div>
        <h2 className="text-[15px] font-medium">{sourceMeta.name}</h2>
        <p className="text-[13px] text-muted">{sourceMeta.blurb}</p>
      </div>

      {/* Segmented pipeline stepper — no container chrome; only the active
          stage gets a pill, the rest are plain muted labels. */}
      <div className="-ml-1 flex w-fit items-center gap-0.5">
        {STAGES.map((s) => {
          const active = s.value === stage;
          return (
            <button
              key={s.value}
              type="button"
              onClick={() => setStage(s.value)}
              className={`h-[30px] px-3.5 text-[13px] transition-colors ${
                active
                  ? "rounded-full bg-surface-2 font-medium text-fg"
                  : "rounded-md text-muted hover:text-fg"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {stage === "receive" && <ReceiveStage projectId={projectId} source={source} />}
      {stage === "parse" && <ParseBodyStage />}
      {stage === "detect" && (
        <DetectSeverityStage
          projectId={projectId}
          source={source}
          value={draft[source]}
          onChange={(next) => setSourceDraft(source, next)}
        />
      )}
      {stage === "route" && <RouteStage />}

      {(stage === "detect" || stage === "receive") && (
        <SettingsCardFooter>
          {save.isError && <span className="text-[12px] text-danger">Couldn’t save. Try again.</span>}
          {dirty && !save.isPending && <span className="text-[12px] text-muted">Unsaved changes</span>}
          <Btn
            size="sm"
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => remote && setDraft(remote)}
          >
            Discard
          </Btn>
          <Btn size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={onSave}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Btn>
        </SettingsCardFooter>
      )}
    </section>
  );
}

// ---- Screen 1: pipeline / source chooser -----------------------------------

function PipelineChooser({ draft, onPick }: { draft: Draft; onPick: (s: LogParseSource) => void }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-[15px] font-medium">Ingest &amp; parsing</h2>
        <p className="text-[13px] text-muted">
          Pick a telemetry source to configure how its logs are parsed and how severity is detected.
        </p>
      </div>
      <SettingsCard>
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s.id)}
            className="flex w-full items-center justify-between gap-6 px-5 py-4 text-left hover:bg-surface-2"
          >
            <div className="min-w-0">
              <p className="text-[13.5px] font-medium text-fg">{s.name}</p>
              <p className="mt-0.5 text-[12.5px] text-muted">{s.blurb}</p>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-subtle" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        ))}
      </SettingsCard>
    </section>
  );
}

// ---- Stage: Receive --------------------------------------------------------

function ReceiveStage({
  projectId,
  source,
}: {
  projectId: string | undefined;
  source: LogParseSource;
}) {
  const filters = useIngestFilters(projectId);
  const setFilters = useSetIngestFilters(projectId ?? "");
  const state = filters.data;

  const signalsFor = (s: IngestFilterState | undefined) =>
    source === "aws"
      ? ([["logs", s?.aws.logs], ["metrics", s?.aws.metrics]] as const)
      : ([["traces", s?.otlp.traces], ["logs", s?.otlp.logs], ["metrics", s?.otlp.metrics]] as const);

  const toggle = (signal: string, next: boolean) => {
    if (!state) return;
    const updated: IngestFilterState = {
      otlp: { ...state.otlp },
      aws: { ...state.aws },
    };
    (updated[source] as Record<string, boolean>)[signal] = next;
    setFilters.mutate(updated);
  };

  return (
    <div className="space-y-5">
      <p className="text-[13px] text-muted">
        Where logs enter Superlog from this source. Choose which signals you accept; everything else
        flows on to the next stage.
      </p>
      <div className="space-y-2">
        <p className="px-0.5 text-[13px] font-medium text-fg">Signals</p>
        <SettingsCard>
          {signalsFor(state).map(([signal, enabled]) => (
            <SettingsRow
              key={signal}
              title={signal.charAt(0).toUpperCase() + signal.slice(1)}
              control={
                <MiniToggle
                  checked={enabled ?? true}
                  disabled={!state || setFilters.isPending}
                  onChange={(v) => toggle(signal, v)}
                />
              }
            />
          ))}
        </SettingsCard>
      </div>
    </div>
  );
}

// ---- Stage: Parse body (informational) -------------------------------------

function ParseBodyStage() {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Structured log bodies are decoded as JSON so their fields become addressable. A body like{" "}
        <code className="rounded bg-surface-2 px-1 py-0.5 text-[12px]">{`{"level":"error","msg":"…"}`}</code>{" "}
        is parsed once here, then handed to <span className="text-fg">Detect severity</span>, which
        reads the level out of it. Plain-text lines pass through untouched.
      </p>
    </div>
  );
}

// ---- Stage: Detect severity (the functional editor) ------------------------

function DetectSeverityStage({
  projectId,
  source,
  value,
  onChange,
}: {
  projectId: string | undefined;
  source: LogParseSource;
  value: SourceDraft;
  onChange: (next: SourceDraft) => void;
}) {
  // Debounce the config that drives the live preview so typing doesn't fire a
  // request per keystroke (and, with keepPreviousData, the card never collapses).
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 350);
    return () => clearTimeout(t);
  }, [value]);
  const previewConfig = useMemo(() => sourceDraftToConfig(debounced), [debounced]);
  const preview = useLogParsePreview(projectId, source, previewConfig);

  // ---- severity field keys (ordered, drag-to-reorder) ----
  const [dragKey, setDragKey] = useState<number | null>(null);
  const setKey = (i: number, k: string) => {
    const keys = [...value.keys];
    keys[i] = k;
    onChange({ ...value, keys });
  };
  const removeKey = (i: number) => onChange({ ...value, keys: value.keys.filter((_, j) => j !== i) });
  const addKey = () => onChange({ ...value, keys: [...value.keys, ""] });
  const moveKey = (from: number, to: number) => {
    if (from === to) return;
    const keys = [...value.keys];
    const [moved] = keys.splice(from, 1);
    if (moved === undefined) return;
    keys.splice(to, 0, moved);
    onChange({ ...value, keys });
  };

  // ---- value mapping (grouped by level; chips are the raw synonyms) ----
  const removeMapping = (flatIndex: number) =>
    onChange({ ...value, mappings: value.mappings.filter((_, j) => j !== flatIndex) });
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerRaw, setComposerRaw] = useState("");
  const [composerLevel, setComposerLevel] = useState<SeverityLevel>("ERROR");
  const closeComposer = () => {
    setComposerOpen(false);
    setComposerRaw("");
  };
  const commitComposer = () => {
    const raw = composerRaw.trim().toLowerCase();
    if (!raw) return;
    onChange({ ...value, mappings: [...value.mappings, { raw, level: composerLevel }] });
    setComposerRaw("");
  };
  const groups = MAP_ORDER.map((level) => ({
    level,
    items: value.mappings.map((m, i) => ({ ...m, i })).filter((m) => m.level === level),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-6">
      <SettingsCard>
        <SettingsRow
          title="Detect severity from the body"
          description="Read a level out of each parsed log and map it to an OTLP severity, so body-only levels still classify."
          control={
            <MiniToggle checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
          }
        />
      </SettingsCard>

      {/* Severity field keys */}
      <div className="space-y-3">
        <ListHeader
          title="Severity field keys"
          description="Checked in order on each parsed log. The first key that exists wins — its value becomes the severity."
          addLabel="Add key"
          onAdd={addKey}
        />
        <SettingsCard>
          {value.keys.length === 0 ? (
            <EmptyCard
              text="No keys yet — add the field that carries the level (e.g. level)."
              addLabel="Add key"
              onAdd={addKey}
            />
          ) : (
            value.keys.map((k, i) => (
              <div
                key={i}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragKey !== null) moveKey(dragKey, i);
                  setDragKey(null);
                }}
                className={`flex h-12 items-center gap-3 px-4 ${dragKey === i ? "opacity-40" : ""}`}
              >
                <span
                  draggable
                  onDragStart={() => setDragKey(i)}
                  onDragEnd={() => setDragKey(null)}
                  aria-label="Drag to reorder"
                  className="shrink-0 cursor-grab text-subtle hover:text-muted active:cursor-grabbing"
                >
                  <GripIcon />
                </span>
                <input
                  value={k}
                  onChange={(e) => setKey(i, e.target.value)}
                  placeholder="level"
                  className="h-full w-full bg-transparent text-[13px] text-fg placeholder:text-subtle focus:outline-none"
                />
                <RemoveBtn onClick={() => removeKey(i)} />
              </div>
            ))
          )}
        </SettingsCard>
      </div>

      {/* Value mapping — grouped by canonical level, synonyms as chips */}
      <div className="space-y-3">
        <ListHeader
          title="Value mapping"
          description="Standard values like error / warn map automatically. Add a row to translate values we don’t recognise."
          addLabel="Add mapping"
          onAdd={() => setComposerOpen(true)}
        />
        <SettingsCard>
          {groups.length === 0 && !composerOpen ? (
            <EmptyCard
              text="No custom mappings — built-in synonyms still apply."
              addLabel="Add mapping"
              onAdd={() => setComposerOpen(true)}
            />
          ) : (
            <>
              {groups.map((g) => (
                <div key={g.level} className="flex min-h-12 items-center gap-4 px-4 py-2.5">
                  <div className="flex w-24 shrink-0 items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${LEVEL_DOT[g.level]}`} />
                    <span className="text-[12.5px] font-medium text-fg">{LEVEL_LABEL[g.level]}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {g.items.map((m) => (
                      <span
                        key={m.i}
                        className="inline-flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pl-2 pr-1 font-mono text-[12.5px] text-fg"
                      >
                        {m.raw}
                        <button
                          type="button"
                          onClick={() => removeMapping(m.i)}
                          aria-label={`Remove ${m.raw}`}
                          className="grid h-4 w-4 place-items-center rounded text-subtle hover:text-fg"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                            <path d="M6 6 18 18M18 6 6 18" />
                          </svg>
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {composerOpen && (
                <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                  <input
                    value={composerRaw}
                    autoFocus
                    onChange={(e) => setComposerRaw(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitComposer();
                      if (e.key === "Escape") closeComposer();
                    }}
                    placeholder="value, e.g. emerg"
                    className="h-8 w-44 rounded-md border border-border bg-surface-2 px-2.5 font-mono text-[12.5px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
                  />
                  <span className="text-[12px] text-muted">maps to</span>
                  <LevelSelect value={composerLevel} onChange={setComposerLevel} />
                  <Btn size="sm" variant="secondary" disabled={!composerRaw.trim()} onClick={commitComposer}>
                    Add
                  </Btn>
                  <button
                    type="button"
                    onClick={closeComposer}
                    className="px-1 text-[12px] text-subtle hover:text-fg"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </>
          )}
        </SettingsCard>
      </div>

      {/* Live preview */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-0.5">
          <p className="text-[13px] font-medium text-fg">Live preview</p>
          <span className="text-[12px] text-subtle">Recent log bodies from this project</span>
        </div>
        <SettingsCard>
          {!value.enabled ? (
            <EmptyRow text="Detection is off — turn it on above to preview." />
          ) : preview.isLoading ? (
            <EmptyRow text="Sampling recent logs…" />
          ) : !preview.data || preview.data.rows.length === 0 ? (
            <EmptyRow text="No recent logs to preview yet." />
          ) : (
            preview.data.rows.map((row, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <code className="block truncate text-[12px] text-muted">{row.body}</code>
                </div>
                {row.detection ? (
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-fg">
                    <span className={`h-1.5 w-1.5 rounded-full ${LEVEL_DOT[row.detection.level]}`} />
                    {row.detection.level}
                    <span className="text-subtle">· {row.detection.matchedKey}</span>
                  </span>
                ) : (
                  <span className="shrink-0 text-[12px] text-subtle">no match</span>
                )}
              </div>
            ))
          )}
        </SettingsCard>
      </div>
    </div>
  );
}

// ---- Stage: Route (informational) ------------------------------------------

function RouteStage() {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Parsed logs land in your telemetry store with their detected severity. Anything at{" "}
        <span className="text-fg">ERROR</span> or above (OTLP SeverityNumber ≥ 17) becomes eligible
        to open an issue — subject to your <span className="text-fg">Issue filter</span> — so
        body-only errors now surface instead of staying invisible.
      </p>
    </div>
  );
}

// ---- Small shared bits -----------------------------------------------------

// Section header: title + description on the left, a right-aligned add button.
function ListHeader({
  title,
  description,
  addLabel,
  onAdd,
}: {
  title: string;
  description: string;
  addLabel: string;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-0.5">
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium text-fg">{title}</p>
        <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>
      </div>
      <Btn size="sm" variant="secondary" onClick={onAdd}>
        {addLabel}
      </Btn>
    </div>
  );
}

// Empty-card body: descriptive line + a central add button.
function EmptyCard({
  text,
  addLabel,
  onAdd,
}: {
  text: string;
  addLabel: string;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-7 text-center">
      <p className="max-w-sm text-[12.5px] text-muted">{text}</p>
      <Btn size="sm" variant="secondary" onClick={onAdd}>
        {addLabel}
      </Btn>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="px-4 py-6 text-center text-[12.5px] text-muted">{text}</div>;
}

// Six-dot drag handle (matches the Paper grip).
function GripIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

// Compact level picker for the value-mapping composer (appearance-none + chevron).
function LevelSelect({
  value,
  onChange,
}: {
  value: SeverityLevel;
  onChange: (l: SeverityLevel) => void;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SeverityLevel)}
        className="h-8 appearance-none rounded-md border border-border bg-surface-2 pl-2.5 pr-7 text-[12.5px] text-fg focus:border-border-strong focus:outline-none"
      >
        {SEVERITY_LEVELS.map((l) => (
          <option key={l} value={l}>
            {LEVEL_LABEL[l]}
          </option>
        ))}
      </select>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-subtle" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Remove"
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-subtle hover:bg-surface-2 hover:text-fg"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  );
}

function MiniToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${
        checked ? "bg-accent" : "bg-surface-2 border border-border"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}
