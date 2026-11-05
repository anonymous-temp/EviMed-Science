import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrQualityReport, type VcrStudy } from "@/lib/vcrClient";
import { PopulationTab } from "./PopulationTab";
import { renderTab } from "../__fixtures__/tabFrame";
import { fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { generatedPopulation } from "../__fixtures__/generatedPopulation";

/**
 * 人群 (R19; audit B §4.4): a generated population is a table of its variables with the limit in the row, its shapes against what
 * was declared, and its first records; a real cohort is the rules that selected it and what each did to the count. Under a frame,
 * so the band's controls are where a reader finds them. Payloads are the server's fixtures (`vcr-views/ev201/population.json` is a
 * real cohort; the generated one is the same payload with the fields a generated population carries).
 */

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));
const web = vi.hoisted(() => ({ fetchWithWebAuth: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  fetchWithWebAuth: web.fetchWithWebAuth,
}));

const ev201 = (): VcrStudy => readVcrStudy(fixture("ev201/study.json"));
const withStep = (step: string, fields: Record<string, unknown>): VcrStudy => {
  const raw = fixture("ev201/study.json");
  raw.steps[step] = { ...raw.steps[step], ...fields };
  return readVcrStudy(raw);
};
const readOnly = (): VcrStudy => { const raw = fixture("ev201/study.json"); raw.abilities = ["read"]; return readVcrStudy(raw); };
const tab = (name: string) => `GET /vcr/studies/${STUDY_ID}/${name}`;
const nothingIn = (name: string) => ({ [tab(name)]: fixture(`empty/${name}.json`) });
const draw = (study: VcrStudy = ev201()) => renderTab(<PopulationTab studyId={STUDY_ID} study={study} />);
const band = (container: HTMLElement) => container.querySelector("[data-page-chrome]") as HTMLElement;
const found = (root: ParentNode, selector: string) => waitFor(() => {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`nothing at ${selector}`);
  return node as HTMLElement;
});

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  web.fetchWithWebAuth.mockReset();
  installVcrServer(network.productRequest);
});

