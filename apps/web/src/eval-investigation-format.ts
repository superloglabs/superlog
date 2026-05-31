export type RubricLine = {
  label: string;
  value: string | string[];
};

export type RubricSection = {
  title: string;
  lines: RubricLine[];
};

export type TelemetrySpanSummary = {
  services: Array<{ name: string; count: number }>;
  spanNames: Array<{ name: string; count: number }>;
  statuses: Array<{ name: string; count: number }>;
  routes: Array<{ route: string; count: number }>;
  exceptions: Array<{ type: string; message: string; stackTop: string | null; count: number }>;
  notableRows: TelemetryDisplayRow[];
};

export type TelemetryDisplayRow = {
  timestamp: string;
  service: string;
  spanName: string;
  status: string;
  route: string;
  httpStatus: string;
  durationMs: string;
  error: string | null;
};

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scalarDisplayValue(value: unknown): string | null {
  const string = stringValue(value);
  if (string) return string;
  const number = numberValue(value);
  return number === null ? null : String(number);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function conceptGroups(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((group) =>
      Array.isArray(group) ? group.filter((v) => typeof v === "string").join(" / ") : null,
    )
    .filter((v): v is string => Boolean(v));
}

function pushLine(lines: RubricLine[], label: string, value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    lines.push({ label, value });
    return;
  }
  if (Array.isArray(value) && value.length > 0) {
    const strings = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    if (strings.length > 0) lines.push({ label, value: strings });
  }
}

export function describeRubric(rubric: unknown): RubricSection[] {
  const root = asRecord(rubric);
  if (!root) return [];

  const sections: RubricSection[] = [];
  const review = asRecord(root.review);
  if (review) {
    const reviewLines: RubricLine[] = [];
    for (const [key, label] of [
      ["title", "Title"],
      ["summary", "Summary"],
      ["root_cause", "Root cause"],
      ["patch", "Patch"],
    ] as const) {
      const item = asRecord(review[key]);
      if (!item) continue;
      pushLine(reviewLines, `${label}: golden`, item.golden);
      pushLine(reviewLines, `${label}: good`, item.good);
      pushLine(reviewLines, `${label}: avoid`, item.avoid);
    }
    if (reviewLines.length > 0) sections.push({ title: "Review expectations", lines: reviewLines });
  }

  const passing = asRecord(root.passing);
  if (passing) {
    const lines = Object.entries(passing)
      .map(([label, value]) => ({ label, value: numberValue(value)?.toString() ?? "" }))
      .filter((line) => line.value);
    if (lines.length > 0) sections.push({ title: "Passing thresholds", lines });
  }

  const title = asRecord(root.title);
  if (title) {
    const lines: RubricLine[] = [];
    pushLine(lines, "Expected", title.expected);
    pushLine(lines, "Required concepts", conceptGroups(title.required_concepts));
    pushLine(lines, "Forbidden concepts", stringArray(title.forbidden_concepts));
    if (lines.length > 0) sections.push({ title: "Title grading", lines });
  }

  const summary = asRecord(root.summary);
  if (summary) {
    const lines: RubricLine[] = [];
    pushLine(lines, "Expected", summary.expected);
    pushLine(lines, "Required concepts", conceptGroups(summary.required_concepts));
    pushLine(lines, "Forbidden concepts", stringArray(summary.forbidden_concepts));
    if (lines.length > 0) sections.push({ title: "Summary grading", lines });
  }

  const rootCause = asRecord(root.root_cause);
  if (rootCause) {
    const lines: RubricLine[] = [];
    pushLine(lines, "Causal mechanism", rootCause.causal_mechanism);
    pushLine(lines, "Required concepts", conceptGroups(rootCause.required_concepts));
    pushLine(lines, "Required evidence", stringArray(rootCause.required_evidence));
    pushLine(lines, "Accepted phrasing", stringArray(rootCause.acceptable_alt_phrasings));
    if (lines.length > 0) sections.push({ title: "Root cause grading", lines });
  }

  const fix = asRecord(root.fix);
  if (fix) {
    const lines: RubricLine[] = [];
    pushLine(lines, "Acceptable directions", stringArray(fix.acceptable_directions));
    pushLine(lines, "Unacceptable directions", stringArray(fix.unacceptable_directions));
    if (lines.length > 0) sections.push({ title: "Fix grading", lines });
  }

  const prTitle = asRecord(root.pr_title);
  if (prTitle) {
    const lines: RubricLine[] = [];
    pushLine(lines, "Expected", prTitle.expected);
    pushLine(lines, "Required concepts", conceptGroups(prTitle.required_concepts));
    pushLine(lines, "Forbidden concepts", stringArray(prTitle.forbidden_concepts));
    if (lines.length > 0) sections.push({ title: "PR title grading", lines });
  }

  const prBody = asRecord(root.pr_body);
  if (prBody) {
    const lines: RubricLine[] = [];
    pushLine(lines, "Expected", prBody.expected);
    pushLine(lines, "Required concepts", conceptGroups(prBody.required_concepts));
    pushLine(lines, "Forbidden concepts", stringArray(prBody.forbidden_concepts));
    if (lines.length > 0) sections.push({ title: "PR body grading", lines });
  }

  return sections;
}

