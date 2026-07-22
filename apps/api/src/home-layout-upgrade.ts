export const HOME_PULSE_ROW_TYPES = [
  "incoming_signals",
  "incident_count",
  "agent_pull_requests",
] as const;

export const CURRENT_HOME_LAYOUT_VERSION = 1;

export type HomePulseRowType = (typeof HOME_PULSE_ROW_TYPES)[number];

type WidgetLayout = { x: number; y: number; w: number; h: number };

type HomeWidget = {
  id: string;
  type: string;
  layout: WidgetLayout;
};

const HOME_PULSE_ROW_LAYOUTS: Record<HomePulseRowType, WidgetLayout> = {
  incoming_signals: { x: 0, y: 0, w: 4, h: 5 },
  incident_count: { x: 4, y: 0, w: 4, h: 5 },
  agent_pull_requests: { x: 8, y: 0, w: 4, h: 5 },
};

export function homePulseRowLayout(type: HomePulseRowType): WidgetLayout {
  return HOME_PULSE_ROW_LAYOUTS[type];
}

export function planHomePulseRowUpgrade(widgets: HomeWidget[]): {
  missingTypes: HomePulseRowType[];
  layoutUpdates: Array<{ id: string; layout: WidgetLayout }>;
} {
  const existingTypes = new Set(widgets.map((widget) => widget.type));
  return {
    missingTypes: HOME_PULSE_ROW_TYPES.filter((type) => !existingTypes.has(type)),
    layoutUpdates: widgets.flatMap((widget) => {
      if (HOME_PULSE_ROW_TYPES.includes(widget.type as HomePulseRowType)) {
        return [
          {
            id: widget.id,
            layout: homePulseRowLayout(widget.type as HomePulseRowType),
          },
        ];
      }
      if (widget.type === "setup_todos") return [];
      return [
        {
          id: widget.id,
          layout: { ...widget.layout, y: Math.min(100_000, widget.layout.y + 5) },
        },
      ];
    }),
  };
}
