import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ErrorCharts } from "./AccuracyCharts";
import type { GeoErrorRow } from "@/lib/geoClient";

it("charts count the complete server aggregate even when the current error page has no rows", () => {
  render(<ErrorCharts errors={[]} summary={{ unit: "error_rows", total: 100, byEngine: { deepseek: 40, doubao: 60 }, bySeverity: { S4: 10, S3: 30, unknown: 60 },
    byEngineSeverity: { "deepseek:S4": 10, "deepseek:S3": 30, "doubao:unknown": 60 }, byType: { number: 90, unknown: 10 }, byTrace: { traced: 50, unattributable: 30, noRetrieval: 20 }, byStatus: { open: 100 } }}
    emptyAssessment={{ title: "尚未测量", text: "暂无结果" }} composition={[]} compositionTitle="回答构成" denominator={null} selection={{ engine: null, type: null, trace: null, onEngine: vi.fn(), onType: vi.fn(), onTrace: vi.fn() }} />);
  expect(screen.getByRole("button", { name: "豆包，讲错 60 条" })).toBeVisible();
  expect(screen.getByRole("button", { name: "DeepSeek，讲错 40 条" })).toBeVisible();
  expect(screen.getByText(/100 条讲错里，50 条能追到被引用的页面/)).toBeVisible();
  expect(screen.getByText("类型未知")).toBeVisible();
  expect(screen.getByText(/仅凭回答无法判断患者是否已用药或受伤/)).toBeVisible();
  expect(screen.getByText("S4 10 条 · S3 30 条")).toBeVisible();
  expect(screen.getByText("严重度未知 60 条")).toBeVisible();
  expect(screen.getByText("S4")).toBeInTheDocument();
  expect(screen.getByText("S0")).toBeInTheDocument();
});

it("counts unknown severity when only unaggregated error rows are available", () => {
  const error = { engine: "kimi", severity: null, errorType: "number", status: "open", citedSource: null } as unknown as GeoErrorRow;
  render(<ErrorCharts errors={[error]} emptyAssessment={{ title: "尚未测量", text: "暂无结果" }} composition={[]} compositionTitle="回答构成" denominator={null} selection={{ engine: null, type: null, trace: null, onEngine: vi.fn(), onType: vi.fn(), onTrace: vi.fn() }} />);
  expect(screen.getByRole("button", { name: "Kimi，讲错 1 条" })).toBeVisible();
  expect(screen.getByText("严重度未知 1 条")).toBeVisible();
});