function increment(map: Map<string, number>, key: string | null): void {
  const normalized = key?.trim() || "unknown";
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function topCounts(
  map: Map<string, number>,
  limit: number,
): Array<{ name: string; count: number }> {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function topRouteCounts(
  map: Map<string, number>,
  limit: number,
): Array<{ route: string; count: number }> {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([route, count]) => ({ route, count }));
}

function firstEventAttribute(row: RecordValue, key: string): string | null {
  const attrs = row["Events.Attributes"];
  if (!Array.isArray(attrs)) return null;
  for (const attr of attrs) {
    const record = asRecord(attr);
    const value = record ? stringValue(record[key]) : null;
    if (value) return value;
  }
  return null;
}

function firstStackLine(stack: string | null): string | null {
  return (
    stack
      ?.split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? null
  );
}

function spanAttributes(row: RecordValue): RecordValue {
  return asRecord(row.SpanAttributes) ?? {};
}

export function telemetryDisplayRow(row: unknown): TelemetryDisplayRow | null {
  const record = asRecord(row);
  if (!record) return null;
  const attrs = spanAttributes(record);
  const duration = numberValue(record.Duration);
  const route =
    stringValue(attrs["http.route"]) ??
    stringValue(attrs["http.url"]) ??
    stringValue(attrs["http.target"]) ??
    "—";
  const status = stringValue(record.StatusCode) ?? "Unset";
  const eventMessage = firstEventAttribute(record, "exception.message");
  const eventType = firstEventAttribute(record, "exception.type");
  const statusMessage = stringValue(record.StatusMessage);
  return {
    timestamp: stringValue(record.Timestamp) ?? "—",
    service: stringValue(record.ServiceName) ?? "unknown",
    spanName: stringValue(record.SpanName) ?? "unknown",
    status,
    route,
    httpStatus:
      scalarDisplayValue(attrs["http.response.status_code"]) ??
      scalarDisplayValue(attrs["http.status_code"]) ??
      "—",
    durationMs: duration === null ? "—" : (duration / 1_000_000).toFixed(1),
    error: eventMessage ?? statusMessage ?? eventType,
  };
}

export function summarizeTelemetryRows(rows: unknown[]): TelemetrySpanSummary {
  const services = new Map<string, number>();
  const spanNames = new Map<string, number>();
  const statuses = new Map<string, number>();
  const routes = new Map<string, number>();
  const exceptionCounts = new Map<
    string,
    { type: string; message: string; stackTop: string | null; count: number }
  >();
  const notableRows: TelemetryDisplayRow[] = [];

  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const display = telemetryDisplayRow(record);
    if (!display) continue;
    const attrs = spanAttributes(record);
    increment(services, display.service);
    increment(spanNames, display.spanName);
    increment(statuses, display.status);
    increment(
      routes,
      stringValue(attrs["http.route"]) ??
        stringValue(attrs["http.url"]) ??
        stringValue(attrs["http.target"]),
    );

    const exceptionMessage = firstEventAttribute(record, "exception.message");
    const exceptionType = firstEventAttribute(record, "exception.type") ?? "Error";
    const stackTop = firstStackLine(firstEventAttribute(record, "exception.stacktrace"));
    if (exceptionMessage || display.status === "Error" || display.httpStatus.startsWith("4")) {
      if (notableRows.length < 12) notableRows.push(display);
    }
    if (exceptionMessage) {
      const key = `${exceptionType}\n${exceptionMessage}\n${stackTop ?? ""}`;
      const existing = exceptionCounts.get(key);
      if (existing) existing.count += 1;
      else {
        exceptionCounts.set(key, {
          type: exceptionType,
          message: exceptionMessage,
          stackTop,
          count: 1,
        });
      }
    }
  }

  return {
    services: topCounts(services, 8),
    spanNames: topCounts(spanNames, 10),
    statuses: topCounts(statuses, 8),
    routes: topRouteCounts(routes, 10),
    exceptions: Array.from(exceptionCounts.values()).sort((a, b) => b.count - a.count),
    notableRows,
  };
}
