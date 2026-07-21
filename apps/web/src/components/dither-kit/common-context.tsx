"use client";

import { createContext, use } from "react";
import type { Seed } from "./palette";

/** A single tooltip row — one series (cartesian/radar) or one slice (pie). */
export type TooltipItem = {
  name: string;
  label: string;
  value: number;
  seed: Seed;
  dimmed: boolean;
};

/**
 * The minimal surface shared by every chart family, so `<Legend>` and
 * `<Tooltip>` work identically whether they sit in a cartesian, bar, or polar
 * root. Each root publishes one of these alongside its family-specific context.
 */
export type CommonChart = {
  names: string[]; // legend entries — series keys (cartesian) or slice names (pie)
  labelOf: (name: string) => string;
  seedOf: (name: string) => Seed;
  selectedDataKey: string | null;
  selectDataKey: (key: string | null) => void;
  /** Transient legend-hover emphasis — spotlights one series (others dim)
   * while the pointer rests on its legend entry. Selection still wins. */
  focusDataKey: string | null;
  setFocusDataKey: (key: string | null) => void;
  hoverIndex: number | null;
  heading: (index: number, labelKey?: string) => string | null;
  itemsAt: (index: number) => TooltipItem[];
  ready: boolean;
  tooltipLeft: number; // clamped px for the floating tooltip
  tooltipTop: number; // px — follows the hovered node (cartesian) / cursor (polar)
};

export const CommonChartContext = createContext<CommonChart | null>(null);

export function useCommonChart() {
  const ctx = use(CommonChartContext);
  if (!ctx) {
    throw new Error("<Legend /> / <Tooltip /> must be used within a chart root.");
  }
  return ctx;
}
