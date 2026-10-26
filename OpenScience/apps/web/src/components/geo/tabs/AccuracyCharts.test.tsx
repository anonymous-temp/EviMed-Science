import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ErrorCharts } from "./AccuracyCharts";

it("charts count the complete server aggregate even when the current error page has no rows", () => {
  render(<ErrorCharts errors={[]} summary={{ unit: "error_rows", total: 100, byEngine: { deepseek: 40, doubao: 60 }, bySeverity: { S3: 40, unknown: 60 },
    byEngineSeverity: { "deepseek:S3": 40, "doubao:unknown": 60 }, byType: { number: 90, unknown: 10 }, byTrace: { traced: 50, unattributable: 30, noRetrieval: 20 }, byStatus: { open: 100 } }}
    composition={[]} compositionTitle="回答构成" denominator={null} selection={{ engine: null, type: null, trace: null, onEngine: vi.fn(), onType: vi.fn(), onTrace: vi.fn() }} />);
  expect(screen.getByRole("button", { name: "豆包，讲错 60 条" })).toBeVisible();
  expect(screen.getByRole("button", { name: "DeepSeek，讲错 40 条" })).toBeVisible();
  expect(screen.getByText(/100 条讲错里，50 条能追到被引用的页面/)).toBeVisible();
  expect(screen.getByText("类型未知")).toBeVisible();
});
