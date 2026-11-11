import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useNavigate } from "react-router-dom";
import { useProjectPath } from "../ProjectRouteContext.tsx";
import { useTopology, useGenerateTopology, useMe, useExploreLogs, useExploreTraces, useStartInvestigation } from "../api.ts";
import { Tile, Btn, Chip, Label, PageHeader, ShortcutKey } from "../design/ui.tsx";

// ---------------------------------------------------------------------------
// Topology Radius — column-based flow graph (Sources → Services → Infra →
// Sessions) with the inspector panel OUTSIDE the canvas and AI design
// recommendations. Visual patterns mirror TopologyCanvas.tsx / ServiceMap.
// ---------------------------------------------------------------------------

const PIXEL_NUMBER_STYLE: CSSProperties = {
  fontFamily: '"Geist Pixel", ui-monospace, monospace',
  fontSynthesis: "none",
  WebkitFontSmoothing: "none",
};

const CARD_BG =
  "linear-gradient(0deg, var(--color-surface-2), var(--color-surface-2)), var(--color-bg)";

// ---- types -----------------------------------------------------------------

type NodeLayer = "code" | "service" | "infra" | "session";
type NodeStatus = "healthy" | "degraded" | "down";
type EdgeProvenance = "telemetry" | "infra" | "suggested";

interface RadiusNode {
  id: string;
  label: string;
  sublabel?: string;
  kind: string;
  layer: NodeLayer;
  status: NodeStatus;
  metric?: { label: string; value: string };
  logLine?: { severity: "ERROR" | "WARN" | "INFO"; text: string };
  traceSpan?: { name: string; durationMs: number };
  resource?: { cpu: string; mem: string };
  commitSha?: string;
  author?: string;
  codeFile?: string;
  affectedUsers?: number;
  details?: string;
  col: number; // 0-based column index
  row: number; // 0-based row within column
}

interface RadiusEdge {
  id: string;
  from: string;
  to: string;
  source: EdgeProvenance;
  isBlast?: boolean;
  label?: string;
}

interface DesignRec {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  body: string;
  nodeId?: string;
}

// ---- icons (from TopologyCanvas.tsx) ---------------------------------------

const KIND_ICON: Record<string, ReactNode> = {
  service: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  ),
  database: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  ),
  cache: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  ),
  edge: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
    </svg>
  ),
  compute: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </svg>
  ),
  external: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6M10 14 21 3" />
    </svg>
  ),
};
const iconFor = (kind: string): ReactNode => KIND_ICON[kind] ?? KIND_ICON.compute;

const EDGE_STYLE: Record<EdgeProvenance, { stroke: string; width: number; opacity: number; dash?: string }> = {
  telemetry: { stroke: "var(--color-accent)", width: 1.7, opacity: 0.85 },
  infra: { stroke: "var(--color-subtle)", width: 1.25, opacity: 0.5 },
  suggested: { stroke: "var(--color-accent)", width: 1.5, opacity: 0.7, dash: "5 4" },
};

const STATUS_COLOR: Record<NodeStatus, string> = {
  healthy: "var(--color-success)",
  degraded: "var(--color-warning)",
  down: "var(--color-danger)",
};

// ---- column layout constants -----------------------------------------------

const COLUMNS: { layer: NodeLayer; heading: string }[] = [
  { layer: "code", heading: "Source Commits" },
  { layer: "service", heading: "Microservices" },
  { layer: "infra", heading: "Infrastructure" },
  { layer: "session", heading: "User Sessions" },
];

const COL_W = 260;
const COL_GAP = 100;
const ROW_H = 120;
const NODE_W = 240;
const NODE_H = 72;
const PAD_TOP = 60;
const PAD_LEFT = 30;

function nodePos(col: number, row: number) {
  return {
    x: PAD_LEFT + col * (COL_W + COL_GAP),
    y: PAD_TOP + row * ROW_H,
  };
}

// ---- data ------------------------------------------------------------------

