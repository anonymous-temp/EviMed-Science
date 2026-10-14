import { CustomChart, GraphChart, HeatmapChart, RadarChart, ScatterChart, TreeChart } from "echarts/charts";
import { CalendarComponent, DataZoomComponent, GridComponent, RadarComponent, TooltipComponent } from "echarts/components";
import { LabelLayout } from "echarts/features";
import { echarts } from "../echartsBase";

/**
 * The series and components the memory map draws with, registered once, and only when the map's chunk is loaded: the page is a
 * lazy route, so a researcher who never opens it never downloads the graph, radar, calendar, tree and custom series
 * (`echartsBase.ts` rule 1). The word cloud registers itself in `../WordCloud.tsx`.
 *
 * `LabelLayout` is the feature behind a series' `labelLayout` option: with the modular build, an option naming it does nothing at
 * all until it is registered. The relation graph asked for `hideOverlap` from the first day and was never given it, so every label
 * of a dense hub was drawn over the next one (the owner's screenshot of 2026-10-14).
 */
echarts.use([
  GraphChart, TreeChart, RadarChart, HeatmapChart, CustomChart, ScatterChart,
  CalendarComponent, DataZoomComponent, GridComponent, RadarComponent, TooltipComponent, LabelLayout,
]);
