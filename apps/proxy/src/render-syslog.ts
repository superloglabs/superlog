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

const INGEST_KEY_PATTERN = /(?:sl_public_|superlog_live_)[A-Za-z0-9_-]+/;

// RFC 5424: <PRI>VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP STRUCTURED-DATA [SP MSG]
const RFC5424_PATTERN =
  /^<(\d{1,3})>1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|(?:\[.*?\])+)(?: (.*))?$/s;

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
  const match = frame.match(RFC5424_PATTERN);
  if (!match) return null;
  const [, priRaw, timestamp, hostname, appName, procId, msgId, sdRaw, msg] = match;
  if (timestamp === undefined) return null;
  const pri = Number(priRaw);
  if (!Number.isInteger(pri) || pri < 0 || pri > 191) return null;
  const severity = SYSLOG_SEVERITY[pri & 7] ?? { text: "", number: 0 };
  return {
    severityNumber: severity.number,
    severityText: severity.text,
    timeUnixNano: timestampToNanos(timestamp),
    hostname: nilFree(hostname),
    appName: nilFree(appName),
    procId: nilFree(procId),
    msgId: nilFree(msgId),
    structuredData: sdRaw && sdRaw !== "-" ? parseStructuredData(sdRaw) : {},
    // A leading BOM marks UTF-8 MSG per the RFC; strip it either way.
    message: (msg ?? "").replace(/^﻿/, ""),
  };
}

function nilFree(value: string | undefined): string | null {
  return value && value !== "-" ? value : null;
}

function parseStructuredData(raw: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const elementPattern = /\[([^\s\]=]+)((?:\s+[^\s=\]]+="(?:[^"\\]|\\.)*")*)\s*\]/g;
  for (const element of raw.matchAll(elementPattern)) {
    const [, id, paramsRaw] = element;
    if (!id) continue;
    const params: Record<string, string> = {};
    const paramPattern = /([^\s=\]]+)="((?:[^"\\]|\\.)*)"/g;
    for (const param of (paramsRaw ?? "").matchAll(paramPattern)) {
      const [, name, value] = param;
      if (!name || value === undefined) continue;
      params[name] = value.replace(/\\([\\"\]])/g, "$1");
    }
    out[id] = params;
  }
  return out;
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

function kv(key: string, value: string | null): OtlpKeyValue | null {
  return value ? { key, value: { stringValue: value } } : null;
}

/** Group records by app-name (the Render service slug) into OTLP JSON. The
 * ingest key is stripped wherever it appears — it must never be stored. */
export function renderSyslogToOtlp(records: RenderSyslogRecord[]): unknown {
  const byService = new Map<string, RenderSyslogRecord[]>();
  for (const record of records) {
    const service = record.appName ?? "render";
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
                { remote: socket.remoteAddress, frame: frame.slice(0, 200) },
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