describe("人群 · a real cohort", () => {
  it("shows the server's own counts: kept, excluded and undecidable apart, and the three outcomes", async () => {
    const { container } = draw();
    const outcome = await found(container, "[data-vcr-outcome]");
    expect(outcome).toHaveTextContent("57 符合");
    expect(outcome).toHaveTextContent("612 可能符合");
    expect(outcome).toHaveTextContent("2,743 不符合");
    expect(container.querySelector("[data-headline]")).toHaveTextContent("按方案 v1，3,412 人中 57 人全部满足、612 人至少 1 条无法判断。");
    const i3 = container.querySelector("[data-vcr-rule='I3']") as HTMLElement;
    expect(i3.querySelector("[data-vcr-rule-kept]")).toHaveTextContent("1,855");
    expect(i3.querySelector("[data-vcr-rule-excluded]")).toHaveTextContent("611");
    expect(i3.querySelector("[data-vcr-rule-unknown]")).toHaveTextContent("22");
    // A rule nobody counted is a dash, never a zero.
    expect((container.querySelector("[data-vcr-rule='E2'] [data-vcr-rule-kept]") as HTMLElement).textContent).toBe("—");
  });

  it("keeps the rules as a table with the protocol's own words, and the definition as the one key / value list", async () => {
    const { container } = draw();
    await found(container, "[data-vcr-outcome]");
    const rules = screen.getByRole("table", { name: "入排标准，每条保留、排除和无法判断的人数" });
    expect(within(rules).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["编号", "标准", "保留", "排除", "无法判断"]);
    expect(rules).toHaveTextContent("“ECOG 体能评分 0–1（近 4 周内）”");
    const definition = screen.getByText("时间零点").closest("[data-fact-list]") as HTMLElement;
    expect(definition).toHaveTextContent("一线治疗后首次影像进展日");
  });

  it("keeps a stale population on screen, greyed, under the bar that says a recomputation is queued", async () => {
    const { container } = draw();
    await screen.findByText("逐条筛选");
    expect(container.querySelector("[data-vcr-stale]")).toHaveTextContent("入排条件已变更 · 输入已变更，数字已过期，排队重算中");
    const greyed = container.querySelector("[data-vcr-stale-block] [data-vcr-stale-results]") as HTMLElement;
    expect(greyed).not.toBeNull();
    expect(within(greyed).getByText("逐条筛选")).toBeInTheDocument();
    expect(greyed.querySelector("[data-vcr-outcome]")).toHaveTextContent("2,743");
  });

  it("does not show a stale synthetic quality report for the real cohort", async () => {
    const { container } = draw();
    await found(container, "[data-vcr-outcome]");
    expect(fixture("ev201/population.json").quality).toBeNull();
    expect(container.querySelector("[data-vcr-quality]")).toBeNull();
    expect(screen.queryByText("合成 · 探索性")).toBeNull();
  });

  // Two cards answering one question with different numbers was a defect: the engine's comparison of two versions (定义库) is the one
  // comparison, and a side-by-side of what each stored population version said beside it is gone.
  it("compares two versions once, by the engine, and keeps no second card of what each version stored", async () => {
    const raw = fixture("ev201/population.json");
    raw.knowledge = {
      pack: null, savable: [],
      definitions: [{ definitionId: "dfn_1", version: 2, populationId: "pop_1", name: "成人 ECOG 0–1", text: "", versions: 2, uses: 1, usedAt: null, packRefs: [] }],
      comparisons: [{ id: "res_1", definitionId: "dfn_1", versionA: 1, versionB: 2, snapshotId: "snp_1", cohortSizeA: 417, cohortSizeB: 324,
        overlap: { both: 324, onlyA: 93, onlyB: 0 }, floor: 0.1,
        covariates: [{ covariate: "age", kind: "continuous", meanA: 59.4, meanB: 63.9, standardizedDifference: 0.321 }] }],
    };
    installVcrServer(network.productRequest, { [tab("population")]: raw });
    const { container } = draw();
    await screen.findByText("逐条筛选");
    expect(container.querySelectorAll("[data-vcr-comparison]")).toHaveLength(1);
    expect(container.querySelector("[data-vcr-comparison='res_1']")).toHaveTextContent("v1 保留 417 人");
    expect(container.querySelector("[data-vcr-version-compare]")).toBeNull();
    expect(screen.queryByText("版本对比")).not.toBeInTheDocument();
    // The version the page reads is named in the band as a fact — not as a tag that looks like a switch.
    expect(band(container)).toHaveTextContent("人群 v2（方案 v1） · 真实队列");
    expect(within(band(container)).queryByRole("button", { name: /人群 v/ })).toBeNull();
  });

  it("has no counts band of its own", async () => {
    const { container } = draw();
    await screen.findByText("逐条筛选");
    expect(container.querySelector("[data-vcr-counts]")).toBeNull();
  });

  it("flags a covariate past the balance floor", async () => {
    draw();
    expect(await screen.findByRole("img", { name: /既往免疫治疗 标准化差异 0.31，超过界值/ })).toBeInTheDocument();
  });



  it("offers a reader who cannot write nothing to edit", async () => {
    const { container } = draw(readOnly());
    await screen.findByText("逐条筛选");
    expect(within(band(container)).queryByRole("button", { name: "改入排数值" })).toBeNull();
  });
});

