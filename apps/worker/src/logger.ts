import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import pino, { multistream } from "pino";
import type { Writable } from "node:stream";

const SERVICE_NAME = "@superlog/worker";

const PINO_LEVEL_TO_OTEL: Record<number, { num: SeverityNumber; text: string }> = {
  10: { num: SeverityNumber.TRACE, text: "TRACE" },
  20: { num: SeverityNumber.DEBUG, text: "DEBUG" },
  30: { num: SeverityNumber.INFO, text: "INFO" },
  40: { num: SeverityNumber.WARN, text: "WARN" },
  50: { num: SeverityNumber.ERROR, text: "ERROR" },
  60: { num: SeverityNumber.FATAL, text: "FATAL" },
};

const DEFAULT_SEVERITY = { num: SeverityNumber.INFO, text: "INFO" } as const;

const otelStream: Writable = Object.assign(Object.create(null), {
  write(chunk: string): boolean {
    // biome-ignore lint/suspicious/noExplicitAny: pino emits JSON whose shape mirrors AnyValueMap.
    let rec: any;
    try {
      rec = JSON.parse(chunk);
    } catch {
      return true;
    }
    const level = typeof rec.level === "number" ? rec.level : 30;
    const sev = PINO_LEVEL_TO_OTEL[level] ?? DEFAULT_SEVERITY;
    const { level: _l, time, msg, pid: _p, hostname: _h, name: _n, ...attributes } = rec;
    logs.getLogger(SERVICE_NAME).emit({
      timestamp: typeof time === "number" ? time : Date.now(),
      severityNumber: sev.num,
      severityText: sev.text,
      body: typeof msg === "string" ? msg : JSON.stringify(msg ?? ""),
      attributes,
    });
    return true;
  },
}) as unknown as Writable;

export const logger = pino(
  { name: SERVICE_NAME },
  multistream([
    { stream: process.stdout },
    { stream: otelStream },
  ]),
);
