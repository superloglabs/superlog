import {
  BatchLogRecordProcessor,
  type BatchLogRecordProcessorOptions,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";

export function createBatchLogRecordProcessor(
  exporter: LogRecordExporter,
  options: Omit<BatchLogRecordProcessorOptions, "exporter"> = {},
): BatchLogRecordProcessor {
  return new BatchLogRecordProcessor({ ...options, exporter });
}
