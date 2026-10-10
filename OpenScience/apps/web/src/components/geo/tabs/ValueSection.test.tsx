import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import type { GeoValue } from "@/lib/geoClient";
import { geoProject, valueFilled, VALUE_TITLES } from "../__fixtures__/geoTabs";
import { ValueSection, type ValueMode } from "./ValueSection";

const client = vi.hoisted(() => ({ getGeoValue: vi.fn() }));
const open = vi.hoisted(() => vi.fn());
// Opening the conversation switches the shell's project; it has its own test. Here it is the call a button makes.
vi.mock("../useOpenGeoConversation", () => ({ useOpenGeoConversation: () => open }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()), ...client,
}));

const empty = (): GeoValue => ({ version: 0, updatedAt: null, data: {}, research: [], impacts: [], observations: [],
  coverage: { assessed: 0, represented: 0, partial: 0, contradicted: 0, uncertain: 0, notApplicable: 0, value: null } });
beforeEach(() => {
  client.getGeoValue.mockReset();
  open.mockReset();
  open.mockResolvedValue(true);
});
function show(mode: ValueMode = "profile") {
  return render(<MemoryRouter><ValueSection geoId="geo_1" project={geoProject()} mode={mode} /></MemoryRouter>);
}
/** Let every pending promise land, so "nothing is drawn" is said of a finished read and not of one still on its way. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

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

it("keeps the last round's coverage after the profile moves on, and says which version it measured", async () => {
  const value = { ...empty(), version: 4 };
  value.coverage = { ...value.coverage, assessed: 3, represented: 2, partial: 1, basisVersion: 3 };
  client.getGeoValue.mockResolvedValue(value);
  show("coverage");
  expect(await screen.findByText("2 / 3 次相关结论被完整表达，1 次不完整，0 次存在冲突。")).toBeInTheDocument();
  expect(screen.getByText("以上按第 3 版药品价值分析测得；分析已更新到第 4 版，下一轮测量后按新版本判断。")).toBeInTheDocument();
});

it("says nothing about versions when the coverage was measured on the current profile", async () => {
  const value = { ...empty(), version: 3 };
  value.coverage = { ...value.coverage, assessed: 1, represented: 1, basisVersion: 3 };
  client.getGeoValue.mockResolvedValue(value);
  show("coverage");
  expect(await screen.findByText("1 / 1 次相关结论被完整表达，0 次不完整，0 次存在冲突。")).toBeInTheDocument();
  expect(screen.queryByText(/下一轮测量后按新版本判断/)).not.toBeInTheDocument();
});

it("a failed specialist still shows what its research left, with no button of its own on the row", async () => {
  client.getGeoValue.mockResolvedValue({ ...empty(), research: [{ id: "r1", question: "这个安全信号说明什么？", status: "failed", runId: "run_1" }] });
  show("actions");
  await userEvent.click(await screen.findByText("查看相关研究"));
  expect(screen.getByText("这个安全信号说明什么？")).toBeInTheDocument();
  expect(screen.getByText("查看已有结果与待补问题")).toBeInTheDocument();
  expect(document.querySelector("[data-geo-ask-ai]")).toBeNull();
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

const OTHER_MODES = ["summary", "safety", "decisions", "actions", "sources", "coverage"] as const;

describe("a project with no value analysis", () => {
  it.each(OTHER_MODES)("%s: draws nothing — no box, no heading, no sentence, no button", async (mode) => {
    client.getGeoValue.mockResolvedValue(empty());
    // 方案 beside it proves the read finished: it is the one place an empty analysis draws something.
    const view = render(<MemoryRouter><ValueSection geoId="geo_1" project={geoProject()} mode={mode} /><ValueSection geoId="geo_1" project={geoProject()} mode="profile" /></MemoryRouter>);
    await screen.findByRole("button", { name: "开始药品价值分析" });
    await settle();
    expect(view.container.querySelectorAll("section")).toHaveLength(1);
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("draws nothing at all while the answer is on its way: no skeleton to jump away from", async () => {
    client.getGeoValue.mockReturnValue(new Promise(() => undefined));
    const view = show("summary");
    await settle();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("offers exactly one way to start on 方案, and it opens the conversation with the brief, unsent", async () => {
    client.getGeoValue.mockResolvedValue(empty());
    show("profile");
    expect(await screen.findByRole("heading", { name: "药品价值分析" })).toBeInTheDocument();
    const start = screen.getAllByRole("button");
    expect(start.map((button) => button.textContent)).toEqual(["开始药品价值分析"]);
    await userEvent.click(start[0]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ projectId: "prj_geo_1", sessionId: "ses_geo_1" }, expect.stringContaining("开始药品价值分析"));
  });

  it("is not offered a start where an analysis exists that 方案 has nothing of: it was begun, only not in these words", async () => {
    client.getGeoValue.mockResolvedValue({ ...empty(), version: 2, data: { opportunities: [{ id: "o", statement: "补一篇科普稿" }] } });
    const view = show("profile");
    await settle();
    expect(view.container).toBeEmptyDOMElement();
  });
});

describe("a project that has an analysis", () => {
  it.each(["decisions", "sources", "coverage"] as const)("%s: draws nothing when the analysis has no rows for this tab", async (mode) => {
    client.getGeoValue.mockResolvedValue({ ...empty(), version: 3, data: { findings: [{ id: "f", statement: "疗效优于安慰剂", dimension: "effectiveness" }] } });
    const view = show(mode);
    await settle();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("draws no 问 AI button on any row or section, whichever tab it is on", async () => {
    client.getGeoValue.mockResolvedValue(valueFilled);
    const modes: ValueMode[] = ["summary", "profile", "safety", "decisions", "actions", "sources", "coverage"];
    const view = render(<MemoryRouter>{modes.map((mode) => <ValueSection key={mode} geoId="geo_1" project={geoProject()} mode={mode} />)}</MemoryRouter>);
    // Every section has something here, so every heading is drawn; the research list is folded, so open it.
    for (const title of VALUE_TITLES) expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    await userEvent.click(screen.getByText("查看相关研究"));
    expect(view.container.querySelectorAll("[data-geo-ask-ai]")).toHaveLength(0);
    for (const name of [/继续分析/, /推进这个问题/, /分析表达效果/, /问 AI/, /开始药品价值分析/]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });
});
