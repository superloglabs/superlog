type ParsedAttributeValue = string | number | boolean;
type ParsedAttribute = { key: string; value: ParsedAttributeValue };

export type ParsedRailwayLogRecord = {
  body: string;
  severity: string | null;
  attributes: ParsedAttribute[];
};

const HTTP_ACCESS_RECORD =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) (\S+) HTTP\/(\d(?:\.\d)?)" (\d{3}) (\d+|-)(?: ([\d.]+|-))?$/;
const POSTGRESQL_RECORD =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? [A-Z]+) \[(\d+)\] (?:(\S+?)@(\S+) )?([A-Z][A-Z0-9]*):\s*(.*)$/s;
const MAX_PARSED_FIELDS = 32;
const MAX_PARSED_KEY_LENGTH = 128;
const MAX_PARSED_STRING_LENGTH = 4096;
const NATIVE_SEVERITY: Record<string, string> = {
  trace: "trace",
  debug: "debug",
  info: "info",
  information: "info",
  notice: "info",
  warn: "warn",
  warning: "warn",
  err: "error",
  error: "error",
  fatal: "fatal",
  critical: "fatal",
  alert: "fatal",
  emergency: "fatal",
};
const POSTGRESQL_SEVERITY: Record<string, string> = {
  DEBUG: "debug",
  DEBUG1: "debug",
  DEBUG2: "debug",
  DEBUG3: "debug",
  DEBUG4: "debug",
  DEBUG5: "debug",
  DETAIL: "info",
  HINT: "info",
  INFO: "info",
  LOG: "info",
  NOTICE: "info",
  STATEMENT: "info",
  WARNING: "warn",
  ERROR: "error",
  FATAL: "fatal",
  PANIC: "fatal",
};

export function parseRailwayLogRecord(
  message: string,
  providerSeverity: string | null,
): ParsedRailwayLogRecord {
  const json = parseJson(message, providerSeverity);
  if (json) return json;

  const httpAccess = parseHttpAccess(message, providerSeverity);
  if (httpAccess) return httpAccess;

  const postgresql = parsePostgresql(message, providerSeverity);
  if (postgresql) return postgresql;

  const fields = parseLogfmt(message);
  const body = fields?.msg ?? fields?.message;
  const nativeSeverity = fields?.level;
  if (!fields || !body) {
    return { body: message, severity: providerSeverity, attributes: [] };
  }
  const parsedSeverity = nativeSeverity ? normalizeNativeSeverity(nativeSeverity) : null;

  return {
    body,
    severity: parsedSeverity ?? providerSeverity,
    attributes: parsedAttributes(
      "logfmt",
      Object.entries(fields)
        .filter(([key, value]) => isBoundedField(key, value))
        .map(([key, value]) => ({
          key: `railway.log.${normalizeAttributeKey(key)}`,
          value,
        })),
      providerSeverity,
      parsedSeverity ? "logfmt" : "railway",
      message,
    ),
  };
}

