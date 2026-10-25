import {render,screen,fireEvent} from "@testing-library/react";
import {expect,it,vi} from "vitest";
import {GeoHistoryVisual} from "./GeoHistoryVisual";
import type {GeoAnalysisChartCell,GeoAnalysisRow} from "@/lib/geoAnalysisClient";

it("plots actual business times independently of observed samples and leaves unknowns unpositioned",()=>{
 const timeline={total:3,dated:2,undated:1,events:[{id:"e1",rowKey:"events",columnKey:"events",at:"2026-10-01T00:00:00Z",label:"内容版本"},{id:"e2",rowKey:"events",columnKey:"events",at:"2026-10-03T00:00:00Z",label:"用户登记的发布版本"}]};
 const trend=[{roundId:"r1",rowKey:"r1",columnKey:"reading",at:"2026-10-02T00:00:00Z",metricId:"M-01",value:20,status:"ok",reason:null,numerator:1,denominator:5},{roundId:"r2",rowKey:"r2",columnKey:"reading",at:"2026-10-04T00:00:00Z",metricId:"M-01",value:null,status:"insufficient",reason:"insufficient_sample",numerator:0,denominator:2}];
 const {container}=render(<GeoHistoryVisual rows={[]} columns={[{key:"reading",label:"品牌提及率"}]} cells={[]} timeline={timeline} trend={trend} onSelect={()=>{}}/>);
 const circles=container.querySelectorAll("svg[aria-label='实际业务事件与采样读数时间轴'] circle");
 expect(circles).toHaveLength(3);
 expect(Number(circles[1].getAttribute("cx"))).toBeLessThan(Number(circles[0].getAttribute("cx")));
 expect(Number(circles[0].getAttribute("cx"))).toBeLessThan(Number(circles[2].getAttribute("cx")));
 expect(screen.getByText(/1 条时间未知记录保留/)).toBeVisible();
 // The count is a figure of its own inside a Note (a number that stands for something), so the sentence is read whole.
 expect(screen.getByText(/条读数或时间未知/).closest("[data-note]")).toHaveTextContent("1 条读数或时间未知");
 expect(screen.getByText(/先后关系不表示因果/)).toBeVisible();
});

it("opens the exact history membership without treating a completed task as clinical closure",()=>{
 const members={selectionRef:"selected",rowKey:"error",columnKey:"tasks",expectedDigest:"exact",view:{viewId:"V15"},unit:"business_events",total:1,exact:true};
 const cell={rowKey:"error",columnKey:"tasks",label:"Recorded issue",value:1,state:"known",members} as unknown as GeoAnalysisChartCell;
 const rows=[{key:"error",label:"Recorded issue",metricId:null,dimensions:{kind:"error_history"},values:{tasks:{value:1,state:"known",unit:"business_events",metric:null,members}}}] as unknown as GeoAnalysisRow[];
 const select=vi.fn();
 render(<GeoHistoryVisual errorHistory rows={rows} columns={[{key:"tasks",label:"已提交处理任务"}]} cells={[cell]} timeline={{total:0,dated:0,undated:0,events:[]}} onSelect={select}/>);
 fireEvent.click(screen.getByRole("button",{name:"Recorded issue · 已提交处理任务 · 1"}));expect(select).toHaveBeenCalledWith(cell);
 expect(screen.getByText(/任务完成、判定撤回和后续采样/)).toBeVisible();
});

it("labels a multi-day reading as an interval aggregate at its last observation after an intervening event",()=>{
 const trend=[{roundId:"r",rowKey:"r",columnKey:"reading",at:"2026-10-04T00:00:00Z",observedFrom:"2026-10-03T00:00:00Z",observedTo:"2026-10-04T00:00:00Z",unknownTimes:0,metricId:"M-01",value:50,status:"ok",reason:null,numerator:25,denominator:50}];
 const timeline={total:1,dated:1,undated:0,events:[{id:"published",rowKey:"e",columnKey:"events",at:"2026-10-03T12:00:00Z",label:"登记发布"}]};
 const {container}=render(<GeoHistoryVisual rows={[]} columns={[{key:"reading",label:"品牌提及率"}]} cells={[]} timeline={timeline} trend={trend} onSelect={()=>{}}/>);
 const points=container.querySelectorAll("circle");expect(Number(points[0].getAttribute("cx"))).toBeGreaterThan(Number(points[1].getAttribute("cx")));
 expect(points[0].querySelector("title")?.textContent).toContain("2026-10-03T00:00:00Z 至 2026-10-04T00:00:00Z");
 expect(container.querySelector("line[stroke-dasharray] title")?.textContent).toBe("所选样本观察区间，非连续读数");
 expect(screen.getByText(/每轮读数汇总所选样本区间，标在最后一次观察/)).toBeVisible();
});

it("keeps a known reading and its exact member action visible when all plotting times are unknown",()=>{
 const members={selectionRef:"selected",rowKey:"r",columnKey:"reading",expectedDigest:"exact",view:{viewId:"V27"},unit:"answers",total:50,exact:true};
 const cell={rowKey:"r",columnKey:"reading",label:"采样第 1 轮",value:50,state:"known",members} as unknown as GeoAnalysisChartCell;
 const rows=[{key:"r",label:"采样第 1 轮",metricId:"M-01",dimensions:{kind:"history_reading"},values:{reading:{value:50,state:"known",unit:"percent",metric:null,members}}}] as unknown as GeoAnalysisRow[];
 const trend=[{roundId:"r",rowKey:"r",columnKey:"reading",at:null,unknownTimes:1,metricId:"M-01",value:50,status:"ok",reason:null,numerator:25,denominator:50}];
 const select=vi.fn();const {container}=render(<GeoHistoryVisual rows={rows} columns={[{key:"reading",label:"品牌提及率"}]} cells={[cell]} timeline={{total:0,dated:0,undated:0,events:[]}} trend={trend} onSelect={select}/>);
 fireEvent.click(screen.getByRole("button",{name:"采样第 1 轮 · 品牌提及率 · 50"}));expect(select).toHaveBeenCalledWith(cell);
 expect(screen.getByRole("status")).toHaveTextContent("已知读数和精确样本仍可查看");expect(container.querySelector("svg")).toBeNull();
});