const NODES: RadiusNode[] = [
  { id: "commit-1", label: "c0a4f91", sublabel: "feat(payment): leak Redis pool", kind: "compute", layer: "code", status: "down", commitSha: "c0a4f91e92d8", author: "alex@superlog.io", codeFile: "payment-worker.ts:L42", metric: { label: "Changed lines", value: "+14 / -2" }, logLine: { severity: "ERROR", text: "RedisPoolExhaustion: 10000 sockets open" }, details: "Unclosed socket connections in checkout handler cause pool exhaustion.", col: 0, row: 0 },
  { id: "commit-2", label: "b11a92e", sublabel: "fix(gateway): proxy timeout", kind: "compute", layer: "code", status: "healthy", commitSha: "b11a92e88a01", author: "dev@superlog.io", codeFile: "proxy-config.ts:L14", metric: { label: "Changed lines", value: "+4 / -1" }, details: "Adjusted upstream keep-alive timeouts to 15s.", col: 0, row: 1 },

  { id: "svc-payment", label: "payment-service", sublabel: "Go · v2.4.1", kind: "service", layer: "service", status: "down", metric: { label: "P99 latency", value: "4,250 ms" }, resource: { cpu: "88 %", mem: "1.4 GB" }, logLine: { severity: "ERROR", text: "RedisConnectionTimeout: pool exhausted (10000/10000)" }, traceSpan: { name: "POST /v1/checkout/charge", durationMs: 4250 }, details: "High error rate due to Redis socket timeout.", col: 1, row: 0 },
  { id: "svc-gateway", label: "api-gateway", sublabel: "Rust / Hono Proxy", kind: "edge", layer: "service", status: "degraded", metric: { label: "Throughput", value: "2,450 req/s" }, resource: { cpu: "42 %", mem: "512 MB" }, logLine: { severity: "WARN", text: "HTTP 504 Timeout downstream /v1/checkout/charge" }, traceSpan: { name: "PROXY /v1/checkout/charge", durationMs: 5004 }, details: "504 timeouts cascading from payment-service.", col: 1, row: 1 },
  { id: "svc-auth", label: "auth-service", sublabel: "Node.js Better-Auth", kind: "service", layer: "service", status: "healthy", metric: { label: "P99 latency", value: "18 ms" }, resource: { cpu: "12 %", mem: "280 MB" }, logLine: { severity: "INFO", text: "JWT validation succeeded for user_usr_991823" }, traceSpan: { name: "POST /api/auth/validate", durationMs: 18 }, details: "All validations performing nominally.", col: 1, row: 2 },

  { id: "infra-redis", label: "redis-primary.prod", sublabel: "Redis Cluster · 6379", kind: "cache", layer: "infra", status: "down", metric: { label: "Active conns", value: "10k / 10k" }, resource: { cpu: "96 %", mem: "7.8 GB" }, logLine: { severity: "ERROR", text: "MaxConnsReached: CLOSE_WAIT accumulation" }, details: "Connection limit maxed. 9,800 in CLOSE_WAIT.", col: 2, row: 0 },
  { id: "infra-pg", label: "postgres-main.db", sublabel: "PostgreSQL 16 · RDS", kind: "database", layer: "infra", status: "healthy", metric: { label: "CPU util", value: "24 %" }, resource: { cpu: "24 %", mem: "3.2 GB" }, details: "Query performance nominal.", col: 2, row: 1 },
  { id: "infra-ch", label: "clickhouse-cluster", sublabel: "ClickHouse OTEL", kind: "database", layer: "infra", status: "healthy", metric: { label: "Ingestion", value: "48.2k ev/s" }, resource: { cpu: "38 %", mem: "12 GB" }, details: "Telemetry pipeline active and healthy.", col: 2, row: 2 },

  { id: "ep-checkout", label: "/v1/checkout/charge", sublabel: "342 users impacted", kind: "external", layer: "session", status: "down", affectedUsers: 342, metric: { label: "Impacted", value: "342" }, logLine: { severity: "ERROR", text: "Session checkout failure: 504 Timeout" }, details: "Conversion dropped 82.4 % in 30 min.", col: 3, row: 0 },
  { id: "ep-auth", label: "/api/auth/validate", sublabel: "1,850 sessions normal", kind: "external", layer: "session", status: "healthy", affectedUsers: 0, metric: { label: "Sessions", value: "1,850" }, details: "Tokens validating without errors.", col: 3, row: 1 },
];

