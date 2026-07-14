// Tree-shaken ECharts core for our dashboard chart fork. Register only the
// modules this path uses and re-export the configured core instance.
import { BarChart, LineChart } from "echarts/charts";
import {
  AriaComponent,
  BrushComponent,
  GridComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  LineChart,
  BarChart,
  AriaComponent,
  BrushComponent,
  GridComponent,
  // Required for `series.markLine` (the dashed threshold line on alert charts).
  // Without it the tree-shaken core silently drops markLine — no error, no line.
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export { echarts };
