// Render Log Stream (syslog sink) → OTLP. Render's log streams push RFC 5424
// syslog over TLS to a host:port destination (custom HTTPS destinations don't
// exist — HTTPS is limited to a couple of first-class providers). In prod a
// TLS-terminating NLB fronts this plaintext TCP server.
//
// Tenant attribution: syslog has no auth header, but the destination's Token
// field is OUR ingest key (the connector registers it), so we scan each frame
// for the prefix-tagged key wherever Render embeds it (structured data, MSG
// prefix — provider conventions vary and Render's exact placement is
// undocumented). Once a connection has authenticated one frame, later frames
// without a token inherit the connection's project. Frames that never
// authenticate are dropped and counted.

import net from "node:net";

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_BUFFER_BYTES = 1024 * 1024;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// A key that failed auth once won't start working — cache verdicts briefly so
// a misconfigured high-volume stream can't hammer the db.
const AUTH_CACHE_TTL_MS = 60 * 1000;

// Bounded length: real ingest keys are ~55 chars, and the bound keeps an
// attacker from forcing frame-sized strings into the auth cache.
const INGEST_KEY_PATTERN = /(?:sl_public_|superlog_live_)[A-Za-z0-9_-]{16,90}/;

// RFC 5424 header: <PRI>VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP
// The STRUCTURED-DATA section is scanned linearly (scanStructuredData) rather
// than matched here — a nested-quantifier regex over attacker-controlled TCP
// input is an exponential-backtracking hazard.
const RFC5424_HEADER_PATTERN = /^<(\d{1,3})>1 (\S+) (\S+) (\S+) (\S+) (\S+) /;

export type RenderSyslogRecord = {
  severityNumber: number;
  severityText: string;
  timeUnixNano: string;
  hostname: string | null;
  appName: string | null;
  procId: string | null;
  msgId: string | null;
  structuredData: Record<string, Record<string, string>>;
  message: string;
};

// --- RFC 6587 framing ---------------------------------------------------------
// Render (like most syslog-over-TLS senders) uses octet counting ("123 <...>");
// non-transparent newline framing is accepted too since the spec allows it.
export class SyslogFrameSplitter {
  private buffer: Buffer = Buffer.alloc(0);

  /** Returns complete frames; throws on oversize frames or unparseable framing. */
  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      throw new Error("syslog connection buffer overflow");
    }
    const frames: string[] = [];
    while (this.buffer.length > 0) {
      const first = this.buffer[0];
      if (first !== undefined && first >= 0x31 && first <= 0x39) {
        // Octet counting: "LEN SP FRAME"
        const spaceIdx = this.buffer.indexOf(0x20);
        if (spaceIdx === -1) {
          if (this.buffer.length > 10) throw new Error("invalid syslog octet-count header");
          break;
        }
        const len = Number(this.buffer.subarray(0, spaceIdx).toString("ascii"));
        if (!Number.isInteger(len) || len <= 0 || len > MAX_FRAME_BYTES) {
          throw new Error("invalid syslog frame length");
        }
        if (this.buffer.length < spaceIdx + 1 + len) break;
        frames.push(this.buffer.subarray(spaceIdx + 1, spaceIdx + 1 + len).toString("utf8"));
        this.buffer = this.buffer.subarray(spaceIdx + 1 + len);
      } else {
        // Non-transparent framing: LF-terminated
        const nl = this.buffer.indexOf(0x0a);
        if (nl === -1) {
          if (this.buffer.length > MAX_FRAME_BYTES) throw new Error("syslog frame too long");
          break;
        }
        const line = this.buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "");
        this.buffer = this.buffer.subarray(nl + 1);
        if (line.trim()) frames.push(line);
      }
    }
    return frames;
  }
}

// --- Parsing --------------------------------------------------------------------

export function extractIngestKey(frame: string): string | null {
  const match = frame.match(INGEST_KEY_PATTERN);
  return match ? match[0] : null;
}

const SYSLOG_SEVERITY: Array<{ text: string; number: number }> = [
  { text: "FATAL", number: 21 }, // 0 emerg
  { text: "FATAL", number: 21 }, // 1 alert
  { text: "FATAL", number: 21 }, // 2 crit
  { text: "ERROR", number: 17 }, // 3 err
  { text: "WARN", number: 13 }, // 4 warning
  { text: "INFO", number: 10 }, // 5 notice
  { text: "INFO", number: 9 }, // 6 info
  { text: "DEBUG", number: 5 }, // 7 debug
];

