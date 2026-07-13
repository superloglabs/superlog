import { type ReactNode, useEffect, useMemo } from "react";
import { type LogRow, useIssueForLog, useLogSymbolication } from "./api.ts";
import { RowMenu, type RowMenuItem } from "./design/RowMenu.tsx";
import { attrFilterKey } from "./exploreAttrFilter.ts";
import { formatLocalTimestampMs } from "./timeFormat.ts";

export function LogDrawer({
  projectId,
  log,
  onClose,
  onOpenTrace,
  onOpenIssue,
  onAddFilter,
}: {
  projectId?: string;
  log: LogRow | null;
  onClose: () => void;
  onOpenTrace?: (traceId: string) => void;
  onOpenIssue?: (issueId: string) => void;
  // Add a scope-prefixed key=value filter to the current logs view. When
  // omitted (e.g. the drawer is shown outside the filterable explore page) the
  // per-attribute filter buttons are hidden.
  onAddFilter?: (key: string, value: string) => void;
}) {
  useEffect(() => {
    if (!log) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [log, onClose]);

  if (!log) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[720px] flex-col border-l border-border bg-bg shadow-2xl">
        <DrawerHeader log={log} onClose={onClose} />
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <LogDrawerBody
            projectId={projectId}
            log={log}
            onOpenTrace={onOpenTrace}
            onOpenIssue={onOpenIssue}
            onAddFilter={onAddFilter}
          />
        </div>
      </aside>
    </div>
  );
}

function DrawerHeader({ log, onClose }: { log: LogRow; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
      <div className="min-w-0">
        <SectionHeader>Log</SectionHeader>
        <div className="mt-1 flex items-center gap-2 font-mono text-[13px] text-fg">
          <SeverityChip severity={log.severity} />
          <span className="text-muted">{log.service || "—"}</span>
          <span className="text-subtle">{formatLocalTimestampMs(log.timestamp)}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 rounded-sm border border-border px-2 py-1 font-mono text-[11px] text-muted hover:text-fg"
        title="close (esc)"
      >
        ✕
      </button>
    </div>
  );
}

function LogDrawerBody({
  projectId,
  log,
  onOpenTrace,
  onOpenIssue,
  onAddFilter,
}: {
  projectId?: string;
  log: LogRow;
  onOpenTrace?: (traceId: string) => void;
  onOpenIssue?: (issueId: string) => void;
  onAddFilter?: (key: string, value: string) => void;
}) {
  const parsedBody = useMemo(() => tryParseJson(log.body), [log.body]);
  const logAttrs = useMemo(() => sortedEntries(log.log_attrs), [log.log_attrs]);
  const resourceAttrs = useMemo(() => sortedEntries(log.resource_attrs), [log.resource_attrs]);
  const { data: issueLookup } = useIssueForLog(projectId, log);
  const { data: symbolicationLookup } = useLogSymbolication(projectId, log);
  const issue = issueLookup?.issue ?? null;
  const symbolication = symbolicationLookup?.symbolication ?? null;

  return (
    <div className="flex flex-col gap-5">
      {issue && onOpenIssue ? (
        <section>
          <SectionHeader>Error</SectionHeader>
          <button
            type="button"
            onClick={() => onOpenIssue(issue.id)}
            className="mt-2 flex w-full items-center justify-between gap-3 border border-border bg-surface-2 px-3 py-2 text-left font-mono text-[12px] text-fg hover:border-fg/40"
          >
            <span className="min-w-0 flex-1 truncate">
              <span className="text-subtle">{issue.exceptionType}</span>
              {issue.title ? <span className="ml-2">{issue.title}</span> : null}
            </span>
            <span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-muted">
              open error →
            </span>
          </button>
        </section>
      ) : null}

      {symbolication ? (
        <section>
          <div className="flex items-center justify-between gap-3">
            <SectionHeader>Original stack</SectionHeader>
            <span className="font-mono text-[10px] text-subtle">
              {symbolication.artifact.platform} - {symbolication.artifact.release}
            </span>
          </div>
          <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap break-all border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] text-fg">
            {symbolication.stacktrace}
          </pre>
        </section>
      ) : null}

      <section>
        <SectionHeader>Body</SectionHeader>
        <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap break-all border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] text-fg">
          {parsedBody !== undefined ? JSON.stringify(parsedBody, null, 2) : log.body || "—"}
        </pre>
      </section>

      <section>
        <SectionHeader>Identifiers</SectionHeader>
        <KvList
          rows={[
            { key: "timestamp", value: formatLocalTimestampMs(log.timestamp) },
            {
              key: "severity",
              value: log.severity || "—",
              // Severity has a dedicated facet; Explore routes `field.severity`
              // there so it doesn't duplicate the canonical severity pill.
              menu: menuOf(
                log.severity ? logFilterItem("field.severity", log.severity, onAddFilter) : null,
              ),
            },
            {
              key: "severity_number",
              value: log.severity_number ? String(log.severity_number) : "—",
              menu: menuOf(
                log.severity_number
                  ? logFilterItem("field.severity_number", String(log.severity_number), onAddFilter)
                  : null,
              ),
            },
            { key: "service", value: log.service || "—" },
            {
              key: "trace_id",
              value: log.trace_id || "—",
              menu: menuOf(
                log.trace_id && onOpenTrace
                  ? { label: "Open trace", onClick: () => onOpenTrace(log.trace_id) }
                  : null,
                log.trace_id ? logFilterItem("field.trace_id", log.trace_id, onAddFilter) : null,
              ),
            },
            {
              key: "span_id",
              value: log.span_id || "—",
              menu: menuOf(
                log.span_id ? logFilterItem("field.span_id", log.span_id, onAddFilter) : null,
              ),
            },
          ]}
        />
      </section>

      <section>
        <SectionHeader>
          Log attributes <Count>{logAttrs.length}</Count>
        </SectionHeader>
        {logAttrs.length === 0 ? (
          <EmptyHint>none</EmptyHint>
        ) : (
          <KvList
            rows={logAttrs.map(([k, v]) => ({
              key: k,
              value: v,
              menu: menuOf(logFilterItem(attrFilterKey("log", k), v, onAddFilter)),
            }))}
          />
        )}
      </section>

      <section>
        <SectionHeader>
          Resource attributes <Count>{resourceAttrs.length}</Count>
        </SectionHeader>
        {resourceAttrs.length === 0 ? (
          <EmptyHint>none</EmptyHint>
        ) : (
          <KvList
            rows={resourceAttrs.map(([k, v]) => ({
              key: k,
              value: v,
              menu: menuOf(logFilterItem(attrFilterKey("resource", k), v, onAddFilter)),
            }))}
          />
        )}
      </section>
    </div>
  );
}

