export type SavedViewSource = "logs" | "traces";

export type SavedExploreViewState = {
  source: SavedViewSource;
  range:
    | { type: "relative"; seconds: number; label: string }
    | { type: "absolute"; since: string; until: string };
  attrs: { key: string; value: string }[];
  severity?: string;
  statusCode?: string;
  groupBy?: string;
  tracesView?: "traces" | "spans";
};

export function captureSavedViewState(input: {
  source: SavedViewSource;
  selection: { seconds: number; label: string };
  absoluteRange: { since: string; until: string } | null;
  attrs: { key: string; value: string }[];
  severity: string;
  statusCode: string;
  groupBy: string;
  tracesView: "traces" | "spans";
}): SavedExploreViewState {
  const state: SavedExploreViewState = {
    source: input.source,
    range: input.absoluteRange
      ? { type: "absolute", since: input.absoluteRange.since, until: input.absoluteRange.until }
      : { type: "relative", seconds: input.selection.seconds, label: input.selection.label },
    attrs: input.attrs.map(({ key, value }) => ({ key, value })),
  };

  if (input.groupBy) state.groupBy = input.groupBy;
  if (input.source === "logs" && input.severity) state.severity = input.severity;
  if (input.source === "traces") {
    if (input.statusCode) state.statusCode = input.statusCode;
    if (input.tracesView === "spans") state.tracesView = "spans";
  }

  return state;
}

export function buildSavedViewSearchParams(
  state: SavedExploreViewState,
  savedViewId?: string,
): URLSearchParams {
  const params = new URLSearchParams();
  if (savedViewId) params.set("savedView", savedViewId);
  if (state.range.type === "relative") {
    params.set("range", String(state.range.seconds));
    params.set("rangeLabel", state.range.label);
  }
  for (const attr of state.attrs) params.append("attr", `${attr.key}=${attr.value}`);
  if (state.severity) params.set("sev", state.severity);
  if (state.statusCode) params.set("status", state.statusCode);
  if (state.groupBy) params.set("group", state.groupBy);
  if (state.tracesView === "spans") params.set("view", "spans");
  if (state.range.type === "absolute") {
    params.set("since", state.range.since);
    params.set("until", state.range.until);
  }
  return params;
}

function canonicalize(state: SavedExploreViewState) {
  return {
    source: state.source,
    range:
      state.range.type === "relative"
        ? {
            type: "relative" as const,
            seconds: state.range.seconds,
            label: state.range.label,
          }
        : {
            type: "absolute" as const,
            since: state.range.since,
            until: state.range.until,
          },
    attrs: [...state.attrs]
      .map(({ key, value }) => ({ key, value }))
      .sort((a, b) => `${a.key}\u0000${a.value}`.localeCompare(`${b.key}\u0000${b.value}`)),
    severity: state.severity || undefined,
    statusCode: state.statusCode || undefined,
    groupBy: state.groupBy || undefined,
    tracesView: state.tracesView === "spans" ? "spans" : undefined,
  };
}

export function savedViewStateEquals(
  left: SavedExploreViewState,
  right: SavedExploreViewState,
): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}
