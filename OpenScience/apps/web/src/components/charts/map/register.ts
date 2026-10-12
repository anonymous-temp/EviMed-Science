import { CustomChart, GraphChart, HeatmapChart, RadarChart, ScatterChart, TreeChart } from "echarts/charts";
import { CalendarComponent, DataZoomComponent, GridComponent, RadarComponent, TooltipComponent } from "echarts/components";
import { echarts } from "../echartsBase";

/**
 * The series and components the memory map draws with, registered once, and only when the map's chunk is loaded: the page is a
 * lazy route, so a researcher who never opens it never downloads the graph, radar, calendar, tree and custom series
 * (`echartsBase.ts` rule 1). The word cloud registers itself in `../WordCloud.tsx`.
 */
echarts.use([
  GraphChart, TreeChart, RadarChart, HeatmapChart, CustomChart, ScatterChart,
  CalendarComponent, DataZoomComponent, GridComponent, RadarComponent, TooltipComponent,
]);
