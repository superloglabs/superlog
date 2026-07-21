// @ts-nocheck -- upstream Dither Kit source is not noUncheckedIndexedAccess-safe.
import { type ReactNode, useEffect } from "react";
import {
  type AreaVariant,
  type SeriesKind,
  type StrokeVariant,
  useChartPart,
} from "./chart-context";
import { SeriesContext } from "./series-context";

export type SeriesProps = {
  dataKey: string;
  variant?: AreaVariant;
  strokeVariant?: StrokeVariant;
  isClickable?: boolean;
  children?: ReactNode;
};

/**
 * Shared implementation for the continuous series (`<Area>`, `<Line>`). The
 * dithered fill/line is painted on the canvas; this registers the series so the
 * canvas knows how to draw it, wires click-to-select via a transparent band
 * polygon, and exposes the series to child `<Dot>`/`<ActiveDot>` markers.
 */
function CartesianSeries({
  part,
  kind,
  dataKey,
  variant = "gradient",
  strokeVariant = "solid",
  isClickable = false,
  children,
}: SeriesProps & { part: string; kind: SeriesKind }) {
  const ctx = useChartPart(part, kind === "line" ? "line" : "area");
  const { registerSeries, unregisterSeries } = ctx;

  if (process.env.NODE_ENV !== "production" && !ctx.config[dataKey]) {
    console.warn(
      `<${part} dataKey="${dataKey}" />: "${dataKey}" is not in the chart \`config\`. Add it so the series has a colour and label.`,
    );
  }

  useEffect(() => {
    registerSeries({ dataKey, kind, variant, strokeVariant });
    return () => unregisterSeries(dataKey);
  }, [dataKey, kind, variant, strokeVariant, registerSeries, unregisterSeries]);

  const band = ctx.bands[dataKey];
  if (!ctx.ready || !band) return null;

  const seed = ctx.seedOf(dataKey);
  const emphasis = ctx.selectedDataKey ?? ctx.focusDataKey;
  const dimmed = emphasis !== null && emphasis !== dataKey;
  const onClick = isClickable
    ? () => ctx.selectDataKey(ctx.selectedDataKey === dataKey ? null : dataKey)
    : undefined;

  // Transparent hit polygon tracing the series' own band, so clicking a series
  // selects *that* series. The Legend offers the same toggle accessibly.
  // One pass out along the top edge, one pass back along the floor.
  let hitPath: string | null = null;
  if (isClickable) {
    const parts: string[] = [];
    for (const [i, b] of band.entries()) {
      parts.push(`${i === 0 ? "M" : "L"}${ctx.xCenter(i)},${ctx.y(b[1])}`);
    }
    for (let i = band.length - 1; i >= 0; i -= 1) {
      parts.push(`L${ctx.xCenter(i)},${ctx.y(band[i][0])}`);
    }
    hitPath = `${parts.join(" ")} Z`;
  }

  return (
    <>
      {hitPath && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the accessible Legend exposes the same selection action
        <path d={hitPath} fill="transparent" style={{ cursor: "pointer" }} onClick={onClick} />
      )}
      <SeriesContext value={{ dataKey, seed, dimmed }}>{children}</SeriesContext>
    </>
  );
}

export type AreaProps = SeriesProps;

/** One area series — dithered fill from the value line down to its floor. */
export function Area(props: AreaProps) {
  return <CartesianSeries part="Area" kind="area" {...props} />;
}

/** One line series — bright line with a thin dither glow hugging it. */
export function Line(props: AreaProps) {
  return <CartesianSeries part="Line" kind="line" {...props} />;
}
