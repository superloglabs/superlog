// Tree-shaken ECharts core for our dashboard chart fork. Register only the
// modules this path uses and re-export the configured core instance.
import { BarChart, LineChart } from "echarts/charts";
import {
  AriaComponent,
  BrushComponent,
  GridComponent,
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
  ToolboxComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export { echarts };
