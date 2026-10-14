import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  coverage: { assessed: 0, represented: 0, partial: 0, contradicted: 0, notAddressed: 0, uncertain: 0, notApplicable: 0, value: null } });
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

it("keeps 未涉及 beside the headline and outside it: the parts of the headline add up to what was assessed, the unspoken ones are a count of their own (G10d)", async () => {
  const value = { ...empty(), version: 3 };
  value.coverage = { ...value.coverage, assessed: 4, represented: 2, partial: 1, contradicted: 1, notAddressed: 3, basisVersion: 3 };
  client.getGeoValue.mockResolvedValue(value);
  show("coverage");
  const sentence = await screen.findByText("2 / 4 次相关结论被完整表达，1 次不完整，1 次存在冲突；另有 3 次未涉及。");
  // The tone of a count, like the headline beside it: nothing marks an answer that did not speak of a conclusion as a fault.
  expect(sentence.className).toBe("text-ui text-text-2");
  expect(sentence.className).not.toMatch(/danger|warn|error|red/);
});

it("says what it is when every relevant answer left the conclusions unspoken: no headline to compute, and no zero", async () => {
  const value = { ...empty(), version: 3 };
  value.coverage = { ...value.coverage, notAddressed: 5, basisVersion: 3 };
  client.getGeoValue.mockResolvedValue(value);
  show("coverage");
  expect(await screen.findByText("回答还没有谈到这些结论，5 次未涉及。")).toBeInTheDocument();
  expect(screen.queryByText(/0 \/ 0|0%/)).not.toBeInTheDocument();
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

it("keeps scope, certainty, applicability dates and the source's title with the finding — and never its id or digest", async () => {
  client.getGeoValue.mockResolvedValue({ ...empty(), data: {
    scope: { genericName: "Synthetic medicine", indication: "Synthetic indication", region: "CN", asOf: "2026-10-10" },
    findings: [{ statement: "Comparative evidence remains uncertain", certainty: "low / conflicting", region: "EU",
      timeframe: "12 weeks", validFrom: "2025-01-01", validUntil: "2027-01-01", sourceVersion: "revision 4",
      sources: [{ title: "给药负担研究", sourceId: "src_preserved", version: "v2", sha256: "abc123" }] }],
  } });
  const view = show();
  await userEvent.click(await screen.findByText("分析范围"));
  expect(screen.getByText("Synthetic medicine")).toBeVisible();
  expect(screen.getByText("2026-10-10")).toBeVisible();
  await userEvent.click(screen.getByText("依据与适用条件"));
  for (const content of ["low / conflicting", "EU", "12 weeks", "2025-01-01", "2027-01-01", "revision 4", "给药负担研究", "版本 v2"]) {
    expect(screen.getByText(content)).toBeVisible();
  }
  expect(view.container.querySelector("input, textarea, select")).toBeNull();
  expect(view.container.textContent).not.toMatch(/src_|SHA-256|abc123/);
});

it("shows what a finding records in its own shape: a list as its items, an object as its labelled fields, a number as a number, the basis as its label", async () => {
  client.getGeoValue.mockResolvedValue({ ...empty(), version: 2, data: { findings: [{
    statement: "疗效优于安慰剂", dimension: "effectiveness", basis: "synthesized", certainty: 3,
    population: { indication: "成人肥胖", setting: "门诊", age: "18 岁以上" }, comparator: "安慰剂", outcomes: ["体重变化", "停药率"],
    limitations: ["随访仅 12 周", "样本量偏小"],
  }] } });
  const view = show();
  await userEvent.click(await screen.findByText("依据与适用条件"));
  expect(screen.getByText("综合结论")).toBeVisible();
  expect(screen.getByText("3")).toBeVisible();
  expect(screen.getByText("适应证：成人肥胖")).toBeVisible();
  expect(screen.getByText("使用场景：门诊")).toBeVisible();
  // A key with no Chinese label is not printed as a code; its value still is.
  expect(screen.getByText("18 岁以上")).toBeVisible();
  for (const item of ["安慰剂", "体重变化", "停药率", "随访仅 12 周", "样本量偏小"]) expect(screen.getByText(item)).toBeVisible();
  expect(view.container.textContent).not.toMatch(/\[object Object\]|[{}]|age/);
});

it("a zero is a number, and a basis the claim lists do not name is not printed as a machine word", async () => {
  client.getGeoValue.mockResolvedValue({ ...empty(), version: 2, data: { findings: [{ statement: "疗效优于安慰剂", certainty: 0, basis: "indirect", sourceVersion: 0 }] } });
  const view = show();
  await userEvent.click(await screen.findByText("依据与适用条件"));
  expect(screen.getByText("确定性").closest("div")).toHaveTextContent(/^确定性0$/);
  expect(view.container.textContent).not.toContain("indirect");
});

describe("a finding's sources", () => {
  const SOURCE_ID = `src_${"a1b2c3d4".repeat(8)}`;
  const withSources = (sources: unknown[]) => ({ ...empty(), version: 2, data: { findings: [{ id: "f1", statement: "疗效优于安慰剂", sources }] } });
  const openFold = async () => userEvent.click(await screen.findByText("依据与适用条件"));

  it("are named by title, else by a reference a reader can use, else left out", async () => {
    client.getGeoValue.mockResolvedValue(withSources([
      { title: "给药负担研究", sourceId: SOURCE_ID },
      { sourceRef: "PMID:40421736" },
      { sourceId: "doi: 10.1056/NEJMoa2300000" },
      { sourceId: SOURCE_ID },
      { sourceRef: "web-page:e1edc04a1ac28750" },
      "中国成人超重和肥胖症预防控制指南 2024",
      SOURCE_ID,
    ]));
    const view = show();
    await openFold();
    const items = within(screen.getByText("依据与适用条件").closest("details") as HTMLElement).getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual(["给药负担研究", "PMID 40421736", "DOI 10.1056/NEJMoa2300000", "中国成人超重和肥胖症预防控制指南 2024"]);
    expect(view.container.textContent).not.toMatch(/src_|web-page|e1edc04a/);
  });

  it("leave no list at all, and no fold, when none of them can be named and nothing else is known", async () => {
    client.getGeoValue.mockResolvedValue(withSources([{ sourceId: SOURCE_ID, sha256: "abc123" }, SOURCE_ID]));
    const view = show();
    expect(await screen.findByText("疗效优于安慰剂")).toBeInTheDocument();
    expect(screen.queryByText("依据与适用条件")).not.toBeInTheDocument();
    expect(view.container.textContent).not.toMatch(/src_|abc123/);
  });

  it("keep a link on a titled source", async () => {
    client.getGeoValue.mockResolvedValue(withSources([{ title: "给药负担研究", url: "https://example.org/study", sourceId: SOURCE_ID }]));
    show();
    await openFold();
    expect(screen.getByRole("link", { name: "给药负担研究" })).toHaveAttribute("href", "https://example.org/study");
  });
});

describe("the version the section stands on (G10a)", () => {
  /** The server's clock is not the test's: "this year" is the year of the day the tests say it is. */
  const today = (iso: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(iso)); };
  afterEach(() => { vi.useRealTimers(); });

  it("says it once in every section that draws — the profile's version and the day it was written, in the app's day form", async () => {
    today("2026-10-10T12:00:00.000Z");
    client.getGeoValue.mockResolvedValue({ ...valueFilled, version: 3, updatedAt: "2026-10-08T12:00:00.000Z" });
    const modes: ValueMode[] = ["profile", "decisions", "actions", "sources", "coverage"];
    for (const mode of modes) {
      const view = show(mode);
      expect(await screen.findByText("依据版本 3 · 更新于 10月8日"), mode).toBeInTheDocument();
      expect(screen.getAllByText(/依据版本/), `${mode}: one line, not one per row`).toHaveLength(1);
      // A line to read, not a control: no picker for an older version.
      expect(view.container.querySelector("select, input, [role=combobox], [role=listbox]"), mode).toBeNull();
      expect(screen.queryByRole("button", { name: /版本/ }), mode).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("dates a profile written in an earlier year in full, and names the version alone when no time came", async () => {
    today("2026-10-10T12:00:00.000Z");
    client.getGeoValue.mockResolvedValue({ ...empty(), version: 2, updatedAt: "2025-09-22T12:00:00.000Z", data: { findings: [{ id: "f", statement: "疗效优于安慰剂" }] } });
    show();
    expect(await screen.findByText("依据版本 2 · 更新于 2025-09-22")).toBeInTheDocument();
    cleanup();
    client.getGeoValue.mockResolvedValue({ ...empty(), version: 4, updatedAt: null, data: { findings: [{ id: "f", statement: "疗效优于安慰剂" }] } });
    show();
    expect(await screen.findByText("依据版本 4")).toBeInTheDocument();
  });

  it("names no version for a profile that was never written, though something is on the page", async () => {
    client.getGeoValue.mockResolvedValue({ ...empty(), version: 0, data: { opportunities: [{ id: "o", statement: "补一篇科普稿" }] } });
    show("actions");
    expect(await screen.findByText("补一篇科普稿")).toBeInTheDocument();
    expect(screen.queryByText(/依据版本/)).not.toBeInTheDocument();
  });
});

const OTHER_MODES = ["decisions", "actions", "sources", "coverage"] as const;

describe("a project with no value analysis", () => {
  it.each(OTHER_MODES)("%s: draws nothing — no box, no heading, no sentence, no button", async (mode) => {
    client.getGeoValue.mockResolvedValue(empty());
    // The profile beside it proves the read finished: it is the one part where an empty analysis draws something, the recipe.
    const view = render(<MemoryRouter><ValueSection geoId="geo_1" project={geoProject()} mode={mode} /><ValueSection geoId="geo_1" project={geoProject()} mode="profile" /></MemoryRouter>);
    await screen.findByRole("button", { name: "开始药品价值分析" });
    await settle();
    expect(view.container.querySelectorAll("[data-step-state]")).toHaveLength(1);
    expect(view.container.querySelectorAll("section")).toHaveLength(0);
  });

  it("draws nothing at all while the answer is on its way: no skeleton to jump away from", async () => {
    client.getGeoValue.mockReturnValue(new Promise(() => undefined));
    const view = show("decisions");
    await settle();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("offers exactly one way to start, as a recipe, and it opens the conversation with the brief, unsent", async () => {
    client.getGeoValue.mockResolvedValue(empty());
    show("profile");
    expect(await screen.findByText("还没有药品价值分析")).toBeInTheDocument();
    expect(screen.getByText("得到 这个药的获益、风险、适用性、费用与可及性")).toBeInTheDocument();
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
    const modes: ValueMode[] = ["profile", "decisions", "actions", "sources", "coverage"];
    const view = render(<MemoryRouter>{modes.map((mode) => <ValueSection key={mode} geoId="geo_1" project={geoProject()} mode={mode} />)}</MemoryRouter>);
    // Every section has something here, so every heading is drawn; the research list is folded, so open it.
    for (const title of VALUE_TITLES) expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    await userEvent.click(screen.getByText("查看相关研究"));
    expect(view.container.querySelectorAll("[data-geo-ask-ai]")).toHaveLength(0);
    for (const name of [/继续分析/, /推进这个问题/, /分析表达效果/, /问 AI/, /开始药品价值分析/]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });
});

/** `count` findings with a statement each, numbered from 1. */
const findings = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `f${index + 1}`, statement: `第 ${index + 1} 条结论` }));
const rowsIn = (heading: HTMLElement) => within(heading.closest("section") as HTMLElement).getAllByRole("listitem");

describe("a long list is not cut without a word", () => {
  it("lists twelve of fifteen, says there are 15, and 显示更多 brings the rest", async () => {
    client.getGeoValue.mockResolvedValue({ ...empty(), version: 2, data: { findings: findings(15) } });
    show("profile");
    const heading = await screen.findByRole("heading", { name: "药品价值分析" });
    expect(heading.parentElement).toHaveTextContent("共 15 条");
    expect(rowsIn(heading)).toHaveLength(12);
    await userEvent.click(screen.getByRole("button", { name: "显示更多 · 还有 3 条" }));
    expect(rowsIn(heading)).toHaveLength(15);
    expect(screen.getByText("第 15 条结论")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /显示更多/ })).not.toBeInTheDocument();
    expect(heading.parentElement).toHaveTextContent("共 15 条");
  });

  it("a list that fits says no total and offers no 显示更多", async () => {
    client.getGeoValue.mockResolvedValue({ ...empty(), version: 2, data: { findings: findings(12) } });
    show("profile");
    const heading = await screen.findByRole("heading", { name: "药品价值分析" });
    expect(rowsIn(heading)).toHaveLength(12);
    expect(heading.parentElement).not.toHaveTextContent("共");
    expect(screen.queryByRole("button", { name: /显示更多/ })).not.toBeInTheDocument();
  });

  it("行动 lists three of twelve next steps, says there are twelve, and 显示更多 brings the rest", async () => {
    const opportunities = Array.from({ length: 12 }, (_, index) => ({ id: `o${index + 1}`, statement: `第 ${index + 1} 项下一步` }));
    client.getGeoValue.mockResolvedValue({ ...empty(), version: 2, data: { opportunities } });
    show("actions");
    const heading = await screen.findByRole("heading", { name: "下一步研究与内容" });
    expect(heading.parentElement).toHaveTextContent("共 12 条");
    expect(rowsIn(heading)).toHaveLength(3);
    expect(screen.queryByText("第 4 项下一步")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "显示更多 · 还有 9 条" }));
    expect(rowsIn(heading)).toHaveLength(12);
    expect(screen.getByText("第 12 项下一步")).toBeInTheDocument();
  });

  it("lists twenty of the answers a round was judged on, counts them all, and shows the rest on request", async () => {
    const observations = Array.from({ length: 25 }, (_, index) => ({ findingId: `f${index}`, status: "represented", quote: `回答 ${index + 1}`, reason: "", engine: "deepseek", basisVersion: 3, rubricVersion: "1", askedAt: null }));
    client.getGeoValue.mockResolvedValue({ ...empty(), version: 3, observations, coverage: { assessed: 25, represented: 25, partial: 0, contradicted: 0, notAddressed: 0, uncertain: 0, notApplicable: 0, value: 100, basisVersion: 3 } });
    show("coverage");
    await userEvent.click(await screen.findByText("查看回答中的表达 · 共 25 条"));
    const fold = screen.getByText("回答 1").closest("details") as HTMLElement;
    expect(within(fold).getAllByRole("listitem")).toHaveLength(20);
    await userEvent.click(within(fold).getByRole("button", { name: "显示更多 · 还有 5 条" }));
    expect(within(fold).getAllByRole("listitem")).toHaveLength(25);
    expect(screen.getByText("回答 25")).toBeInTheDocument();
  });

  it("a fold that fits says no total", async () => {
    const observations = [{ findingId: "f1", status: "represented", quote: "回答 1", reason: "", engine: "deepseek", basisVersion: 3, rubricVersion: "1", askedAt: null }];
    client.getGeoValue.mockResolvedValue({ ...empty(), version: 3, observations, coverage: { assessed: 1, represented: 1, partial: 0, contradicted: 0, notAddressed: 0, uncertain: 0, notApplicable: 0, value: 100, basisVersion: 3 } });
    show("coverage");
    expect(await screen.findByText("查看回答中的表达")).toBeInTheDocument();
  });
});