const EDGES: RadiusEdge[] = [
  { id: "e1", from: "commit-1", to: "svc-payment", source: "infra", isBlast: true },
  { id: "e2", from: "commit-2", to: "svc-gateway", source: "infra" },
  { id: "e3", from: "svc-payment", to: "infra-redis", source: "telemetry", isBlast: true, label: "reads" },
  { id: "e4", from: "svc-payment", to: "svc-gateway", source: "telemetry", isBlast: true, label: "calls" },
  { id: "e5", from: "svc-gateway", to: "svc-auth", source: "telemetry", label: "calls" },
  { id: "e6", from: "svc-auth", to: "infra-pg", source: "telemetry", label: "reads" },
  { id: "e7", from: "svc-gateway", to: "infra-pg", source: "telemetry", label: "reads" },
  { id: "e8", from: "svc-payment", to: "infra-ch", source: "telemetry", label: "writes" },
  { id: "e9", from: "svc-payment", to: "ep-checkout", source: "telemetry", isBlast: true },
  { id: "e10", from: "svc-auth", to: "ep-auth", source: "telemetry" },
];

const DESIGN_RECS: DesignRec[] = [
  { id: "rec-1", severity: "critical", title: "Redis connection pool leak detected", body: "payment-worker.ts:L42 opens a new Redis client per request without releasing. Add connection pooling with try/finally release.", nodeId: "svc-payment" },
  { id: "rec-2", severity: "warning", title: "Gateway timeout cascade risk", body: "api-gateway forwards requests to payment-service without circuit breaker. Add a circuit breaker with 3s timeout and 50% failure threshold.", nodeId: "svc-gateway" },
  { id: "rec-3", severity: "info", title: "Missing health check on redis-primary", body: "No liveness probe configured. Add a TCP check on port 6379 with 5s interval to enable auto-failover.", nodeId: "infra-redis" },
];

// ---- geometry --------------------------------------------------------------

function edgePath(fromNode: RadiusNode, toNode: RadiusNode): string {
  const a = nodePos(fromNode.col, fromNode.row);
  const b = nodePos(toNode.col, toNode.row);
  const ax = a.x + NODE_W;
  const ay = a.y + NODE_H / 2;
  const bx = b.x;
  const by = b.y + NODE_H / 2;

  if (fromNode.col === toNode.col) {
    // Same column — vertical S-path
    const sx = a.x + NODE_W / 2;
    const tx = b.x + NODE_W / 2;
    const sy = fromNode.row < toNode.row ? a.y + NODE_H + 8 : a.y - 8;
    const ty = fromNode.row < toNode.row ? b.y - 8 : b.y + NODE_H + 8;
    const midY = sy + (ty - sy) / 2;
    return `M ${sx} ${sy} L ${sx} ${midY} L ${tx} ${midY} L ${tx} ${ty}`;
  }

  // Cross-column — horizontal L-path
  const midX = ax + (bx - ax) / 2;
  return `M ${ax + 8} ${ay} L ${midX} ${ay} L ${midX} ${by} L ${bx - 8} ${by}`;
}

// ---- component -------------------------------------------------------------

