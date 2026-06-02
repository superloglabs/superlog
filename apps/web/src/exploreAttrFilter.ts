import type { ResourceAttr } from "./api.ts";

// Resource / log / span attributes live in separate ClickHouse maps, so an
// explore filter key carries its scope as a prefix. The backend's
// parseAttributeKey (apps/api/src/mcp/clickhouse.ts) routes `resource.`,
// `log.` and `span.` keys to ResourceAttributes / LogAttributes /
// SpanAttributes respectively, and the attribute-key picker emits the same
// prefixes. The synthetic `field.` scope routes to a top-level identifier
// column (trace_id / span_id / severity_number) via the backend's
// fieldColumnExpr allowlist rather than an attribute map. Filter affordances
// must emit the prefix matching the row's origin.
export type AttrScope = "resource" | "log" | "span" | "field";

export function attrFilterKey(scope: AttrScope, key: string): string {
  return `${scope}.${key}`;
}

// Append a key=value equality filter, skipping an exact duplicate so clicking
// the same attribute twice is a no-op. A duplicate is the same key+value with
// an equality op (the inline buttons only ever add eq); a `neq`/`not_contains`
// on the same pair is a different filter and is left intact. Returns the same
// array reference when nothing changes so callers can avoid a redundant
// state/URL update.
export function addAttrFilter(attrs: ResourceAttr[], key: string, value: string): ResourceAttr[] {
  const alreadyPresent = attrs.some(
    (a) => a.key === key && a.value === value && (a.op ?? "eq") === "eq",
  );
  if (alreadyPresent) return attrs;
  return [...attrs, { key, value }];
}
