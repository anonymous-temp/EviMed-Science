import { CustomChart, GraphChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { LabelLayout } from "echarts/features";
import { echarts } from "../echartsBase";

/**
 * The series and components the memory overview draws with, registered once, and only when the overview's chunk is loaded: the page is a
 * lazy route, so a researcher who never opens it never downloads the graph, scatter and custom series (`echartsBase.ts` rule 1): the relation
 * graph, the change chart's dots (scatter) and its weekly cells (custom). The word cloud registers itself in `../WordCloud.tsx`.
 *
 * `LabelLayout` is the feature behind a series' `labelLayout` option: with the modular build, an option naming it does nothing at
 * all until it is registered. The relation graph asked for `hideOverlap` from the first day and was never given it, so every label
 * of a dense hub was drawn over the next one (the owner's screenshot of 2026-10-14).
 */
echarts.use([GraphChart, CustomChart, ScatterChart, GridComponent, TooltipComponent, LabelLayout]);