export function TopologyGraphView() {
  const me = useMe();
  const projectId = me.data?.project?.id ?? "proj-1";
  const { data: pipelineData } = useTopology(projectId);
  const generateTopology = useGenerateTopology(projectId);
  const startInvestigation = useStartInvestigation(projectId);
  const navigate = useNavigate();
  const projectPath = useProjectPath();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [blastMode, setBlastMode] = useState(true);

  const selected = useMemo(() => NODES.find((n) => n.id === selectedId) ?? null, [selectedId]);
  const neighbors = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const s = new Set<string>();
    for (const e of EDGES) {
      if (e.from === selectedId) s.add(e.to);
      if (e.to === selectedId) s.add(e.from);
    }
    return s;
  }, [selectedId]);

  const blastCount = NODES.filter((n) => n.status === "down" || n.status === "degraded").length;
  const affectedUsers = NODES.reduce((s, n) => s + (n.affectedUsers ?? 0), 0);

  const canvasW = PAD_LEFT + COLUMNS.length * (COL_W + COL_GAP);
  const maxRow = Math.max(...NODES.map((n) => n.row));
  const canvasH = PAD_TOP + (maxRow + 1) * ROW_H + 40;

  return (
    <div className="flex flex-col gap-6 w-full">
      <PageHeader
        title="Topology Radius"
        description="Blast-radius flow mapping commits, services, datastores, and user sessions."
        actions={
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-muted">
              13:36 → 16:36 (Last 3h)
              <ShortcutKey>T</ShortcutKey>
            </div>
            <Btn variant="secondary" size="sm" loading={generateTopology.isPending} onClick={() => generateTopology.mutate()}>
              Rebuild pipeline
            </Btn>
            <Btn variant={blastMode ? "danger" : "secondary"} size="sm" onClick={() => setBlastMode((v) => !v)}>
              {blastMode ? "Stop blast wave" : "Simulate blast wave"}
            </Btn>
          </div>
        }
      />

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Tile padded>
          <Label>ORIGIN CAUSE</Label>
          <div className="mt-2 flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-danger">c0a4f91</span>
            <span className="text-xs text-subtle font-mono truncate">payment-worker.ts:L42</span>
          </div>
          <p className="mt-1 text-[12px] text-muted">Redis socket pool exhaustion</p>
        </Tile>
        <Tile padded>
          <Label>DEGRADED NODES</Label>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[32px] font-normal leading-none tracking-[0.02em] text-danger" style={PIXEL_NUMBER_STYLE}>{blastCount}</span>
            <span className="text-xs text-muted">of {NODES.length}</span>
          </div>
        </Tile>
        <Tile padded>
          <Label>IMPACTED SESSIONS</Label>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[32px] font-normal leading-none tracking-[0.02em] text-fg" style={PIXEL_NUMBER_STYLE}>{affectedUsers}</span>
            <span className="text-xs text-muted">users</span>
          </div>
        </Tile>
        <Tile padded>
          <Label>P99 LATENCY SPIKE</Label>
          <div className="mt-2">
            <span className="text-[32px] font-normal leading-none tracking-[0.02em] text-warning" style={PIXEL_NUMBER_STYLE}>+4.25s</span>
          </div>
          <p className="mt-1 text-[12px] text-muted">Peak on /checkout</p>
        </Tile>
      </div>

      {/* Main layout: Canvas (left) + Inspector (right, outside canvas) */}
      <div className="flex gap-6 w-full items-start">
        {/* Canvas */}
        <div className="flex-1 min-w-0">
          <div
            className="relative overflow-auto rounded-2xl border border-border"
            style={{
              backgroundImage: "radial-gradient(var(--dot-color) 1.25px, transparent 1.25px)",
              backgroundSize: "22px 22px",
              minHeight: Math.max(640, canvasH),
            }}
          >
            {/* Toolbar */}
            <div className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-surface/95 backdrop-blur-sm px-5 py-3">
              <div className="flex items-center gap-3">
                {(["telemetry", "infra", "suggested"] as EdgeProvenance[]).map((src) => {
                  const s = EDGE_STYLE[src];
                  return (
                    <span key={src} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
                      <svg width="22" height="6" viewBox="0 0 22 6">
                        <line x1="0" y1="3" x2="22" y2="3" stroke={s.stroke} strokeWidth={s.width + 0.4} strokeOpacity={Math.max(s.opacity, 0.7)} strokeDasharray={s.dash} />
                      </svg>
                      {src === "telemetry" ? "Observed" : src === "infra" ? "Inferred" : "AI suggested"}
                    </span>
                  );
                })}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-danger" /><span className="text-[11px] text-muted mr-3">Down</span>
                <span className="h-2 w-2 rounded-full bg-warning" /><span className="text-[11px] text-muted mr-3">Degraded</span>
                <span className="h-2 w-2 rounded-full bg-success" /><span className="text-[11px] text-muted">Healthy</span>
              </div>
            </div>

            <div style={{ width: canvasW * 0.8 + PAD_LEFT, height: canvasH * 0.8 + PAD_TOP }}>
              <div className="relative" style={{ width: canvasW, height: canvasH, transform: 'scale(0.8)', transformOrigin: 'top left' }}>
                {/* Column headers */}
              {COLUMNS.map((col, ci) => {
                const x = PAD_LEFT + ci * (COL_W + COL_GAP);
                return (
                  <div
                    key={col.layer}
                    className="absolute font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-subtle"
                    style={{ left: x, top: 20, width: NODE_W }}
                  >
                    {col.heading}
                  </div>
                );
              })}

              {/* Edges */}
              <svg className="pointer-events-none absolute inset-0" width={canvasW} height={canvasH}>
                <style>{`
                  @keyframes topology-flow { to { stroke-dashoffset: -20; } }
                  .animate-flow { animation: topology-flow 0.8s linear infinite; }
                `}</style>
                <defs>
                  <marker id="tr-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M0 0 L10 5 L0 10 z" fill="var(--color-subtle)" />
                  </marker>
                  <marker id="tr-arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                    <path d="M0 0 L10 5 L0 10 z" fill="var(--color-accent)" />
                  </marker>
                  <marker id="tr-arrow-blast" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                    <path d="M0 0 L10 5 L0 10 z" fill="var(--color-danger)" />
                  </marker>
                </defs>
                {EDGES.map((e) => {
                  const a = NODES.find((n) => n.id === e.from);
                  const b = NODES.find((n) => n.id === e.to);
                  if (!a || !b) return null;
                  const active = selectedId === e.from || selectedId === e.to;
                  const blast = blastMode && e.isBlast;
                  const style = EDGE_STYLE[e.source];
                  const pathStr = edgePath(a, b);
                  return (
                    <g key={e.id}>
                      <path
                        d={pathStr}
                        fill="none"
                        stroke={blast ? "var(--color-danger)" : active ? "var(--color-accent)" : style.stroke}
                        strokeWidth={blast ? style.width + 1 : active ? style.width + 0.6 : style.width}
                        strokeOpacity={active || blast ? 1 : selectedId ? 0.18 : style.opacity}
                        strokeDasharray={blast ? "6 4" : style.dash}
                        markerEnd={blast ? "url(#tr-arrow-blast)" : active ? "url(#tr-arrow-active)" : "url(#tr-arrow)"}
                        className={blast ? "animate-pulse" : ""}
                      />
                      {active && !blast && (
                        <path
                          d={pathStr}
                          fill="none"
                          stroke="var(--color-accent)"
                          strokeWidth={style.width + 0.8}
                          strokeDasharray="4 6"
                          className="animate-flow"
                        />
                      )}
                    </g>
                  );
                })}
              </svg>

              {/* Node cards */}
              {NODES.map((node) => {
                const pos = nodePos(node.col, node.row);
                const isSelected = selectedId === node.id;
                const dimmed = !!selectedId && !isSelected && !neighbors.has(node.id);
                const isBlast = blastMode && (node.status === "down" || node.status === "degraded");
                return (
                  <div
                    key={node.id}
                    onClick={() => setSelectedId((cur) => (cur === node.id ? null : node.id))}
                    className="absolute touch-none select-none rounded-2xl transition-[box-shadow,opacity] cursor-pointer hover:brightness-110"
                    style={{
                      left: pos.x,
                      top: pos.y,
                      width: NODE_W,
                      background: CARD_BG,
                      opacity: dimmed ? 0.35 : 1,
                      boxShadow: isSelected
                        ? "0 0 0 1px var(--color-accent), 0 0 0 4px var(--color-surface), 0 0 0 5px rgba(72,90,226,0.35), 0 16px 32px -16px rgba(72,90,226,0.5)"
                        : isBlast
                        ? "0 0 0 1px var(--color-danger), 0 0 0 4px var(--color-surface), 0 0 0 5px rgba(217,113,120,0.25), 0 10px 24px -16px rgba(0,0,0,0.8)"
                        : "0 0 0 1px var(--color-border-strong), 0 0 0 4px var(--color-surface), 0 0 0 5px rgba(255,255,255,0.04), 0 10px 24px -16px rgba(0,0,0,0.8)",
                    }}
                  >
                    <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5">
                      <span className="h-[18px] w-[18px] shrink-0 text-muted">{iconFor(node.kind)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[14.5px] font-semibold tracking-tight text-fg">{node.label}</span>
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[node.status] }} title={node.status} />
                        </div>
                        {node.sublabel && <div className="truncate text-[11.5px] text-subtle">{node.sublabel}</div>}
                      </div>
                    </div>
                    <div className="h-px bg-border" />
                    <div className="flex items-center justify-between px-4 py-2">
                      {node.metric ? (
                        <span className="text-[11.5px] text-subtle">{node.metric.label}</span>
                      ) : (
                        <span className="text-[11.5px] capitalize text-subtle">{node.kind}</span>
                      )}
                      {node.metric && (
                        <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-muted">
                          {node.metric.value}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            </div>
          </div>
        </div>

        {/* Inspector sidebar — OUTSIDE the canvas */}
        <div className="w-[360px] shrink-0 hidden lg:flex flex-col gap-4">
          <AnimatePresence mode="wait">
            {selected ? (
              <motion.div
                key={selected.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ type: "spring", stiffness: 520, damping: 38, mass: 0.6 }}
              >
                <div className="flex flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]">
                  {/* Header */}
                  <div className="flex items-center gap-2.5 px-5 py-4">
                    <span className="h-[18px] w-[18px] shrink-0 text-muted">{iconFor(selected.kind)}</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[15px] font-semibold tracking-tight text-fg">{selected.label}</span>
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[selected.status] }} />
                      </div>
                      <div className="text-[12px] text-subtle">
                        <span className="capitalize">{selected.kind}</span> · {selected.layer}
                      </div>
                    </div>
                    <button type="button" onClick={() => setSelectedId(null)} aria-label="Close" className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-lg text-subtle transition-colors hover:bg-surface-2 hover:text-fg">
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6 18 18M18 6 6 18" /></svg>
                    </button>
                  </div>
                  <div className="h-px bg-border" />

                  <div className="space-y-4 px-5 py-4 max-h-[480px] overflow-y-auto">
                    {selected.details && <InspectorRow label="Analysis"><span className="text-[12.5px] text-fg leading-snug">{selected.details}</span></InspectorRow>}
                    {selected.codeFile && <InspectorRow label="Source"><span className="font-mono text-[12.5px] text-accent">{selected.codeFile}</span></InspectorRow>}
                    {selected.commitSha && <InspectorRow label="Commit"><span className="font-mono text-[12.5px] text-fg">{selected.commitSha}</span></InspectorRow>}
                    {selected.author && <InspectorRow label="Author"><span className="text-[12.5px] text-fg">{selected.author}</span></InspectorRow>}
                    <LiveTelemetryPanel projectId={projectId} serviceLabel={selected.label} fallbackLog={selected.logLine} fallbackTrace={selected.traceSpan} />
                    {selected.resource && (
                      <div>
                        <div className="mb-2 text-[12px] font-medium text-muted">Resources</div>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5">
                            <div className="text-[10.5px] text-subtle">CPU</div>
                            <div className="font-mono text-[13px] font-medium text-fg" style={PIXEL_NUMBER_STYLE}>{selected.resource.cpu}</div>
                          </div>
                          <div className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5">
                            <div className="text-[10.5px] text-subtle">Memory</div>
                            <div className="font-mono text-[13px] font-medium text-fg" style={PIXEL_NUMBER_STYLE}>{selected.resource.mem}</div>
                          </div>
                        </div>
                      </div>
                    )}
                    <InspectorEdges title="Depends on" edges={EDGES.filter((e) => e.from === selected.id)} nodes={NODES} dir="out" />
                    <InspectorEdges title="Used by" edges={EDGES.filter((e) => e.to === selected.id)} nodes={NODES} dir="in" />
                  </div>

                  <div className="h-px bg-border" />
                  <div className="flex gap-2 px-5 py-4">
                    <Btn size="sm" variant="primary" loading={startInvestigation.isPending} onClick={() => startInvestigation.mutate({ prompt: `Investigate degraded service: ${selected.label}`, service: selected.label }, { onSuccess: (res) => navigate(projectPath(`/incidents/${res.incident.id}`)) })}>Investigate with AI</Btn>
                    <Btn size="sm" variant="ghost">Rollback commit</Btn>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="empty-state"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="rounded-2xl border border-border bg-surface p-5"
              >
                <div className="text-center py-8">
                  <div className="text-[13px] font-medium text-muted">Select a node</div>
                  <div className="text-[11.5px] text-subtle mt-1">Click any card on the graph to inspect its telemetry</div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Design Recommendations */}
          <div className="rounded-2xl border border-border bg-surface">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
              <div className="flex items-center gap-1.5">
                <svg className="h-4 w-4 text-accent" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 4.8L18 8l-4.4 1.2L12 14l-1.6-4.8L6 8l4.4-1.2L12 2z" /></svg>
                <span className="text-[13px] font-semibold text-fg">Design Recommendations</span>
              </div>
              <Chip tone="accent">{DESIGN_RECS.length}</Chip>
            </div>
            <div className="divide-y divide-border">
              {DESIGN_RECS.map((rec) => (
                <button
                  key={rec.id}
                  type="button"
                  onClick={() => rec.nodeId && setSelectedId(rec.nodeId)}
                  className="flex w-full gap-3 px-5 py-3.5 text-left transition-colors hover:bg-surface-2/70"
                >
                  <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${rec.severity === "critical" ? "bg-danger" : rec.severity === "warning" ? "bg-warning" : "bg-accent"}`} />
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-fg">{rec.title}</div>
                    <div className="mt-0.5 text-[11.5px] leading-snug text-muted line-clamp-2">{rec.body}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- inspector helpers -----------------------------------------------------

function InspectorRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-[13px] text-muted">{label}</span>
      <span className="h-px flex-1 self-center border-t border-dashed border-border-strong" />
      <span className="shrink-0">{children}</span>
    </div>
  );
}
// ---- inspector helpers -----------------------------------------------------

function InspectorEdges({ title, edges, nodes, dir }: { title: string; edges: RadiusEdge[]; nodes: RadiusNode[]; dir: "in" | "out" }) {
  if (edges.length === 0) return null;
  const LABEL: Record<EdgeProvenance, string> = { telemetry: "observed", infra: "inferred", suggested: "AI" };
  const labelFor = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div>
      <div className="mb-2 text-[12px] font-medium text-muted">{title}</div>
      <div className="space-y-1.5">
        {edges.map((e) => (
          <div key={e.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5">
            <span className="truncate text-[12.5px] text-fg">{labelFor(dir === "out" ? e.to : e.from)}</span>
            {e.label && <span className="shrink-0 text-[11px] text-subtle">{e.label}</span>}
            <span className="ml-auto shrink-0 rounded-full bg-surface-3 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide text-subtle">{LABEL[e.source]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LiveTelemetryPanel({ projectId, serviceLabel, fallbackLog, fallbackTrace }: { projectId: string; serviceLabel: string; fallbackLog?: { severity: "ERROR" | "WARN" | "INFO"; text: string }; fallbackTrace?: { name: string; durationMs: number }; }) {
  const filter = useMemo(() => ({ range: { since: "now-3h", until: "now" }, service: serviceLabel }), [serviceLabel]);
  const { data: logsData } = useExploreLogs(projectId, filter, 1);
  const { data: tracesData } = useExploreTraces(projectId, filter, 1);

  const log = logsData?.[0];
  const trace = tracesData?.[0];

  return (
    <>
      {(log || fallbackLog) && (
        <div>
          <div className="mb-2 text-[12px] font-medium text-muted">Latest log {log ? "(Live)" : ""}</div>
          <div className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px] text-fg leading-snug break-words">
            <span className="font-bold" style={{ color: log ? (log.severity === "ERROR" ? "var(--color-danger)" : log.severity === "WARN" || log.severity === "WARNING" ? "var(--color-warning)" : "var(--color-success)") : (fallbackLog?.severity === "ERROR" ? "var(--color-danger)" : fallbackLog?.severity === "WARN" ? "var(--color-warning)" : "var(--color-success)") }}>[{log ? log.severity : fallbackLog?.severity}]</span>{" "}
            {log ? log.body : fallbackLog?.text}
          </div>
        </div>
      )}
      {(trace || fallbackTrace) && (
        <div>
          <div className="mb-2 text-[12px] font-medium text-muted">Trace span {trace ? "(Live)" : ""}</div>
          <div className="flex items-center justify-between rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px]">
            <span className="text-fg truncate max-w-[200px]">{trace ? trace.span_name : fallbackTrace?.name}</span>
            <span className="shrink-0 text-warning font-medium">{trace ? trace.duration_ms : fallbackTrace?.durationMs} ms</span>
          </div>
        </div>
      )}
    </>
  );
}
