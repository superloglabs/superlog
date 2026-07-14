import type { IngestFilterState } from "../api.ts";

export type IngestSource = keyof IngestFilterState;
export type IngestSignal = "traces" | "logs" | "metrics";

export function isIngestSignalEnabled(
  state: IngestFilterState,
  source: IngestSource,
  signal: IngestSignal,
): boolean {
  const sourceState = state[source] as Partial<Record<IngestSignal, boolean>>;
  return sourceState[signal] ?? true;
}

export function updateIngestSignal(
  state: IngestFilterState,
  source: IngestSource,
  signal: IngestSignal,
  enabled: boolean,
): IngestFilterState {
  return {
    ...state,
    [source]: {
      ...state[source],
      [signal]: enabled,
    },
  };
}