describe("人群 · a generated population", () => {
  const serve = (patch: (raw: any) => void = () => undefined, overrides: Record<string, unknown> = {}) => {
    const raw = generatedPopulation();
    patch(raw);
    installVcrServer(network.productRequest, { [tab("population")]: raw, ...overrides });
  };

  it("opens with the premises of the generated records: independence is an assumption, the source trial's likeness is not verified", async () => {
    serve((raw) => {
      raw.premises = [
        { key: "correlation", label: "变量之间的相关性", value: "假设相互独立", source: "assumed", decisive: true },
        { key: "similarity", label: "与来源试验人群的相似性", value: "未验证，只复现来源给出的汇总数", source: "assumed", decisive: true },
        { key: "sampling", label: "参数的不确定度", value: "没有重抽：参数按给定值固定", source: "default", decisive: true },
      ];
    });
    const { container, spies } = draw();
    const block = await found(container, "[data-vcr-premises]");
    expect(block.querySelectorAll("[data-vcr-premises-open] [data-vcr-premise]")).toHaveLength(3);
    expect(block.querySelector("[data-vcr-premise='correlation']")).toHaveTextContent("假设相互独立");
    expect(block.querySelector("[data-vcr-premise='sampling']")).toHaveTextContent("默认");
    await userEvent.click(within(block).getByRole("button", { name: "让 AI 调整：变量之间的相关性" }));
    expect(spies.openChat).toHaveBeenCalledTimes(1);
    expect(spies.openChat.mock.calls[0][0]).toContain("改“变量之间的相关性”（现在是 假设相互独立）");
  });

  it("carries a synthetic quality report of values, tagged exploratory, and no verdict", async () => {
    const quality: VcrQualityReport = {
      tag: "合成 · 探索性", trainingRecords: 3412, copies: 1,
      groups: [
        { key: "fidelity", label: "保真度", rows: [{ key: "ks", label: "最大 KS 距离", value: { value: 0.04, source: "synthetic" } }] },
        { key: "utility", label: "可用性", rows: [{ key: "joint", label: "入排通过率的相对差", value: { value: 0.06, source: "synthetic" } }] },
        { key: "leakage", label: "泄露风险", rows: [{ key: "membership", label: "成员推断 AUC", value: { value: 0.52, source: "synthetic" } }] },
      ],
    };
    serve((raw) => {
      raw.quality = quality;
      raw.download = { path: `records/${raw.records.result}.csv`, rows: raw.records.rows };
    });
    const { container } = draw();
    const report = (await found(container, "[data-vcr-quality]")).closest("section") as HTMLElement;
    expect(within(report).getByText("质量报告")).toBeInTheDocument();
    expect(within(report).getByText("合成 · 探索性")).toBeInTheDocument();
    for (const group of ["fidelity", "utility", "leakage"]) {
      expect(report.querySelector(`[data-vcr-quality-group='${group}']`)).not.toBeNull();
    }
    expect(within(report).getByText("成员推断 AUC").closest("div")).toHaveTextContent("0.52");
    expect(within(report).getByText("训练记录 3,412 条 · 合成 1 份")).toBeInTheDocument();
    expect(container.querySelector("[data-headline]")).toHaveTextContent("情景人群 · 1,000 条生成记录");
    expect(report.textContent).not.toMatch(/安全|匿名|合格/);
  });

  it("reports the false-positive rate of an analysis on the copies and who is easiest to recognise, as counts and shares and never a row", async () => {
    const quality: VcrQualityReport = {
      tag: "合成 · 探索性", trainingRecords: 300, copies: 5,
      rule: "合成表的 5 份按 Raab 等人的规则合并（每份用同一组参数）：方差里加上了生成模型本身的抽样误差，直接把一份当真实数据分析会低估它。",
      groups: [
        { key: "inference", label: "推断是否可信", rows: [
          { key: "fp_real", label: "把臂标签打乱后，直接在真实表上做这个分析，误判有效的概率", value: { value: 5, unit: "%", source: "synthetic", mcse: 2.2 } },
          { key: "fp_naive", label: "把合成表的第 1 份当真实数据做同一个分析，误判有效的概率", value: { value: 16, unit: "%", source: "synthetic", mcse: 3.7 } },
          { key: "fp_combined", label: "合成表各份按规则合并后，误判有效的概率", value: { value: 6, unit: "%", source: "synthetic", mcse: 2.4 } },
        ] },
        { key: "leakage", label: "泄露风险", rows: [{ key: "risk_share", label: "真实记录里被认出来的风险高于 0.75 的占比", value: { value: 17.7, unit: "%", source: "synthetic" } }] },
      ],
      atRisk: { bound: 0.75, size: 53, described: true, rows: [
        { variable: "site", level: "north", atRisk: 31, all: 135, atRiskShare: 58.5, allShare: 45 },
        { variable: "age", level: "最高的三分之一", atRisk: 18, all: 100, atRiskShare: 34, allShare: 33.3 },
      ] },
    };
    serve((raw) => {
      raw.quality = quality;
      raw.download = { path: `records/${raw.records.result}.csv`, rows: raw.records.rows };
    });
    const { container } = draw();
    const report = (await found(container, "[data-vcr-quality]")).closest("section") as HTMLElement;
    expect(report.querySelector("[data-vcr-quality-group='inference']")).not.toBeNull();
    expect(within(report).getByText("合成表各份按规则合并后，误判有效的概率").closest("div")).toHaveTextContent("6");
    expect(report.querySelector("[data-vcr-quality-rule]")).toHaveTextContent("Raab");
    const table = report.querySelector("[data-vcr-quality-atrisk]") as HTMLElement;
    expect(table).toHaveTextContent("哪些人最容易被认出来");
    expect(table.querySelectorAll("[data-vcr-quality-atrisk-row]")).toHaveLength(2);
    expect(table.querySelector("[data-vcr-quality-atrisk-row='site:north']")).toHaveTextContent("59%（31 人）");
    expect(report.textContent).not.toMatch(/安全|匿名|合格/);
  });

  it("does not describe an at-risk group of fewer than ten people", async () => {
    const quality: VcrQualityReport = {
      tag: "合成 · 探索性", trainingRecords: 300, copies: 1,
      groups: [{ key: "leakage", label: "泄露风险", rows: [{ key: "membership", label: "成员推断 AUC", value: { value: 0.52, source: "synthetic" } }] }],
      atRisk: { bound: 0.75, size: null, described: false, rows: [] },
    };
    serve((raw) => {
      raw.quality = quality;
      raw.download = { path: `records/${raw.records.result}.csv`, rows: raw.records.rows };
    });
    const { container } = draw();
    const report = (await found(container, "[data-vcr-quality]")).closest("section") as HTMLElement;
    expect(report.querySelector("[data-vcr-quality-atrisk]")).toHaveTextContent("不足 10 条");
    expect(report.querySelector("[data-vcr-quality-atrisk-row]")).toBeNull();
  });

  it("says what it is in one line — version, kind, how many records — and which variables broke a limit; no card says how it was made or what it may be used for", async () => {
    serve();
    const { container } = draw();
    const sentence = await found(container, "[data-headline]");
    expect(sentence).toHaveTextContent("人群 v1 · 情景人群 · 1,000 条生成记录");
    expect(sentence).toHaveTextContent("1 个变量有记录越出设定的限定");
    expect(sentence).toHaveTextContent("eGFR 下限 3 条记录违反");
    // The two cards and the grey line over them are gone, and so is the tag over the header.
    for (const gone of ["怎么生成的", "能用来做什么", "仅用于设计", "它不是真实患者", "这个人群生成时还没有画像", "按设定的分布和相关性抽样"]) {
      expect(screen.queryByText(new RegExp(gone))).toBeNull();
    }
    expect(container.querySelector("[data-vcr-counts]")).toBeNull();
    expect(screen.queryByText("逐条筛选")).toBeNull();
  });

  it("sets what the study declared for each variable beside what came out, with the shape, and puts the limit in the row as a mark", async () => {
    serve();
    const { container } = draw();
    const table = await screen.findByRole("table", { name: "每个变量设定的分布和生成的结果" });
    const row = (key: string) => table.querySelector(`[data-vcr-variable='${key}']`) as HTMLElement;
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["变量", "设定", "生成", "分布", "限定"]);
    expect(row("age")).toHaveTextContent("年龄（岁）");
    expect(row("age")).toHaveTextContent("正态分布，均数 58、标准差 10；限定在 18–90");
    expect(row("age")).toHaveTextContent("均数 58.2，标准差 9.8");
    expect(row("age").querySelectorAll("[data-vcr-histogram] > span")).toHaveLength(7);
    // ✓ 限定 18–90 where nothing broke it; ⚠ 违反 12 条 where records did.
    expect(row("age").querySelector("[data-vcr-limit='ok']")).toHaveTextContent("限定 18–90");
    expect(row("egfr").querySelector("[data-vcr-limit='broken']")).toHaveTextContent("违反 12 条");
    // A variable that declared nothing carries neither; a distribution that has no histogram draws none; a missing count is said in the row.
    expect(row("tumour").querySelector("[data-vcr-limit]")).toBeNull();
    expect(row("tumour")).toHaveTextContent("缺失 12 条（1.2%）");
    expect(row("female").querySelector("[data-vcr-histogram]")).toBeNull();
    // And nobody is told that a table was made from real data: the setting column simply has nothing for it.
    expect(container.textContent).not.toContain("按真实数据合成");
  });

  it("draws every variable again as small multiples against what was declared, under the table", async () => {
    serve();
    const { container } = draw();
    await screen.findByRole("table", { name: "每个变量设定的分布和生成的结果" });
    const grid = await found(container, "[data-vcr-distributions]");
    expect(grid.querySelectorAll("[data-vcr-distribution]")).toHaveLength(4);
    expect(grid.querySelector("[data-vcr-distribution='egfr'] [data-vcr-limit='broken']")).toHaveTextContent("违反 12 条");
    expect(grid.querySelector("[data-vcr-distribution='female'] [data-vcr-target]")).not.toBeNull();
  });

  it("lists the first records below it — the same table the patients tab has — and opens none: a population has no one to name", async () => {
    serve();
    const { container } = draw();
    const records = await screen.findByRole("table", { name: "记录" });
    expect(within(records).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(expect.arrayContaining(["序号"]));
    expect(within(records).getAllByRole("row").length).toBeGreaterThan(1);
    expect(records.querySelector("[data-vcr-open-patient]")).toBeNull();
    expect(container.querySelector("[data-row-open]")).toBeNull();
    expect(network.productRequest.mock.calls.some(([path]) => String(path).includes("/population/rows") && String(path).includes("result=res_pop"))).toBe(true);
  });

  describe("the records", () => {
    let click: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
      URL.createObjectURL = vi.fn(() => "blob:records");
      URL.revokeObjectURL = vi.fn();
    });

    it("downloads the CSV through the records route, under the file's own name, from the band", async () => {
      serve();
      web.fetchWithWebAuth.mockResolvedValue(new Response("a,b\n1,2\n", { status: 200, headers: { "content-disposition": 'attachment; filename="synthetic-population.csv"' } }));
      const { container } = draw();
      await screen.findByRole("table", { name: "每个变量设定的分布和生成的结果" });
      await userEvent.click(within(band(container)).getByRole("button", { name: "下载 CSV" }));
      await waitFor(() => expect(click).toHaveBeenCalled());
      expect(String(web.fetchWithWebAuth.mock.calls[0][0])).toMatch(/\/vcr\/studies\/std_1\/records\/res_9\.csv$/);
      expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("synthetic-population.csv");
    });

    it("says why when the file may not leave — nothing is saved under its name", async () => {
      serve();
      web.fetchWithWebAuth.mockResolvedValue(new Response(JSON.stringify({ error: "x", code: "vcr_records_not_synthetic" }), { status: 403, headers: { "content-type": "application/json" } }));
      const { container } = draw();
      await screen.findByRole("table", { name: "每个变量设定的分布和生成的结果" });
      await userEvent.click(within(band(container)).getByRole("button", { name: "下载 CSV" }));
      await waitFor(() => expect(toasts.error).toHaveBeenCalled());
      expect(click).not.toHaveBeenCalled();
    });

    it("offers no download where the server offered no records", async () => {
      serve((raw) => { raw.download = null; });
      const { container } = draw();
      await screen.findByRole("table", { name: "每个变量设定的分布和生成的结果" });
      expect(within(band(container)).queryByRole("button", { name: "下载 CSV" })).toBeNull();
    });
  });



  it("describes a population by what the server could read: without a profile it is the header, the band and the records — and no sentence about regenerating", async () => {
    serve((raw) => { raw.profile = []; raw.profileKind = null; });
    const { container } = draw();
    await found(container, "[data-headline]");
    expect(container.querySelector("[data-headline]")).toHaveTextContent("人群 v1 · 情景人群 · 1,000 条生成记录");
    expect(screen.queryByRole("table", { name: "每个变量设定的分布和生成的结果" })).toBeNull();
    expect(screen.queryByText(/让 AI 生成新版本/)).toBeInTheDocument();
    expect(screen.queryByText(/还没有画像/)).toBeNull();
  });







  it("offers a reader who cannot write the download and nothing that would be refused", async () => {
    serve();
    const { container } = draw(readOnly());
    await within(await found(container, "[data-page-chrome]")).findByRole("button", { name: "下载 CSV" });
    expect(within(band(container)).queryByRole("button", { name: "让 AI 生成新版本" })).toBeNull();
    expect(within(band(container)).queryByRole("button", { name: "让 AI 调整设定" })).toBeNull();
  });
});