describe("a changed source is a place to go, not a count to read", () => {
  const changed = (extra: Partial<GeoValue> = {}): GeoValue => ({
    ...empty(), version: 3, data: { findings: findings(1), opportunities: [{ id: "o1", statement: "补一篇科普稿" }], sourceChanges: [{ id: "c1", summary: "资料 A 已更新" }, { id: "c2", summary: "资料 B 已更新" }] },
    impacts: [{ change: { id: "c1" }, findingIds: ["f1"], groupIds: [], articleIds: [] }, { change: { id: "c2" }, findingIds: [], groupIds: [], articleIds: [] }], ...extra,
  });

  it.each(["actions", "profile"] as const)("%s: the sentence links to 信源", async (mode) => {
    client.getGeoValue.mockResolvedValue(changed());
    show(mode);
    const sentence = (await screen.findByText(/有 2 项依据变化/)).closest("p") as HTMLElement;
    expect(within(sentence).getByRole("link", { name: "去信源查看" })).toHaveAttribute("href", "/app/geo/geo_1/sources");
  });

  it("sources: the changes are the list itself, so there is no sentence to a place that is already here", async () => {
    client.getGeoValue.mockResolvedValue(changed());
    show("sources");
    expect(await screen.findByText("资料 A 已更新")).toBeInTheDocument();
    expect(screen.getByText("资料 B 已更新")).toBeInTheDocument();
    expect(screen.queryByText(/项依据变化/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("sources: a change that has been dealt with is history and is not listed", async () => {
    client.getGeoValue.mockResolvedValue(changed({ data: { sourceChanges: [{ id: "c1", summary: "资料 A 已更新" }, { id: "c2", summary: "资料 B 已更新", status: "retired" }] } }));
    show("sources");
    expect(await screen.findByText("资料 A 已更新")).toBeInTheDocument();
    expect(screen.queryByText("资料 B 已更新")).not.toBeInTheDocument();
  });
});