function SectionHeader({ children }: { children: ReactNode }) {
  return <h3 className="text-[12px] font-medium tracking-tight text-fg">{children}</h3>;
}

function Count({ children }: { children: ReactNode }) {
  return (
    <span className="ml-1 font-mono text-[11px] font-normal text-subtle tabular-nums">
      {children}
    </span>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 border border-border px-3 py-2 font-mono text-[11px] text-subtle">
      {children}
    </div>
  );
}

type KvRow = { key: string; value: string; menu?: RowMenuItem[] };

// A "Filter logs on this value" menu item. `key` is the already-scoped filter
// key (`log.<k>` / `resource.<k>` / `field.<id>`). Returns null when no filter
// handler is wired so callers can drop it.
function logFilterItem(
  key: string,
  value: string,
  onAddFilter?: (key: string, value: string) => void,
): RowMenuItem | null {
  if (!onAddFilter) return null;
  return { label: "Filter logs on this value", onClick: () => onAddFilter(key, value) };
}

// Collapse a list of maybe-items into a RowMenu's items, or undefined when
// nothing is actionable (so the row renders without a kebab).
function menuOf(...items: (RowMenuItem | null)[]): RowMenuItem[] | undefined {
  const out = items.filter((i): i is RowMenuItem => i !== null);
  return out.length > 0 ? out : undefined;
}

function KvList({ rows }: { rows: KvRow[] }) {
  return (
    <dl className="mt-2 grid grid-cols-[minmax(140px,auto)_1fr] border border-border font-mono text-[12px]">
      {rows.map((row, i) => (
        <div
          key={`${row.key}-${row.value}`}
          className={`contents ${i > 0 ? "[&>*]:border-t [&>*]:border-border" : ""}`}
        >
          <dt className="flex items-center break-all border-r border-border bg-surface-2 px-3 py-1.5 text-subtle">
            {row.key}
          </dt>
          <dd className="flex items-center justify-between gap-2 px-3 py-1.5 text-fg">
            <span className="min-w-0 flex-1 break-all">{row.value}</span>
            {row.menu ? <RowMenu items={row.menu} compact /> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SeverityChip({ severity }: { severity: string }) {
  const s = (severity || "").toUpperCase();
  const cls = !s
    ? "bg-muted/15 text-muted"
    : s.includes("ERROR") || s.includes("FATAL")
      ? "bg-danger/15 text-danger"
      : s.includes("WARN")
        ? "bg-warning/15 text-warning"
        : s.includes("DEBUG") || s.includes("TRACE")
          ? "bg-muted/15 text-muted"
          : "bg-success/15 text-success";
  return (
    <span
      className={`inline-flex items-center rounded-sm px-2 py-0.5 font-mono text-[11px] tabular-nums ${cls}`}
    >
      {s || "—"}
    </span>
  );
}

function tryParseJson(s: string): unknown | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function sortedEntries(m: Record<string, string> | undefined | null): [string, string][] {
  if (!m) return [];
  return Object.entries(m).sort(([a], [b]) => a.localeCompare(b));
}
