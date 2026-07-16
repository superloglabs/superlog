export function splitHomeWidgets<T extends { type: string }>(widgets: T[]): {
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
    return { bodyPadding: false, innerShell: false, defaultHeight: 3 };
  }
  return { bodyPadding: true, innerShell: true, defaultHeight: undefined };
}