export function parseRfc5424(frame: string): RenderSyslogRecord | null {
  const header = frame.match(RFC5424_HEADER_PATTERN);
  if (!header) return null;
  const [, priRaw, timestamp, hostname, appName, procId, msgId] = header;
  if (timestamp === undefined) return null;
  const pri = Number(priRaw);
  if (!Number.isInteger(pri) || pri < 0 || pri > 191) return null;

  const rest = frame.slice(header[0].length);
  let structuredData: Record<string, Record<string, string>> = {};
  let msg: string;
  if (rest === "-") {
    msg = "";
  } else if (rest.startsWith("- ")) {
    msg = rest.slice(2);
  } else {
    const sd = parseSdSection(rest);
    if (!sd) return null;
    structuredData = sd.data;
    const after = rest.slice(sd.end);
    if (after === "") msg = "";
    else if (after.startsWith(" ")) msg = after.slice(1);
    else return null;
  }

  const severity = SYSLOG_SEVERITY[pri & 7] ?? { text: "", number: 0 };
  return {
    severityNumber: severity.number,
    severityText: severity.text,
    timeUnixNano: timestampToNanos(timestamp),
    hostname: nilFree(hostname),
    appName: nilFree(appName),
    procId: nilFree(procId),
    msgId: nilFree(msgId),
    structuredData,
    // A leading BOM marks UTF-8 MSG per the RFC; strip it either way.
    message: msg.replace(/^﻿/, ""),
  };
}

function nilFree(value: string | undefined): string | null {
  return value && value !== "-" ? value : null;
}

/**
 * Single linear pass over the STRUCTURED-DATA section — one or more
 * `[SD-ID param="value" ...]` elements. Hand-rolled instead of a regex: the
 * input is attacker-controlled TCP bytes, and the natural nested-quantifier
 * regex for this grammar backtracks exponentially. Returns the parsed
 * elements plus the index just past the section, or null if it's malformed.
 */
function parseSdSection(
  raw: string,
): { data: Record<string, Record<string, string>>; end: number } | null {
  if (raw[0] !== "[") return null;
  const data: Record<string, Record<string, string>> = {};
  let i = 0;
  while (raw[i] === "[") {
    i++;
    let idEnd = i;
    while (idEnd < raw.length && raw[idEnd] !== " " && raw[idEnd] !== "]") idEnd++;
    const id = raw.slice(i, idEnd);
    i = idEnd;
    const params: Record<string, string> = {};
    while (raw[i] === " ") {
      while (raw[i] === " ") i++;
      if (raw[i] === "]" || i >= raw.length) break;
      let nameEnd = i;
      while (
        nameEnd < raw.length &&
        raw[nameEnd] !== "=" &&
        raw[nameEnd] !== " " &&
        raw[nameEnd] !== "]"
      ) {
        nameEnd++;
      }
      if (raw[nameEnd] !== "=" || raw[nameEnd + 1] !== '"') {
        i = nameEnd;
        continue;
      }
      const name = raw.slice(i, nameEnd);
      i = nameEnd + 2;
      let value = "";
      while (i < raw.length && raw[i] !== '"') {
        const ch = raw[i];
        const next = raw[i + 1];
        // RFC 5424 escapes \" \\ \] inside PARAM-VALUE.
        if (ch === "\\" && (next === '"' || next === "\\" || next === "]")) {
          value += next;
          i += 2;
        } else {
          value += ch;
          i++;
        }
      }
      if (raw[i] !== '"') return null;
      i++;
      if (name) params[name] = value;
    }
    if (raw[i] !== "]") return null;
    i++;
    if (id) data[id] = params;
  }
  return { data, end: i };
}

// RFC 5424 TIMESTAMP is RFC 3339 with up to 6 fractional digits.
function timestampToNanos(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "0";
  const base = BigInt(ms) * 1_000_000n - BigInt(ms % 1000) * 1_000_000n;
  const fraction = value.match(/\.(\d{1,9})/);
  if (fraction?.[1]) return `${base + BigInt(fraction[1].padEnd(9, "0").slice(0, 9))}`;
  return `${BigInt(ms) * 1_000_000n}`;
}

// --- OTLP transform ---------------------------------------------------------------

type OtlpKeyValue = { key: string; value: { stringValue: string } };

// Every string that leaves for storage goes through scrubKey — the sender can
// place the token in ANY frame position (that's how attribution works), so
// attribute names, service names, and header fields are as leak-prone as
// message bodies.
function kv(key: string, value: string | null): OtlpKeyValue | null {
  return value ? { key: scrubKey(key), value: { stringValue: scrubKey(value) } } : null;
}

/** Group records by app-name (the Render service slug) into OTLP JSON. The
 * ingest key is stripped wherever it appears — it must never be stored. */
