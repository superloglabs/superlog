"use client";

import { useEffect } from "react";
import type { AreaVariant } from "./chart-context";
import { usePolarPart } from "./polar-context";

export type PieProps = {
  /** Fill texture applied to every slice. */
  variant?: AreaVariant;
};

/**
 * The pie/donut ring. Slices come from the chart `data` (one per row); this part
 * sets the shared fill variant. The dithered wedges are painted on the canvas.
 */
export function Pie({ variant = "gradient" }: PieProps) {
  const ctx = usePolarPart("Pie", "pie");
  const { registerVariant, unregisterVariant } = ctx;

  useEffect(() => {
    registerVariant("*", variant);
    return () => unregisterVariant("*");
  }, [variant, registerVariant, unregisterVariant]);

  return null;
}
