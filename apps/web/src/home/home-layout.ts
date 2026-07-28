export function splitHomeWidgets<T extends { type: string }>(
  widgets: T[],
): {
  setup: T | undefined;
  grid: T[];
} {
  return {
    setup: widgets.find((widget) => widget.type === "setup_todos"),
    grid: widgets.filter((widget) => widget.type !== "setup_todos"),
  };
}

export function homeWidgetPresentation(type: string): {
  bodyPadding: boolean;
  innerShell: boolean;
  defaultHeight: number | undefined;
} {
  if (type === "active_incidents") {
    return { bodyPadding: false, innerShell: false, defaultHeight: 5 };
  }
  if (
    type === "incoming_signals" ||
    type === "incident_count" ||
    type === "agent_pull_requests"
  ) {
    return { bodyPadding: false, innerShell: false, defaultHeight: 3 };
  }
  return { bodyPadding: true, innerShell: true, defaultHeight: undefined };
}

export function homeWidgetMinWidth(type: string): number {
  if (type === "link") return 3;
  if (type === "incoming_signals" || type === "incident_count" || type === "agent_pull_requests") {
    return 4;
  }
  if (type === "setup_todos" || type === "active_incidents" || type === "service_map") return 6;
  return 3;
}

// Minimum grid-row height per widget. The incident list packs ~84px per row plus
// a 44px header, so a 3-row default (~200px) clipped the second incident. Floor
// active_incidents at 5 rows (~344px) so at least three incidents show before the
// body scrolls; other widgets keep the generic 3-row minimum (links 2).
export function homeWidgetMinHeight(type: string): number {
  if (type === "link") return 2;
  if (type === "active_incidents") return 5;
  return 3;
}