export function renderSyslogToOtlp(records: RenderSyslogRecord[]): unknown {
  const byService = new Map<string, RenderSyslogRecord[]>();
  for (const record of records) {
    const service = scrubKey(record.appName ?? "render");
    const group = byService.get(service);
    if (group) group.push(record);
    else byService.set(service, [record]);
  }
  return {
    resourceLogs: [...byService.entries()].map(([service, group]) => ({
      resource: {
        attributes: [
          kv("service.name", service),
          kv("telemetry.source", "render"),
        ].filter(Boolean),
      },
      scopeLogs: [
        {
          scope: { name: "render.syslog" },
          logRecords: group.map((record) => ({
            timeUnixNano: record.timeUnixNano,
            observedTimeUnixNano: record.timeUnixNano,
            severityText: record.severityText,
            severityNumber: record.severityNumber,
            body: { stringValue: scrubKey(record.message) },
            attributes: [
              kv("render.host", record.hostname),
              kv("render.procid", record.procId),
              kv("render.msgid", record.msgId),
              ...Object.entries(record.structuredData).flatMap(([id, params]) =>
                Object.entries(params).map(([name, value]) =>
                  kv(`render.sd.${id}.${name}`, scrubKey(value)),
                ),
              ),
            ].filter(Boolean),
          })),
        },
      ],
    })),
  };
}

function scrubKey(value: string): string {
  return value.replace(new RegExp(INGEST_KEY_PATTERN, "g"), "[redacted]");
}

// --- Server -------------------------------------------------------------------------

export type RenderSyslogServerDeps = {
  /** Resolve an ingest key to its project id (null = invalid/revoked). */
  authenticate: (key: string) => Promise<string | null>;
  /** Ship a batch of parsed records for one project into the ingest pipeline. */
  deliver: (projectId: string, records: RenderSyslogRecord[]) => Promise<void>;
  log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
};

export function createRenderSyslogServer(deps: RenderSyslogServerDeps): net.Server {
  const authCache = new Map<string, { projectId: string | null; expiresAt: number }>();

  async function resolveKey(key: string): Promise<string | null> {
    const cached = authCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.projectId;
    const projectId = await deps.authenticate(key);
    authCache.set(key, { projectId, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    // The cache is keyed by attacker-supplied strings; keep it bounded.
    if (authCache.size > 10_000) {
      const oldest = authCache.keys().next().value;
      if (oldest !== undefined) authCache.delete(oldest);
    }
    return projectId;
  }

  return net.createServer((socket) => {
    const splitter = new SyslogFrameSplitter();
    let connectionProjectId: string | null = null;
    let droppedUnattributed = 0;
    let processing = Promise.resolve();

    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());

    socket.on("data", (chunk: Buffer) => {
      let frames: string[];
      try {
        frames = splitter.push(chunk);
      } catch (err) {
        deps.log.warn(
          { err: err instanceof Error ? err.message : String(err), remote: socket.remoteAddress },
          "render syslog: destroying connection (framing violation)",
        );
        socket.destroy();
        return;
      }
      if (!frames.length) return;

      // Serialize batches per connection and apply backpressure: stop reading
      // while a batch is being authenticated/delivered.
      socket.pause();
      processing = processing
        .then(async () => {
          const byProject = new Map<string, RenderSyslogRecord[]>();
          for (const frame of frames) {
            const key = extractIngestKey(frame);
            let projectId = connectionProjectId;
            if (key) {
              projectId = await resolveKey(key);
              if (projectId) connectionProjectId = projectId;
            }
            if (!projectId) {
              droppedUnattributed++;
              continue;
            }
            const record = parseRfc5424(frame);
            if (!record) {
              deps.log.warn(
                // Scrub before slicing so a truncation can't split the key
                // into an unrecognizable (and unscrubbed) fragment.
                { remote: socket.remoteAddress, frame: scrubKey(frame).slice(0, 200) },
                "render syslog: unparseable frame dropped",
              );
              continue;
            }
            const group = byProject.get(projectId);
            if (group) group.push(record);
            else byProject.set(projectId, [record]);
          }
          for (const [projectId, records] of byProject) {
            await deps.deliver(projectId, records);
          }
        })
        .catch((err: unknown) => {
          deps.log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "render syslog: batch delivery failed; dropping batch",
          );
        })
        .finally(() => {
          if (!socket.destroyed) socket.resume();
        });
    });

    socket.on("close", () => {
      if (droppedUnattributed > 0) {
        deps.log.warn(
          { remote: socket.remoteAddress, dropped: droppedUnattributed },
          "render syslog: connection closed with unattributed frames dropped",
        );
      }
    });
    socket.on("error", () => socket.destroy());
  });
}
