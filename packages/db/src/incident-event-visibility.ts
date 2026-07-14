// Receipt/checkpoint rows share incident_events' durable uniqueness and
// transaction boundaries, but they are infrastructure state rather than
// incident history. Readers use this prefix to keep them out of timelines,
// follow-up context, and outbound webhook payloads.
export const INTERNAL_INCIDENT_EVENT_KIND_PREFIX = "internal_";

// `_` is a single-character wildcard in SQL LIKE patterns, so escape it when
// filtering the prefix at query time. PostgreSQL treats `\\` as LIKE's default
// escape character for parameterized patterns.
export const INTERNAL_INCIDENT_EVENT_KIND_SQL_PATTERN = "internal\\_%";

export function isVisibleIncidentEventKind(kind: string): boolean {
  return !kind.startsWith(INTERNAL_INCIDENT_EVENT_KIND_PREFIX);
}