export function parseRailwayAttributeValue(value: string): ParsedAttributeValue {
  try {
    const parsed: unknown = JSON.parse(value);
    return isScalar(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function parseHttpAccess(
  message: string,
  providerSeverity: string | null,
): ParsedRailwayLogRecord | null {
  const match = message.match(HTTP_ACCESS_RECORD);
  if (!match) return null;
  const [
    ,
    peerAddress,
    timestamp,
    method,
    target,
    protocolVersion,
    statusText,
    sizeText,
    durationText,
  ] = match;
  if (!peerAddress || !timestamp || !method || !target || !protocolVersion || !statusText) {
    return null;
  }

  const status = Number(statusText);
  const [path, query] = target.split("?", 2);
  if (!path || !Number.isInteger(status)) return null;
  const responseSize = sizeText && sizeText !== "-" ? Number(sizeText) : null;
  const durationSeconds = durationText && durationText !== "-" ? Number(durationText) : null;

  return {
    body: `${method} ${path} ${status}`,
    severity: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
    attributes: parsedAttributes(
      "http_access",
      [
        { key: "network.peer.address", value: peerAddress },
        { key: "railway.log.timestamp", value: timestamp },
        { key: "http.request.method", value: method },
        { key: "url.path", value: path },
        ...(query ? [{ key: "url.query", value: query }] : []),
        { key: "network.protocol.name", value: "http" },
        { key: "network.protocol.version", value: protocolVersion },
        { key: "http.response.status_code", value: status },
        ...(responseSize !== null && Number.isFinite(responseSize)
          ? [{ key: "http.response.body.size", value: responseSize }]
          : []),
        ...(durationSeconds !== null && Number.isFinite(durationSeconds)
          ? [{ key: "railway.log.duration_seconds", value: durationSeconds }]
          : []),
      ],
      providerSeverity,
      "http_status",
      message,
    ),
  };
}

function parseJson(
  message: string,
  providerSeverity: string | null,
): ParsedRailwayLogRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const body =
    typeof record.message === "string"
      ? record.message
      : typeof record.msg === "string"
        ? record.msg
        : null;
  if (!body) return null;
  const nativeSeverity =
    typeof record.level === "string"
      ? record.level
      : typeof record.severity === "string"
        ? record.severity
        : null;
  const parsedSeverity =
    typeof nativeSeverity === "string" ? normalizeNativeSeverity(nativeSeverity) : null;

  const parsedFields = Object.entries(record)
    .filter(
      (entry): entry is [string, ParsedAttributeValue] =>
        isScalar(entry[1]) && isBoundedField(entry[0], entry[1]),
    )
    .slice(0, MAX_PARSED_FIELDS)
    .map(([key, fieldValue]) => ({
      key: `railway.log.${normalizeAttributeKey(key)}`,
      value: fieldValue,
    }));
  return {
    body,
    severity: parsedSeverity ?? providerSeverity,
    attributes: parsedAttributes(
      "json",
      parsedFields,
      providerSeverity,
      parsedSeverity ? "json" : "railway",
      message,
    ),
  };
}

function parsePostgresql(
  message: string,
  providerSeverity: string | null,
): ParsedRailwayLogRecord | null {
  const match = message.match(POSTGRESQL_RECORD);
  if (!match) return null;
  const [, timestamp, pid, user, database, level, body] = match;
  if (!timestamp || !pid || !level || body === undefined) return null;
  const severity = POSTGRESQL_SEVERITY[level];
  if (!severity) return null;
  return {
    body,
    severity,
    attributes: parsedAttributes(
      "postgresql",
      [
        { key: "railway.log.timestamp", value: timestamp },
        { key: "railway.log.pid", value: pid },
        ...(user ? [{ key: "railway.log.user", value: user }] : []),
        ...(database ? [{ key: "railway.log.database", value: database }] : []),
        { key: "railway.log.level", value: level },
      ],
      providerSeverity,
      "postgresql",
      message,
    ),
  };
}

function parsedAttributes(
  format: string,
  fields: ParsedAttribute[],
  providerSeverity: string | null,
  severitySource: string,
  original: string,
): ParsedAttribute[] {
  return [
    { key: "railway.log.format", value: format },
    ...fields,
    ...(providerSeverity
      ? [{ key: "railway.log.provider_severity", value: providerSeverity }]
      : []),
    { key: "railway.log.severity_source", value: severitySource },
    { key: "log.record.original", value: original },
  ];
}

function parseLogfmt(message: string): Record<string, string> | null {
  const fields: Record<string, string> = {};
  let cursor = 0;
  let count = 0;

  while (cursor < message.length) {
    while (cursor < message.length && isWhitespace(message[cursor])) cursor += 1;
    if (cursor === message.length) break;

    const keyStart = cursor;
    if (!isLogfmtKeyStart(message[cursor])) return null;
    cursor += 1;
    while (cursor < message.length && isLogfmtKeyPart(message[cursor])) cursor += 1;
    const key = message.slice(keyStart, cursor);
    if (message[cursor] !== "=") return null;
    cursor += 1;

    let value = "";
    if (message[cursor] === '"') {
      cursor += 1;
      let closed = false;
      while (cursor < message.length) {
        const character = message[cursor];
        if (character === '"') {
          cursor += 1;
          closed = true;
          break;
        }
        if (character === "\\" && cursor + 1 < message.length) {
          const escaped = message[cursor + 1];
          if (escaped === '"' || escaped === "\\") {
            value += escaped;
            cursor += 2;
            continue;
          }
        }
        value += character;
        cursor += 1;
      }
      if (!closed || (cursor < message.length && !isWhitespace(message[cursor]))) return null;
    } else {
      const valueStart = cursor;
      while (cursor < message.length && !isWhitespace(message[cursor])) cursor += 1;
      if (valueStart === cursor) return null;
      value = message.slice(valueStart, cursor);
    }

    fields[key] = value;
    count += 1;
    if (count > MAX_PARSED_FIELDS) return null;
  }

  if (count < 2) return null;
  return fields;
}

function isWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function isLogfmtKeyStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_]/.test(character);
}

function isLogfmtKeyPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_.-]/.test(character);
}

function normalizeAttributeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
}

function isScalar(value: unknown): value is ParsedAttributeValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function normalizeNativeSeverity(value: string): string | null {
  return NATIVE_SEVERITY[value.trim().toLowerCase()] ?? null;
}

function isBoundedField(key: string, value: ParsedAttributeValue): boolean {
  return (
    key.length <= MAX_PARSED_KEY_LENGTH &&
    (typeof value !== "string" || value.length <= MAX_PARSED_STRING_LENGTH)
  );
}
