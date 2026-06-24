// ---------------------------------------------------------------------------
// Hand-authored "as-if-from-the-LLM" enrichment of the real snapshot.
//
// The model's job: identify a handful of logical *services by intent* (not infra
// tiers), assign every resource to one, clean names, and infer the links
// telemetry didn't capture. This is the TARGET output the production Anthropic
// pass must produce. Each group here becomes a top-level service node that
// explodes into its member resources on click (see services.ts). Every entry is
// a reviewable suggestion — applyEnrichment flags them for accept/reject.
// ---------------------------------------------------------------------------

import type { TopologyEnrichment } from "@superlog/topology";

export const sampleEnrichment: TopologyEnrichment = {
  summary:
    "Identified 3 services by intent — Web app, API & backend, Telemetry pipeline — and inferred the datastore links the API & workers don't emit spans for.",
  groups: [
    {
      id: "web",
      label: "Web app",
      tone: "accent",
      intent: "Customer-facing dashboard, delivered via CDN",
    },
    {
      id: "backend",
      label: "API & backend",
      tone: "neutral",
      intent: "Serves the API, runs investigations, owns the app database",
    },
    {
      id: "telemetry",
      label: "Telemetry pipeline",
      tone: "warning",
      intent: "Ingests, processes & stores observability data",
    },
  ],
  nodePatches: [
    // Web app
    { id: "web", label: "Web frontend", group: "web" },
    // API & backend
    { id: "alb", label: "Load balancer", group: "backend" },
    { id: "ecs:api", label: "API", group: "backend" },
    { id: "ecs:admin-api", label: "Admin API", group: "backend" },
    { id: "ecs:worker", label: "Investigation worker", group: "backend" },
    { id: "rds:postgres", label: "Postgres", group: "backend" },
    // Telemetry pipeline
    { id: "ecs:proxy", label: "Ingest proxy", group: "telemetry" },
    { id: "sqs:ingest", label: "Ingest queue", group: "telemetry" },
    { id: "ecs:ingest-consumer", label: "Ingest consumer", group: "telemetry" },
    { id: "ecs:collector", label: "OTel collector", group: "telemetry" },
    { id: "clickhouse", label: "ClickHouse", group: "telemetry" },
  ],
  // Links the deterministic graph is missing (no client-span instrumentation),
  // but which obviously exist — the model proposes them for review.
  suggestedEdges: [
    { from: "ecs:api", to: "rds:postgres", kind: "reads", label: "inferred" },
    { from: "ecs:api", to: "clickhouse", kind: "reads", label: "inferred" },
    { from: "ecs:worker", to: "clickhouse", kind: "reads", label: "inferred" },
    { from: "ecs:admin-api", to: "rds:postgres", kind: "reads", label: "inferred" },
  ],
};
