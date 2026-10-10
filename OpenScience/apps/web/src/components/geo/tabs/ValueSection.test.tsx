import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import type { GeoValue } from "@/lib/geoClient";
import { geoProject } from "../__fixtures__/geoTabs";
import { ValueSection } from "./ValueSection";

const client = vi.hoisted(() => ({ getGeoValue: vi.fn() }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()), ...client,
}));

const empty = (): GeoValue => ({ version: 0, updatedAt: null, data: {}, research: [], impacts: [], observations: [],
  coverage: { assessed: 0, represented: 0, partial: 0, contradicted: 0, uncertain: 0, notApplicable: 0, value: null } });
beforeEach(() => client.getGeoValue.mockReset());
function show(mode: "profile" | "coverage" | "actions" = "profile") {
  return render(<MemoryRouter><ValueSection geoId="geo_1" project={geoProject()} mode={mode} /></MemoryRouter>);
}

it("keeps a sparse finding useful and puts known applicability behind disclosure without a form", async () => {
  client.getGeoValue.mockResolvedValue({ ...empty(), version: 3, data: { findings: [null, "费用尚不能判断", {
    statement: "照护者的给药负担值得关注", population: "需要照护协助的成人",
    sources: [{ label: "给药负担研究", url: "https://example.org/study" }],
  }, { statement: "已经被替代的结论", status: "superseded" }] } });
  const view = show();
  expect(await screen.findByText("费用尚不能判断")).toBeInTheDocument();
  expect(screen.getByText("照护者的给药负担值得关注")).toBeInTheDocument();
  expect(screen.queryByText("已经被替代的结论")).not.toBeInTheDocument();
  expect(view.container.querySelector("input, textarea, select")).toBeNull();
  const disclosure = screen.getByText("依据与适用条件").closest("details");
  expect(disclosure).not.toHaveAttribute("open");
  await userEvent.click(screen.getByText("依据与适用条件"));
  expect(disclosure).toHaveAttribute("open");
  expect(screen.getByRole("link", { name: "给药负担研究" })).toHaveAttribute("href", "https://example.org/study");
});

it("shows unjudged and inapplicable answers as unknown instead of zero performance", async () => {
  const value = empty();
  value.coverage.uncertain = 2;
  value.coverage.notApplicable = 1;
  client.getGeoValue.mockResolvedValue(value);
  show("coverage");
  expect(await screen.findByText("还没有足够的回答判断药品价值是否被准确表达。")).toBeInTheDocument();
  expect(screen.getByText("尚不能判断 2 条，不适用 1 条。")).toBeInTheDocument();
  expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
});

it("a failed specialist keeps the route to existing research and next work available", async () => {
  client.getGeoValue.mockResolvedValue({ ...empty(), research: [{ id: "r1", question: "这个安全信号说明什么？", status: "failed", runId: "run_1" }] });
  show("actions");
  await userEvent.click(await screen.findByText("查看相关研究"));
  expect(screen.getByText("这个安全信号说明什么？")).toBeInTheDocument();
  expect(screen.getByText("查看已有结果与待补问题")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "继续分析" })).toHaveLength(2);
});

it("a failed read can recover without asking for clinical metadata", async () => {
  client.getGeoValue.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ...empty(), data: { findings: ["已有结果仍可继续使用"] } });
  show();
  await userEvent.click(await screen.findByRole("button", { name: /重试/ }));
  expect(await screen.findByText("已有结果仍可继续使用")).toBeInTheDocument();
});

it("keeps scope, certainty, applicability dates and source identity with the finding", async () => {
  client.getGeoValue.mockResolvedValue({ ...empty(), data: {
    scope: { genericName: "Synthetic medicine", indication: "Synthetic indication", region: "CN", asOf: "2026-10-10" },
    findings: [{ statement: "Comparative evidence remains uncertain", certainty: "low / conflicting", region: "EU",
      timeframe: "12 weeks", validFrom: "2025-01-01", validUntil: "2027-01-01", sourceVersion: "revision 4",
      sources: [{ sourceId: "src_preserved", version: "v2", sha256: "abc123" }] }],
  } });
  const view = show();
  await userEvent.click(await screen.findByText("分析范围"));
  expect(screen.getByText("Synthetic medicine")).toBeVisible();
  expect(screen.getByText("2026-10-10")).toBeVisible();
  await userEvent.click(screen.getByText("依据与适用条件"));
  for (const content of ["low / conflicting", "EU", "12 weeks", "2025-01-01", "2027-01-01", "revision 4", "src_preserved", "版本 v2", "SHA-256 abc123"]) {
    expect(screen.getByText(content)).toBeVisible();
  }
  expect(view.container.querySelector("input, textarea, select")).toBeNull();
  expect(screen.queryByRole("link", { name: "src_preserved" })).not.toBeInTheDocument();
});