describe("人群 · before there is one", () => {


  it("is a recipe with one verb-and-object button when the step was never asked for, and the button starts it where the reader is", async () => {
    installVcrServer(network.productRequest, nothingIn("population"));
    const { container, spies } = draw(withStep("population", { status: "none", requested: false }));
    const recipe = await found(container, "[data-vcr-step-empty='population']");
    await userEvent.click(within(recipe).getByRole("button", { name: "让 AI 构建人群" }));
    expect(spies.openChat).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ studyId: STUDY_ID }));
    expect(network.productRequest.mock.calls.filter(([, method]) => method === "POST")).toEqual([]);
  });

  it("says where a step that was asked for waits, and offers no second start", async () => {
    installVcrServer(network.productRequest, nothingIn("population"));
    const { container } = draw(withStep("population", { status: "none", requested: true }));
    const waiting = await found(container, "[data-vcr-step-waiting='population']");
    expect(within(waiting).queryByRole("button", { name: "让 AI 构建人群" })).toBeNull();
  });
});

it("adjusts a cohort in its existing conversation with the result identity and no immediate write", async () => {
  const payload = { ...generatedPopulation(), selection: { objectId: "pop_saved", version: 3, resultId: "res_9", resultVersion: 2 } };
  installVcrServer(network.productRequest, { [tab("population")]: payload });
  const view = renderTab(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
  await userEvent.click(await screen.findByRole("button", { name: "让 AI 调整设定" }));
  expect(view.spies.openChat).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ studyId: STUDY_ID }));
  expect(view.spies.openChat.mock.calls[0][1]).toMatchObject({ objectId: "pop_saved", version: 3, resultId: "res_9", resultVersion: 2 });
  expect(view.spies.openChat.mock.calls[0][0]).not.toMatch(/std_|res_/);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(network.productRequest.mock.calls.filter(([, method]) => method === "POST")).toEqual([]);
});
