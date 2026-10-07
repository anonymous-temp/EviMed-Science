import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { OverviewTab } from "./OverviewTab";
import { PopulationTab } from "./PopulationTab";
import { PatientsTab, VCR_COUNTERFACTUAL_SENTENCE } from "./PatientsTab";
import { ComparatorTab } from "./ComparatorTab";
import { TrialTab } from "./TrialTab";
import { EMPTY_STUDY_ID, fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { VCR_NO_DEFINITION, VCR_STEP_QUEUED } from "../vcrText";

/**
 * The five design tabs, rendered from what the server sends.
 *
 * Every payload here is a fixture under `apps/server/test/fixtures/vcr-views/`
 * — the bytes the real presenter produces for the seeded EV-201 study — read
 * through the real `vcrClient` readers and route functions. Only
 * `productRequest` is doubled; a test that needs a variant edits its own copy
 * of the fixture, never a shape of its own invention.
 */

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const store = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }, { id: "prj_empty" }], select: store.select, load: store.load }) },
}));

const web = vi.hoisted(() => ({ fetchWithWebAuth: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  fetchWithWebAuth: web.fetchWithWebAuth,
}));

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);
const ev201 = (): VcrStudy => readVcrStudy(fixture("ev201/study.json"));
const emptyStudy = (): VcrStudy => readVcrStudy(fixture("empty/study.json"));
const tab = (name: string) => `GET /vcr/studies/${STUDY_ID}/${name}`;
const gets = (name: string) => network.productRequest.mock.calls.filter(([path, method]) => path === `/vcr/studies/${STUDY_ID}/${name}` && (method ?? "GET") === "GET");

/** The element at `selector`, once the tab has read its route; a miss fails the test with the selector. */
const found = (root: ParentNode, selector: string) => waitFor(() => {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`nothing at ${selector}`);
  return node as HTMLElement;
});
/** The trial tab has read its route and drawn its comparison of the designs. */
const trialDrawn = () => screen.findByRole("table", { name: "方案的对比" });
/** The EV-201 study with one step set to a state: the study has a definition, so an empty tab is the step's own state and not 「还没有说话」. */
const withStep = (step: string, fields: Record<string, unknown>): VcrStudy => {
  const raw = fixture("ev201/study.json");
  raw.steps[step] = { ...raw.steps[step], ...fields };
  return readVcrStudy(raw);
};
/** The tab's payload of the study nothing was done for, so the tab has nothing to draw. */
const nothingIn = (name: string) => ({ [tab(name)]: fixture(`empty/${name}.json`) });

/** Every 「区间」 on screen carries its name (plan §9.6). */
const BARE_INTERVAL = /(?<!预测|置信|可信|蒙特卡洛)区间/;

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  store.select.mockClear();
  installVcrServer(network.productRequest);
});

describe("总览", () => {
  it("leads with the study's own sentence", () => {
    draw(<OverviewTab studyId={STUDY_ID} study={ev201()} />);
    expect(screen.getByText("已模拟 3 个方案，成功把握 58%～74%；真实外部对照不可估计，缺 3 项数据。")).toBeInTheDocument();
  });

  // Four things and nothing stacked under them: the tiles, the chart, the change log and the disease pack each have a place of their own.
  it("keeps four things — the sentence, the next step, the four numbers, the deliverables — and none of what used to be stacked under them", () => {
    const { container } = draw(<OverviewTab studyId={STUDY_ID} study={ev201()} />);
    expect(container.querySelector("[data-vcr-counts]")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "交付物" })).toBeInTheDocument();
    for (const gone of ["关键数字", "最近的变化", "知识包与定义", "病种定义包", "方案的成功把握与周期、成本"]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(container.querySelector("[data-vcr-scatter]")).toBeNull();
    expect(container.querySelector("[data-vcr-knowledge]")).toBeNull();
  });

  it("fixes the four counts in the band, with the design they are of", () => {
    const { container } = draw(<OverviewTab studyId={STUDY_ID} study={ev201()} />);
    const band = container.querySelector("[data-vcr-counts]") as HTMLElement;
    expect(within(band).getByText("方案 B")).toBeInTheDocument();
    expect(band.querySelector("[data-vcr-count='realPatients']")).toHaveTextContent("0");
    expect(band.querySelector("[data-vcr-count='events']")).toHaveTextContent("138");
    expect(band.querySelector("[data-vcr-count='effectiveSampleSize']")).toHaveTextContent("—");
    expect(band.querySelector("[data-vcr-count='generatedRecords']")).toHaveTextContent("约 648 万");
  });

  it("links an attention line to the tab the server named, and gives the budget line no link of its own", () => {
    draw(<OverviewTab studyId={STUDY_ID} study={ev201()} />);
    expect(screen.getByRole("link", { name: "去复核" })).toHaveAttribute("href", `/app/virtual-research/${STUDY_ID}/data`);
    expect(screen.getByRole("link", { name: "查看缺口" })).toHaveAttribute("href", `/app/virtual-research/${STUDY_ID}/comparator`);
    const budget = screen.getByText("1 项计算在等你确认计算预算").closest("li") as HTMLElement;
    expect(within(budget).queryByRole("link")).not.toBeInTheDocument();
  });

  it("draws 需要关注 only while there is something in it", () => {
    const raw = fixture("ev201/study.json");
    raw.overview.attention = [];
    draw(<OverviewTab studyId={STUDY_ID} study={readVcrStudy(raw)} />);
    expect(screen.queryByText("需要关注")).toBeNull();
    expect(screen.queryByText(/现在没有需要你处理的事/)).toBeNull();
  });

  it("lists the deliverables, each opening the package in the reader on this page", () => {
    draw(<OverviewTab studyId={STUDY_ID} study={ev201()} />);
    const first = fixture("ev201/study.json").overview.deliverables[0];
    expect(screen.getByRole("link", { name: first.title })).toHaveAttribute("href", `/app/virtual-research/${STUDY_ID}?package=${encodeURIComponent(first.id)}`);
  });

  describe("the next step", () => {
    it("is one primary button naming the first step nothing has started, and starts it in the study's conversation", async () => {
      const study = withStep("trial", { status: "none", requested: false });
      study.steps.matching = { ...study.steps.matching, status: "done" };
      draw(<OverviewTab studyId={STUDY_ID} study={study} />);
      const button = screen.getByRole("button", { name: "让 AI 做下一步：模拟试验方案" });
      await userEvent.click(button);
      await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "trial" }));
    });

    it("asks for the earliest unstarted step when several are", () => {
      const raw = fixture("ev201/study.json");
      raw.steps.evidence = { status: "none", requested: false };
      raw.steps.population = { status: "none", requested: false };
      draw(<OverviewTab studyId={STUDY_ID} study={readVcrStudy(raw)} />);
      expect(screen.getByRole("button", { name: "让 AI 做下一步：找证据、整理假设卡" })).toBeInTheDocument();
    });

    it("says what is under way and offers no second thing to start, while a step runs and nothing else is unstarted", () => {
      const study = withStep("trial", { status: "running" });
      draw(<OverviewTab studyId={STUDY_ID} study={study} />);
      expect(screen.queryByRole("button", { name: /让 AI 做下一步/ })).toBeNull();
      expect(document.querySelector("[data-vcr-next='underway']")).toHaveTextContent("正在进行：试验");
    });

    it("is not offered to a reader who cannot start a step", () => {
      const raw = fixture("ev201/study.json");
      raw.steps.trial = { status: "none", requested: false };
      raw.abilities = ["read"];
      draw(<OverviewTab studyId={STUDY_ID} study={readVcrStudy(raw)} />);
      expect(screen.queryByRole("button", { name: /让 AI 做下一步/ })).toBeNull();
    });
  });

  // 「正在排队」 was a lie: nothing is queued for a study nobody has described. It is waiting for its first sentence.
  describe("a study nobody has described", () => {
    it("says what is missing — the first sentence, in the conversation — and offers 去对话, with 让 AI 做 present and not pressable", async () => {
      draw(<OverviewTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />);
      expect(screen.getByText(VCR_NO_DEFINITION)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "让 AI 做" })).toBeDisabled();
      expect(screen.queryByText("研究定义正在排队。")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "去对话" }));
      await waitFor(() => expect(store.select).toHaveBeenCalledWith("prj_empty", expect.any(Function)));
    });

    it("offers no next step either, and no 让 AI 做 to a reader who cannot run one", () => {
      const raw = fixture("empty/study.json");
      raw.abilities = ["read"];
      draw(<OverviewTab studyId={EMPTY_STUDY_ID} study={readVcrStudy(raw)} />);
      expect(screen.queryByRole("button", { name: /让 AI 做/ })).toBeNull();
      expect(screen.getByRole("button", { name: "去对话" })).toBeInTheDocument();
    });
  });
});

describe("人群", () => {
  it("shows the server's own counts: kept, excluded and undecidable apart, and the three outcomes", async () => {
    const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    const outcome = await found(container, "[data-vcr-outcome]");
    expect(outcome).toHaveTextContent("57 符合");
    expect(outcome).toHaveTextContent("612 可能符合");
    expect(outcome).toHaveTextContent("2,743 不符合");
    expect(screen.getByText("按方案 v1，3,412 人中 57 人全部满足、612 人至少 1 条无法判断。")).toBeInTheDocument();
    const i3 = container.querySelector("[data-vcr-rule='I3']") as HTMLElement;
    expect(i3.querySelector("[data-vcr-rule-kept]")).toHaveTextContent("1,855");
    expect(i3.querySelector("[data-vcr-rule-excluded]")).toHaveTextContent("611");
    expect(i3.querySelector("[data-vcr-rule-unknown]")).toHaveTextContent("22");
    // A rule nobody counted is a dash, never a zero.
    expect((container.querySelector("[data-vcr-rule='E2'] [data-vcr-rule-kept]") as HTMLElement).textContent).toBe("—");
  });

  it("keeps a stale population on screen, greyed, under the bar that says a recomputation is queued", async () => {
    const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    await screen.findByText("逐条筛选");
    expect(container.querySelector("[data-vcr-stale]")).toHaveTextContent("入排条件已变更 · 输入已变更，排队重算中");
    const greyed = container.querySelector("[data-vcr-stale-block] .opacity-disabled") as HTMLElement;
    expect(greyed).not.toBeNull();
    expect(within(greyed).getByText("逐条筛选")).toBeInTheDocument();
    expect(greyed.querySelector("[data-vcr-outcome]")).toHaveTextContent("2,743");
  });

  it("carries a quality report of values, tagged exploratory, and no verdict", async () => {
    const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    const report = (await found(container, "[data-vcr-quality]")).closest("section") as HTMLElement;
    expect(within(report).getByText("质量报告")).toBeInTheDocument();
    expect(within(report).getByText("合成 · 探索性")).toBeInTheDocument();
    for (const group of ["fidelity", "utility", "leakage"]) {
      expect(report.querySelector(`[data-vcr-quality-group='${group}']`)).not.toBeNull();
    }
    expect(within(report).getByText("成员推断 AUC").closest("div")).toHaveTextContent("0.52");
    expect(within(report).getByText("训练记录 3,412 条 · 合成 1 份")).toBeInTheDocument();
    expect(report.textContent).not.toMatch(/安全|匿名|合格/);
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
    const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    await screen.findByText("逐条筛选");
    // The stored versions are still named in the toolbar, and the engine's card is the only comparison on the page.
    expect(screen.getByText("人群 v1")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-vcr-comparison]")).toHaveLength(1);
    expect(container.querySelector("[data-vcr-comparison='res_1']")).toHaveTextContent("v1 保留 417 人");
    expect(container.querySelector("[data-vcr-version-compare]")).toBeNull();
    expect(screen.queryByText("版本对比")).not.toBeInTheDocument();
  });

  // The four numbers are on 总览 and nowhere else: a band under every tab was the same four numbers read five times.
  it("has no counts band of its own", async () => {
    const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    await screen.findByText("逐条筛选");
    expect(container.querySelector("[data-vcr-counts]")).toBeNull();
  });

  describe("a generated population", () => {
    /** What the server sends for a scenario population the engine has described (the profile is the engine's own, one entry per variable). */
    const generated = () => {
      const raw = fixture("ev201/population.json");
      raw.version = "人群 v1";
      raw.kind = "情景人群";
      raw.versions = [{ id: "pop_1", label: "人群 v1", stale: false, counts: null }];
      raw.method = "按设定的分布和相关性抽样";
      raw.allowedUses = [{ key: "design", label: "设计" }, { key: "feasibility", label: "可行性" }];
      raw.constraints = [{ label: "成年", violations: 0 }, { label: "eGFR 下限", violations: 3 }];
      raw.profileKind = "generated";
      raw.profileNote = null;
      raw.profileMissing = false;
      raw.profile = [
        { key: "age", variable: "age", label: "年龄（岁）", kind: "continuous", declaredText: "正态分布，均数 58、标准差 10", generatedText: "均数 58.2，标准差 9.8",
          histogram: { breaks: [20, 30, 40, 50, 60, 70, 80, 90], counts: [4, 11, 24, 31, 19, 8, 3] } },
        { key: "female", variable: "female", label: "女性", kind: "binary", declaredText: "二分类，取 1 的概率 45%", generatedText: "女性 44.6%", histogram: null,
          levels: [{ level: "1", label: "是", n: 446, percent: 44.6, suppressed: false }] },
        { key: "tumour", variable: "tumour", label: "肿瘤类型", kind: "categorical", declaredText: null, generatedText: "腺癌 62%，鳞癌 38%", histogram: null, missingText: "缺失 12 条（1.2%）" },
      ];
      raw.criteria = []; raw.attrition = []; raw.outcome = null; raw.unknownReasons = []; raw.blockers = []; raw.quality = null; raw.headline = null; raw.definition = null;
      raw.counts = { realPatients: null, events: null, effectiveSampleSize: null, generatedRecords: 1000, note: null, notes: {}, scope: null };
      raw.download = { path: "records/res_9.csv", rows: 1000 };
      return raw;
    };
    const serveGenerated = (patch: (raw: any) => void = () => undefined, overrides: Record<string, unknown> = {}) => {
      const raw = generated();
      patch(raw);
      installVcrServer(network.productRequest, { [tab("population")]: raw, ...overrides });
    };

    it("says what it is in one line — version, kind, how many records — with what it may be used for beside it", async () => {
      serveGenerated();
      const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
      const header = await found(container, "[data-vcr-population-header]");
      expect(header).toHaveTextContent("人群 v1 · 情景人群 · 1,000 条生成记录");
      expect(within(header).getByText("仅用于设计、可行性")).toBeInTheDocument();
      // A population is a result, so there is no counts band and no cohort funnel under it.
      expect(container.querySelector("[data-vcr-counts]")).toBeNull();
      expect(screen.queryByText("逐条筛选")).toBeNull();
    });

    it("sets what the study declared for each variable beside what came out, with the distribution's shape — and says when nothing was declared", async () => {
      serveGenerated();
      const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
      const table = await found(container, "[data-vcr-generated]");
      const age = table.querySelector("[data-vcr-variable='age']") as HTMLElement;
      expect(age).toHaveTextContent("年龄（岁）");
      expect(age).toHaveTextContent("正态分布，均数 58、标准差 10");
      expect(age).toHaveTextContent("均数 58.2，标准差 9.8");
      expect(age.querySelectorAll("[data-vcr-histogram] > span")).toHaveLength(7);
      expect(table.querySelector("[data-vcr-variable='female']")).toHaveTextContent("女性 44.6%");
      expect(table.querySelector("[data-vcr-variable='female'] [data-vcr-histogram]")).toBeNull();
      const tumour = table.querySelector("[data-vcr-variable='tumour']") as HTMLElement;
      expect(tumour).toHaveTextContent("按真实数据合成，没有设定的分布");
      expect(tumour).toHaveTextContent("缺失 12 条（1.2%）");
    });

    it("has two small cards: how it was made, constraint checks included, and what it may be used for — and says it is not a real patient", async () => {
      serveGenerated();
      draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
      const how = (await screen.findByText("怎么生成的")).closest("section") as HTMLElement;
      expect(how).toHaveTextContent("按设定的分布和相关性抽样。");
      expect(how).toHaveTextContent("约束“成年”没有记录违反。");
      expect(how).toHaveTextContent("约束“eGFR 下限”有 3 条记录违反。");
      const uses = screen.getByText("能用来做什么").closest("section") as HTMLElement;
      expect(uses).toHaveTextContent("可用于设计、可行性。它不是真实患者，不能当作外部对照或疗效证据。");
    });

    describe("the records", () => {
      let click: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        web.fetchWithWebAuth.mockReset();
        click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
        URL.createObjectURL = vi.fn(() => "blob:records");
        URL.revokeObjectURL = vi.fn();
      });

      it("downloads the CSV through the records route, under the file's own name", async () => {
        serveGenerated();
        web.fetchWithWebAuth.mockResolvedValue(new Response("a,b\n1,2\n", { status: 200, headers: { "content-disposition": 'attachment; filename="synthetic-population.csv"' } }));
        draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
        await userEvent.click(await screen.findByRole("button", { name: /下载记录（CSV）/ }));
        await waitFor(() => expect(click).toHaveBeenCalled());
        expect(String(web.fetchWithWebAuth.mock.calls[0][0])).toMatch(/\/vcr\/studies\/std_1\/records\/res_9\.csv$/);
        const anchor = click.mock.contexts[0] as HTMLAnchorElement;
        expect(anchor.download).toBe("synthetic-population.csv");
      });

      it("says why when the file may not leave — nothing is saved under its name", async () => {
        serveGenerated();
        web.fetchWithWebAuth.mockResolvedValue(new Response(JSON.stringify({ error: "x", code: "vcr_records_not_synthetic" }), { status: 403, headers: { "content-type": "application/json" } }));
        draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
        await userEvent.click(await screen.findByRole("button", { name: /下载记录（CSV）/ }));
        await waitFor(() => expect(toasts.error).toHaveBeenCalled());
        expect(click).not.toHaveBeenCalled();
      });

      it("offers no download where the server offered no records (a real cohort, or nothing computed yet)", async () => {
        serveGenerated((raw) => { raw.download = null; });
        draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
        await screen.findByText("怎么生成的");
        expect(screen.queryByRole("button", { name: /下载记录/ })).toBeNull();
      });
    });

    it("generates it again with the settings it has — one request, then the tab is read again", async () => {
      serveGenerated();
      draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
      await userEvent.click(await screen.findByRole("button", { name: "重新生成" }));
      await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/cards`, "POST", { kind: "population", regenerate: true }));
      expect(toasts.success).toHaveBeenCalledWith("已重新生成，结果算好后会显示在这里。");
      await waitFor(() => expect(gets("population")).toHaveLength(2));
    });

    it("says in one sentence that a population generated before profiles existed has none, and offers 重新生成 — it never shows half a table", async () => {
      serveGenerated((raw) => {
        raw.profile = []; raw.profileKind = null; raw.profileMissing = true;
        raw.profileNote = "这个人群生成时还没有画像：点“重新生成”，按同样的设定再生成一次，就能看到每个变量的分布。";
      });
      const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
      expect(await screen.findByText(/这个人群生成时还没有画像/)).toBeInTheDocument();
      expect(container.querySelector("[data-vcr-generated]")).toBeNull();
      expect(screen.getByRole("button", { name: "重新生成" })).toBeInTheDocument();
    });

    it("draws that sentence as a line under the header and not as a card — and the two cards that remain sit side by side", async () => {
      serveGenerated((raw) => {
        raw.profile = []; raw.profileKind = null; raw.profileMissing = true;
        raw.profileNote = "这个人群生成时还没有画像：点“重新生成”，按同样的设定再生成一次，就能看到每个变量的分布。";
      });
      const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
      const note = await found(container, "[data-vcr-profile-missing]");
      expect(note.closest(".rounded-card")).toBeNull();
      expect(note).toHaveAttribute("role", "status");
      const sides = note.nextElementSibling as HTMLElement;
      expect(sides.className).toContain("lg:grid-cols-2");
      expect(within(sides).getByText("怎么生成的")).toBeInTheDocument();
      expect(within(sides).getByText("能用来做什么")).toBeInTheDocument();
    });

    it("tells a reader who cannot write the same sentence, with no button of its own to press", async () => {
      serveGenerated((raw) => {
        raw.profile = []; raw.profileKind = null; raw.profileMissing = true;
        raw.profileNote = null;
      });
      const readOnly = fixture("ev201/study.json");
      readOnly.abilities = ["read"];
      draw(<PopulationTab studyId={STUDY_ID} study={readVcrStudy(readOnly)} />);
      expect(await screen.findByText(/这个人群生成时还没有画像/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "重新生成" })).toBeNull();
    });

    it("offers 改设定, which opens the numbers it was generated from and writes the next version with only what changed", async () => {
      serveGenerated(() => undefined, {
        [`GET /vcr/studies/${STUDY_ID}/cards?kind=population`]: {
          kind: "population", objectId: "pop_1", title: "人群设定",
          settings: [
            { path: "n", label: "生成记录数", value: 1000, unit: "条", integer: true, min: 1, max: null },
            { path: "population.variables.0.mean", label: "age 均数", value: 58, unit: null, integer: false, min: null, max: null },
          ],
        },
      });
      draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
      await userEvent.click(await screen.findByRole("button", { name: "改设定" }));
      const drawer = await screen.findByRole("dialog", { name: "改人群设定" });
      const records = await within(drawer).findByLabelText("生成记录数（条）");
      expect(records).toHaveValue(1000);
      expect(within(drawer).getByRole("button", { name: "保存" })).toBeDisabled();
      await userEvent.clear(records);
      await userEvent.type(records, "2000");
      await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/cards`, "POST", { kind: "population", set: { n: 2000 } }));
      expect(toasts.success).toHaveBeenCalledWith("已保存，依赖它的结果会重新计算。");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "改人群设定" })).toBeNull());
      await waitFor(() => expect(gets("population")).toHaveLength(2));
    });

    it("tells a typed value the engine's range would refuse in place, and sends nothing", async () => {
      serveGenerated(() => undefined, {
        [`GET /vcr/studies/${STUDY_ID}/cards?kind=population`]: {
          kind: "population", objectId: "pop_1", title: "人群设定",
          settings: [{ path: "n", label: "生成记录数", value: 1000, unit: "条", integer: true, min: 1, max: null }],
        },
      });
      draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
      await userEvent.click(await screen.findByRole("button", { name: "改设定" }));
      const drawer = await screen.findByRole("dialog", { name: "改人群设定" });
      const records = await within(drawer).findByLabelText("生成记录数（条）");
      await userEvent.clear(records);
      await userEvent.type(records, "0");
      expect(await within(drawer).findByText("不能小于 1")).toBeInTheDocument();
      expect(within(drawer).getByRole("button", { name: "保存" })).toBeDisabled();
      expect(network.productRequest.mock.calls.some(([path, method]) => String(path).endsWith("/cards") && method === "POST")).toBe(false);
    });

    it("shows a refusal of the engine's as the one sentence naming the setting, and keeps the drawer", async () => {
      serveGenerated(() => undefined, {
        [`GET /vcr/studies/${STUDY_ID}/cards?kind=population`]: {
          kind: "population", objectId: "pop_1", title: "人群设定",
          settings: [{ path: "population.variables.0.sd", label: "age 标准差", value: 10, unit: null, integer: false, min: null, max: null }],
        },
        [`POST /vcr/studies/${STUDY_ID}/cards`]: () => { throw new WebApiError("“age 标准差”这样填引擎不会接受，没有保存。", { status: 422, code: "vcr_card_edit_refused" }); },
      });
      draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
      await userEvent.click(await screen.findByRole("button", { name: "改设定" }));
      const drawer = await screen.findByRole("dialog", { name: "改人群设定" });
      const sd = await within(drawer).findByLabelText("age 标准差");
      await userEvent.clear(sd);
      await userEvent.type(sd, "12");
      await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
      expect(await within(drawer).findByRole("alert")).toHaveTextContent("“age 标准差”这样填引擎不会接受，没有保存。");
      expect(screen.getByRole("dialog", { name: "改人群设定" })).toBeInTheDocument();
    });

    it("offers a reader who cannot write the download and nothing that would be refused", async () => {
      serveGenerated();
      const raw = fixture("ev201/study.json");
      raw.abilities = ["read"];
      draw(<PopulationTab studyId={STUDY_ID} study={readVcrStudy(raw)} />);
      await screen.findByRole("button", { name: /下载记录（CSV）/ });
      expect(screen.queryByRole("button", { name: "重新生成" })).toBeNull();
      expect(screen.queryByRole("button", { name: "改设定" })).toBeNull();
    });
  });

  it("offers a real cohort's criteria numbers for editing, and writes the next protocol version with only what changed", async () => {
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}/cards?kind=criteria`]: {
        kind: "criteria", objectId: "prt_1", title: "入排条件",
        settings: [{ path: "0.requirement.value", label: "年龄 ≥ 18 岁 · 界值", value: 18, unit: null, integer: false, min: null, max: null }],
      },
    });
    draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    await userEvent.click(await screen.findByRole("button", { name: "改数值" }));
    const drawer = await screen.findByRole("dialog", { name: "改入排条件的数值" });
    const threshold = await within(drawer).findByLabelText("年龄 ≥ 18 岁 · 界值");
    await userEvent.clear(threshold);
    await userEvent.type(threshold, "20");
    await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/cards`, "POST", { kind: "criteria", set: { "0.requirement.value": 20 } }));
  });

  it("flags a covariate past the balance floor", async () => {
    draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    expect(await screen.findByRole("img", { name: /既往免疫治疗 标准化差异 0.31，超过界值/ })).toBeInTheDocument();
  });

  it("says the first sentence is missing on a study nobody has described — not that something is queued", async () => {
    draw(<PopulationTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />);
    expect(await screen.findByText(VCR_NO_DEFINITION)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "让 AI 做" })).toBeDisabled();
  });

  it("says a step that was asked for is arranged, and offers 让 AI 做 when nothing was asked", async () => {
    installVcrServer(network.productRequest, nothingIn("population"));
    const { unmount } = draw(<PopulationTab studyId={STUDY_ID} study={withStep("population", { status: "none", requested: true })} />);
    expect(await screen.findByText(VCR_STEP_QUEUED)).toBeInTheDocument();
    unmount();
    draw(<PopulationTab studyId={STUDY_ID} study={withStep("population", { status: "none", requested: false })} />);
    await userEvent.click(await screen.findByRole("button", { name: "让 AI 做" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "population" }));
  });
});

describe("虚拟患者", () => {
  it("says which model, its tier, the label its output has earned and how far it may be carried — never 数字孪生", async () => {
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const model = await found(container, "[data-vcr-model]");
    expect(within(model).getByText("文献模型")).toBeInTheDocument();
    expect(within(model).getByText("二线 NSCLC 多西他赛组 PFS · Weibull")).toBeInTheDocument();
    expect(model.querySelector("[data-vcr-twin]")).toHaveTextContent("基线条件化预测");
    expect(within(model).getByText("研究设计支持")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("数字孪生");
  });

  it("measures the tornado against the base case the result sent, and invents none without it", async () => {
    const { container, unmount } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const tornado = await found(container, "[data-vcr-tornado]");
    expect(tornado.querySelector("[data-vcr-tornado-base]")).not.toBeNull();
    expect(tornado).toHaveTextContent("基准0.41");
    unmount();

    const raw = fixture("ev201/patients.json");
    raw.sensitivity.base = null;
    installVcrServer(network.productRequest, { [tab("patients")]: raw });
    const again = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const bare = await found(again.container, "[data-vcr-tornado]");
    expect(bare.querySelector("[data-vcr-tornado-base]")).toBeNull();
    expect(bare.textContent).not.toContain("基准");
    // The bars are still the server's ranges.
    expect(within(bare).getByRole("img", { name: "目标 HR：0.33 到 0.49" })).toBeInTheDocument();
  });

  it("says the step did not finish, above the part it kept — and keeps showing that part", async () => {
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const failed = await found(container, "[data-vcr-step-failed='patients']");
    expect(within(failed).getByText("这一步未完成")).toBeInTheDocument();
    expect(failed.querySelector("[data-vcr-partial]")).toHaveTextContent("这次生成算完了 1,200 / 2,000 次重复就停下了，下面是已完成部分的结果。");
    expect(within(failed).getByRole("button", { name: "接着做" })).toBeInTheDocument();
    // The data are still there, under it.
    const example = screen.getByText("VP-0412");
    expect(failed.compareDocumentPosition(example) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("这次运行的结果")).toBeInTheDocument();
    expect(container.querySelector("[data-vcr-counts]")).toBeNull();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
  });

  it("draws a model's output as a thin dashed mean, with a band only where the band has a name", async () => {
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const treatment = await found(container, "[data-vcr-series='treatment']");
    expect(treatment.querySelector("[data-vcr-band='prediction']")).not.toBeNull();
    expect(treatment.querySelector("[data-vcr-series-line]")?.getAttribute("stroke-dasharray")).toBeTruthy();
    // Both scenarios name their spread (a prediction interval, at 80%), so both bands are drawn ...
    const control = container.querySelector("[data-vcr-series='control']") as SVGElement;
    expect(control.querySelector("[data-vcr-band='prediction']")).not.toBeNull();
    // ... and the legend names it from the data, level included, once.
    expect(container.querySelectorAll("[data-vcr-legend-band]")).toHaveLength(1);
    expect(container.querySelector("[data-vcr-legend-band]")).toHaveTextContent("80% 预测区间");
  });

  it("draws a spread nobody named as no band at all: an unnamed range is not an interval", async () => {
    const raw = fixture("ev201/patients.json");
    for (const line of raw.trajectories.series) { line.bandKind = null; line.bandLevel = null; }
    installVcrServer(network.productRequest, { [tab("patients")]: raw });
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    await found(container, "[data-vcr-series='control']");
    expect(container.querySelector("[data-vcr-band]")).toBeNull();
    expect(container.querySelector("[data-vcr-legend-band]")).toBeNull();
  });

  it("prints what two scenarios of one patient are whenever they are drawn, and shades what nobody could observe", async () => {
    const raw = fixture("ev201/patients.json");
    const series = raw.trajectories.series;
    raw.example.scenarios = { note: null, difference: "12 个月差 0.23", series };
    raw.trajectories.series[1].unobserved = [{ from: 6, to: 12 }];
    installVcrServer(network.productRequest, { [tab("patients")]: raw });
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const scenarios = await found(container, "[data-vcr-scenarios]");
    expect(scenarios.querySelector("[data-vcr-counterfactual]")).toHaveTextContent(VCR_COUNTERFACTUAL_SENTENCE);
    // Said once, even though the server's note says the same.
    expect(screen.getAllByText(VCR_COUNTERFACTUAL_SENTENCE)).toHaveLength(1);
    expect(container.querySelector("[data-vcr-unobserved]")).not.toBeNull();
    expect(screen.getAllByText("未观察时段").length).toBeGreaterThan(0);
  });

  it("puts the result above what it was made with: the headline and the charts first, the model and its assessment after", async () => {
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const model = await found(container, "[data-vcr-model]");
    const chart = container.querySelector("[data-vcr-series]") as Element;
    expect(chart.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(model).not.toHaveTextContent("1.2");
  });

  it("says the first sentence is missing on a study nobody has described", async () => {
    draw(<PatientsTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />);
    expect(await screen.findByText(VCR_NO_DEFINITION)).toBeInTheDocument();
  });
});

describe("对照", () => {
  it("rates all ten comparability dimensions, each with its own word and reason", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const table = await found(container, "[data-vcr-dimensions]");
    expect(within(table.closest("section") as HTMLElement).getByText("可比性逐项评估")).toBeInTheDocument();
    expect(table.querySelectorAll("[data-vcr-dimension]")).toHaveLength(10);
    const period = table.querySelector("[data-vcr-dimension='time_period']") as HTMLElement;
    expect(period).toHaveTextContent("近似");
    expect(period).toHaveTextContent("来源试验早于 2020 年");
    expect(table.querySelector("[data-vcr-dimension='geography']")).toHaveTextContent("精确模拟");
    expect(table.querySelector("[data-vcr-dimension='diagnosis']")).toHaveTextContent("未评估");
  });

  it("says in one sentence, over the ten dimensions, that none of them has been assessed — and says nothing when some have", async () => {
    const raw = fixture("ev201/comparator.json");
    raw.dimensions = raw.dimensions.map((dimension: any) => ({ ...dimension, state: "unknown", reason: null }));
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const note = await found(container, "[data-vcr-dimensions-unassessed]");
    expect(note).toHaveTextContent("十个维度都还没有评估。上面的“可估计”只表示在设定的输入下能算出来，不表示真实人群与对照可比。");
    expect(note.nextElementSibling?.matches("[data-vcr-dimensions]")).toBe(true);
  });

  it("does not say it when some dimension was assessed", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    await found(container, "[data-vcr-dimensions]");
    expect(container.querySelector("[data-vcr-dimensions-unassessed]")).toBeNull();
  });

  it("puts a borrowed prior's numbers in a card of its own, with what a prior effective sample size is — apart from the weights", async () => {
    const raw = fixture("ev201/comparator.json");
    const row = (key: string, label: string, value: number) => ({ key, label, value: { value, text: null, unit: "例", source: "calculated", interval: null, mcse: null, review: "ai_set", precision: null, reason: null, stale: false, detail: null } });
    raw.prior = [row("prior_effective_sample_size_moment", "先验有效样本量（矩法）", 79.2), row("prior_effective_sample_size_elir", "先验有效样本量（ELIR）", 59.4)];
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const prior = await found(container, "[data-vcr-prior]");
    const card = prior.closest("section") as HTMLElement;
    expect(within(card).getByText("先验借用")).toBeInTheDocument();
    expect(prior).toHaveTextContent("先验有效样本量（矩法）");
    expect(prior).toHaveTextContent("先验有效样本量（ELIR）");
    expect(within(card).getByText("先验有效样本量说的是这个先验相当于多少例本研究患者的信息量；“矩法”和“ELIR”是两种算法，同一个先验会得到不同的数。")).toBeInTheDocument();
    // The weights' card holds the weights and not the prior.
    const weights = (container.querySelector("[data-vcr-diagnostics]") as HTMLElement);
    expect(weights).not.toHaveTextContent("先验");
    expect(weights.closest("section")).not.toBe(card);
  });

  it("draws no prior card when no route borrowed one", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    await found(container, "[data-vcr-diagnostics]");
    expect(container.querySelector("[data-vcr-prior]")).toBeNull();
    expect(screen.queryByText("先验借用")).toBeNull();
  });

  it("writes the external control as a not-estimable card with its gaps, while another route is the selected one", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const card = await found(container, "[data-vcr-not-estimable]");
    expect(within(card).getByText("真实外部对照：不可估计")).toBeInTheDocument();
    expect(within(card).getByText("缺 3 项数据")).toBeInTheDocument();
    expect(within(card).getByText("ECOG 缺失 38%")).toBeInTheDocument();
    expect(within(card).getByText("把 ECOG 纳入熵平衡")).toBeInTheDocument();
    expect(within(card).getByText("判定依据：加权后有效样本量低于下限")).toBeInTheDocument();
    expect(container.querySelector("[data-vcr-route='literature_control']")?.className).toContain("bg-accent-soft");
    expect(container.querySelector("[data-vcr-route='external_control']")).toHaveTextContent("缺 3 项数据，见下方清单");
  });

  it("names the four routes this version computes, in plan order, with the state each has at this tier", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    await screen.findByText("对照路线");
    const routes = [...container.querySelectorAll("[data-vcr-route]")].map((node) => node.getAttribute("data-vcr-route"));
    // the model-prediction comparator is not computed by this version: the server does not offer it as a route (it is listed as 暂不支持 in the method library)
    expect(routes).toEqual(["prognostic_adjustment", "external_control", "literature_control", "hybrid_control"]);
    expect(container.querySelector("[data-vcr-route='prognostic_adjustment']")).toHaveTextContent("不适用");
    expect(container.querySelector("[data-vcr-route='prognostic_adjustment']")).toHaveTextContent("需要 T3 随机试验个体数据");
  });

  it("puts the weight diagnostics and the balance before and after weighting on the page", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const diagnostics = await found(container, "[data-vcr-diagnostics]");
    expect(within(diagnostics.closest("section") as HTMLElement).getByText("权重与重叠诊断")).toBeInTheDocument();
    expect(within(diagnostics).getByText("重叠系数").closest("div")).toHaveTextContent("0.82");
    expect(within(diagnostics).getByText("最大权重").closest("div")).toHaveTextContent("6.2");
    const balance = container.querySelector("[data-vcr-balance-row='既往免疫治疗']") as HTMLElement;
    expect(balance.querySelector("[data-vcr-smd-before]")).toHaveTextContent("0.42");
    expect(balance).toHaveTextContent("0.31");
    expect(screen.getByText("加权前 |SMD|")).toBeInTheDocument();
  });

  it("draws a reconstructed curve dashed, always, and a curve of any other source by its own rule", async () => {
    const { container, unmount } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const s1 = await found(container, "[data-vcr-curve='s1']");
    expect(s1.getAttribute("data-vcr-curve-source")).toBe("reconstructed");
    expect(s1.getAttribute("stroke-dasharray")).toBe("3 3");
    expect(container.querySelector("[data-vcr-curve='pooled']")?.getAttribute("stroke-dasharray")).toBe("5 3");
    expect(screen.getByText("虚线为从已发表图表重建的伪个体数据，不是观察到的曲线。")).toBeInTheDocument();
    unmount();

    const raw = fixture("ev201/comparator.json");
    raw.curves[0].source = "observed";
    raw.curves[1].source = "assumed";
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const again = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const observed = await found(again.container, "[data-vcr-curve='s1']");
    // Solid is earned by an observation, and only by one.
    expect(observed.getAttribute("stroke-dasharray")).toBeNull();
    expect(again.container.querySelector("[data-vcr-curve='pooled']")?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(again.container.querySelector("[data-vcr-legend='pooled']")).toHaveTextContent("假设");
  });

  it("has no counts band of its own: the four numbers are on 总览", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    await found(container, "[data-vcr-diagnostics]");
    expect(container.querySelector("[data-vcr-counts]")).toBeNull();
  });

  it("says the method's conclusion and the review state apart", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const verdict = await found(container, "[data-vcr-verdict]");
    expect(verdict).toHaveTextContent("有限制地估计");
    expect(verdict).toHaveTextContent("AI 设定");
    expect(verdict).toHaveTextContent("未复核");
  });

  it("prints 1.04 as 1.04, not as 1.0", async () => {
    const raw = fixture("ev201/comparator.json");
    raw.diagnostics[1].value.value = 1.04;
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const diagnostics = await found(container, "[data-vcr-diagnostics]");
    expect(within(diagnostics).getByText("最大权重").closest("div")).toHaveTextContent("1.04");
  });

  it("lists the robustness numbers and says beside them that no regulator has qualified a prognostic adjustment, and that an analysis could not be computed", async () => {
    const raw = fixture("ev201/comparator.json");
    const value = (n: number) => ({ ...raw.diagnostics[1].value, value: n, interval: null, mcse: null, unit: null });
    raw.robustness = {
      rows: [{ key: "marginal_risk_difference", label: "边际风险差", value: value(0.11) }, { key: "marginal_odds_ratio", label: "边际比值比（OR）", value: value(1.9) }],
      notes: ["阴性对照结局没有算出：没有一个阴性对照结局能得出估计"],
      qualification: "二分类和事件时间终点的预后协变量调整，目前没有监管机构认可：EMA 2022 年的资格认定意见只覆盖连续终点。",
    };
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const rows = await found(container, "[data-vcr-robustness]");
    expect(within(rows.closest("section") as HTMLElement).getByText("稳健性与预后校正分析")).toBeInTheDocument();
    expect(within(rows).getByText("边际风险差").closest("div")).toHaveTextContent("0.11");
    expect(within(rows).getByText("边际比值比（OR）").closest("div")).toHaveTextContent("1.9");
    const sentence = within(rows.closest("section") as HTMLElement).getByText(/目前没有监管机构认可/);
    expect(sentence).toHaveAttribute("data-vcr-qualification");
    expect(sentence.closest("section")).toBe(rows.closest("section"));
    expect(screen.getByText("阴性对照结局没有算出：没有一个阴性对照结局能得出估计")).toBeInTheDocument();
  });

  it("has no robustness section when the study declared none", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    await found(container, "[data-vcr-diagnostics]");
    expect(container.querySelector("[data-vcr-robustness]")).toBeNull();
    expect(screen.queryByText("稳健性与预后校正分析")).toBeNull();
  });

  it("says the first sentence is missing on a study nobody has described, not a rail of routes nobody ran", async () => {
    const { container } = draw(<ComparatorTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />);
    expect(await screen.findByText(VCR_NO_DEFINITION)).toBeInTheDocument();
    expect(container.querySelector("[data-vcr-route]")).toBeNull();
  });
});

describe("试验", () => {
  it("lists every design, greys the dominated one with the server's own sentence and no numbers", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const codes = [...container.querySelectorAll("tr[data-vcr-design]")].map((row) => row.getAttribute("data-vcr-design"));
    expect(codes).toEqual(["A", "B", "C", "D"]);
    const d = container.querySelector("tr[data-vcr-design='D']") as HTMLElement;
    expect(d).toHaveAttribute("data-vcr-dominated");
    expect(d.querySelector("[data-vcr-dominated-note]")).toHaveTextContent("在比较目标的全部指标上都不优于 C");
    expect(d.querySelectorAll("[data-vcr-measure]")).toHaveLength(0);
    expect(d.textContent).not.toContain("%");
  });

  describe("designs nothing has computed", () => {
    /** The conversation wrote the scenarios and the engine has not finished: designs with their configured size and cost, no measure of a result. */
    const written = (names: string[] = ["A", "B", "C", "D"]) => {
      const raw = fixture("ev201/trial.json");
      raw.designs = raw.designs.filter((design: any) => names.includes(design.code)).map((design: any) => ({
        ...design, dominated: false, dominatedBy: null, chosen: false,
        measures: Object.fromEntries(Object.entries(design.measures).filter(([key]) => key === "sample_size" || key === "cost")),
      }));
      raw.columns = raw.columns.filter((column: any) => column.key === "sample_size" || column.key === "cost");
      raw.headline = null; raw.decision = null; raw.footnotes = []; raw.grid = null; raw.powerCurve = null; raw.forecasts = []; raw.milestones = []; raw.ademp = []; raw.partial = null; raw.stale = null;
      return raw;
    };

    it("is a list with 「还没算」 on each design and the step's own state under it — no table, no metric column, and never 选定方案", async () => {
      installVcrServer(network.productRequest, { [tab("trial")]: written() });
      const { container } = draw(<TrialTab studyId={STUDY_ID} study={withStep("trial", { status: "none", requested: false })} />);
      const list = await found(container, "[data-vcr-not-computed]");
      expect(screen.queryByRole("table", { name: "方案的对比" })).toBeNull();
      const rows = [...list.querySelectorAll("li[data-vcr-design]")];
      expect(rows.map((row) => row.getAttribute("data-vcr-design"))).toEqual(["A", "B", "C", "D"]);
      for (const row of rows) expect(row).toHaveTextContent("还没算");
      // The state is a sentence and the way to start it, not a form.
      expect(within(list).getByRole("button", { name: "让 AI 做" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /选定方案|改选方案/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "登记预测" })).toBeNull();
      // What the conversation does stays: another design, another hypothesis.
      expect(screen.getByRole("button", { name: "加一个方案" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "改假设" })).toBeInTheDocument();
    });

    it("says the computation is under way while it is, and offers nothing to start", async () => {
      installVcrServer(network.productRequest, { [tab("trial")]: written() });
      const { container } = draw(<TrialTab studyId={STUDY_ID} study={withStep("trial", { status: "running" })} />);
      const list = await found(container, "[data-vcr-not-computed]");
      expect(within(list).getByText("正在进行，做完会显示在这里。")).toBeInTheDocument();
      expect(within(list).queryByRole("button")).toBeNull();
    });

    it("says a step that did not finish once, on top with 接着做 — and does not say it again under the list", async () => {
      installVcrServer(network.productRequest, { [tab("trial")]: written() });
      const { container } = draw(<TrialTab studyId={STUDY_ID} study={withStep("trial", { status: "failed", note: "计算时间用完了" })} />);
      const list = await found(container, "[data-vcr-not-computed]");
      expect(container.querySelectorAll("[data-vcr-step-failed]")).toHaveLength(1);
      expect(list.querySelector("[data-vcr-step-failed]")).toBeNull();
      expect(screen.getAllByRole("button", { name: "接着做" })).toHaveLength(1);
    });

    it("offers no conclusion box to a reader who cannot write when there is nothing to conclude", async () => {
      const raw = written();
      installVcrServer(network.productRequest, { [tab("trial")]: raw });
      const reader = fixture("ev201/study.json");
      reader.abilities = ["read"];
      reader.steps.trial = { status: "none", requested: false };
      const { container } = draw(<TrialTab studyId={STUDY_ID} study={readVcrStudy(reader)} />);
      await found(container, "[data-vcr-not-computed]");
      expect(container.querySelector("[data-vcr-conclusion]")).toBeNull();
    });

    it("keeps the table when some designs ran: the unrun rows say 「还没算」 where the numbers would be, and cannot be chosen", async () => {
      const raw = fixture("ev201/trial.json");
      // Design C has been written and not computed.
      raw.designs[2].measures = Object.fromEntries(Object.entries(raw.designs[2].measures).filter(([key]) => key === "sample_size" || key === "cost"));
      installVcrServer(network.productRequest, { [tab("trial")]: raw });
      const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
      await trialDrawn();
      expect(container.querySelector("[data-vcr-not-computed]")).toBeNull();
      const c = container.querySelector("tr[data-vcr-design='C']") as HTMLElement;
      expect(c.querySelector("[data-vcr-measure='power']")).toBeNull();
      expect(c.querySelectorAll("[data-vcr-not-run]").length).toBeGreaterThan(0);
      expect(c).toHaveTextContent("还没算");
      // A design that ran with no value in one column is 「—」, not 「还没算」.
      expect(container.querySelector("tr[data-vcr-design='A']")).not.toHaveTextContent("还没算");
      await userEvent.click(screen.getByRole("button", { name: /选定方案|改选方案/ }));
      const drawer = await screen.findByRole("dialog");
      expect(within(drawer).getByRole("radio", { name: "C" })).toBeDisabled();
      expect(within(drawer).getByRole("radio", { name: "A" })).toBeEnabled();
    });
  });

  it("puts a Monte-Carlo error beside every simulated number in the grid", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const simulated = [...container.querySelectorAll("tr[data-vcr-design] [data-vcr-measure][data-vcr-source='predicted']")];
    // Prove the walk walked: A has four simulated measures, B and C five each
    // (sample size and cost are set, not simulated).
    expect(simulated).toHaveLength(14);
    for (const cell of simulated) expect(cell.querySelector("[data-vcr-mcse]")).not.toBeNull();
    const b = container.querySelector("tr[data-vcr-design='B'] [data-vcr-measure='assurance']") as HTMLElement;
    expect(b).toHaveTextContent("71.0");
    expect(b.querySelector("[data-vcr-mcse]")).toHaveTextContent("±0.40");
  });

  it("names the prediction interval under the last-patient-in cell, and writes no bare 区间", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const duration = container.querySelector("tr[data-vcr-design='B'] [data-vcr-measure='duration_months']") as HTMLElement;
    expect(duration.querySelector("[data-vcr-interval]")).toHaveTextContent("80% 预测区间 13.90–19.30");
    expect(container.querySelector("tr[data-vcr-design='B'] [data-vcr-measure='cost']")).toHaveTextContent("3,900");
    expect(screen.getByText("成本（万元）")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(BARE_INTERVAL);
  });

  it("keeps the error and the cost's unit on the trade-off scatter's labels", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    const label = await found(container, "[data-vcr-scatter-label='C']");
    expect(label).toHaveTextContent("74.0%");
    expect(label).toHaveTextContent("±0.40");
    expect(label).toHaveTextContent("4,600 万元");
  });

  it("draws each design's last patient in as a point inside its named prediction interval", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    const timeline = await found(container, "[data-vcr-milestones]");
    expect([...timeline.querySelectorAll("[data-vcr-milestone]")].map((row) => row.getAttribute("data-vcr-milestone"))).toEqual(["A", "B", "C"]);
    const b = timeline.querySelector("[data-vcr-milestone='B']") as HTMLElement;
    expect(b).toHaveTextContent("末例入组");
    expect(b).toHaveTextContent("16.40");
    expect(b).toHaveTextContent("80% 预测区间 13.90–19.30");
  });

  it("keeps the registry out of the page: 登记预测 opens it in a drawer, where each forecast shows its freezing time — no hash, no version — and, once there is one, the actual beside it", async () => {
    const { container, unmount } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    // Neither the list nor a form stands under the results: they are behind one button in the action row.
    expect(container.querySelector("[data-vcr-forecast]")).toBeNull();
    expect(container.querySelector("[data-vcr-file-prediction]")).toBeNull();
    const conclusion = container.querySelector("[data-vcr-conclusion]") as HTMLElement;
    await userEvent.click(within(conclusion).getByRole("button", { name: "登记预测" }));
    const drawer = await screen.findByRole("dialog", { name: "登记预测" });
    const forecast = drawer.querySelector("[data-vcr-forecast='fct_1']") as HTMLElement;
    expect(forecast).toHaveTextContent("入组预测");
    expect(forecast.querySelector("[data-vcr-forecast-hash]")).toBeNull();
    expect(forecast.textContent).not.toMatch(/哈希|HASH|\bv\d+\b|fct_/);
    expect(forecast).toHaveTextContent("冻结于 今天 09:07");
    expect(forecast.querySelector("[data-vcr-forecast-line='last_patient_in_months']")).toHaveTextContent("14.2 个月");
    expect(within(forecast).queryByText("实际")).not.toBeInTheDocument();
    // Nobody here may file (only the lead may, and only where there is a registry): the drawer is the list and nothing else.
    expect(within(drawer).queryByRole("tab")).toBeNull();
    expect(within(drawer).queryByLabelText("试验登记号")).toBeNull();
    unmount();

    const raw = fixture("ev201/trial.json");
    raw.forecasts[0].lines[0].actual = "15.1 个月";
    raw.forecasts[0].comparedAt = "今天 12:00";
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const again = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    await userEvent.click(within(again.container.querySelector("[data-vcr-conclusion]") as HTMLElement).getByRole("button", { name: "登记预测" }));
    const compared = (await screen.findByRole("dialog", { name: "登记预测" })).querySelector("[data-vcr-forecast='fct_1']") as HTMLElement;
    expect(within(compared).getByText("实际")).toBeInTheDocument();
    expect(compared.querySelector("[data-vcr-forecast-line='last_patient_in_months']")).toHaveTextContent("14.2 个月15.1 个月");
    expect(compared).toHaveTextContent("与实际对照于 今天 12:00");
  });

  it("gives the lead the registered list and the form as the drawer's two tabs, files from the engine's own result, and shows what was filed", async () => {
    const lead = ev201();
    lead.features = { simulations: false, predictions: true, platformPacks: false };
    lead.abilities = [...lead.abilities, "manage_study"];
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={lead} />);
    await trialDrawn();
    await userEvent.click(within(container.querySelector("[data-vcr-conclusion]") as HTMLElement).getByRole("button", { name: "登记预测" }));
    const drawer = await screen.findByRole("dialog", { name: "登记预测" });
    // Registered first, because something is: the tab list says how many.
    expect(within(drawer).getByRole("tab", { name: /已登记/, selected: true })).toBeInTheDocument();
    expect(drawer.querySelector("[data-vcr-forecast='fct_1']")).toHaveTextContent("入组预测");
    await userEvent.click(within(drawer).getByRole("tab", { name: "新登记" }));
    const filing = drawer.querySelector("[data-vcr-file-prediction]") as HTMLElement;
    expect(within(filing).getByLabelText("方案")).toBeInTheDocument();
    expect(within(filing).getByLabelText("预测的指标")).toBeInTheDocument();
    const file = within(filing).getByRole("button", { name: "登记预测" });
    expect(file).toBeDisabled();
    await userEvent.type(within(filing).getByLabelText("试验登记号"), "NCT02296125");
    await userEvent.type(within(filing).getByLabelText("主要终点"), "总生存期");
    await userEvent.click(file);
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/predictions`, "POST",
      expect.objectContaining({ registryId: "NCT02296125", endpoint: "总生存期", resultPath: expect.stringMatching(/^measure\(/) })));
    expect(toasts.success).toHaveBeenCalledWith("已登记预测。");
    // The trial is read again so the new forecast is in the list, and the drawer goes back to what has been registered.
    await waitFor(() => expect(gets("trial").length).toBeGreaterThan(1));
    await waitFor(() => expect(within(drawer).getByRole("tab", { name: /已登记/, selected: true })).toBeInTheDocument());
  });

  it("opens the lead's drawer on the form when nothing has been registered yet, and offers no button to a reader with nothing to see or file", async () => {
    const raw = fixture("ev201/trial.json");
    raw.forecasts = [];
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const lead = ev201();
    lead.features = { simulations: false, predictions: true, platformPacks: false };
    lead.abilities = [...lead.abilities, "manage_study"];
    const first = draw(<TrialTab studyId={STUDY_ID} study={lead} />);
    await trialDrawn();
    await userEvent.click(within(first.container.querySelector("[data-vcr-conclusion]") as HTMLElement).getByRole("button", { name: "登记预测" }));
    const drawer = await screen.findByRole("dialog", { name: "登记预测" });
    expect(within(drawer).queryByRole("tab")).toBeNull();
    expect(within(drawer).getByLabelText("试验登记号")).toBeInTheDocument();
    first.unmount();

    // A reader who may not file, and nothing filed: no button at all — it would open an empty drawer.
    const reader = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    expect(within(reader.container.querySelector("[data-vcr-conclusion]") as HTMLElement).queryByRole("button", { name: "登记预测" })).toBeNull();
  });

  it("says a stopped computation once, over the part that is there — one Chinese sentence and 续算, not a second box and the engine's English", async () => {
    const raw = fixture("ev201/trial.json");
    raw.partial = { sentence: "这次模拟算完了 18,000 / 20,000 次重复就到了计算时间上限，下面是已完成部分的结果。" };
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const notes = container.querySelectorAll("[data-vcr-partial]");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent("这次模拟算完了 18,000 / 20,000 次重复就到了计算时间上限，下面是已完成部分的结果。");
    expect(container.querySelector("[data-vcr-step-failed]")).toBeNull();
    await userEvent.click(within(notes[0] as HTMLElement).getByRole("button", { name: "续算" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "trial" }));
  });

  it("highlights only the design a recorded decision chose, says so under the conclusion, and starts 改选方案 from that record", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const ours = [...container.querySelectorAll("tr[data-row-ours]")].map((row) => row.getAttribute("data-vcr-design"));
    expect(ours).toEqual(["B"]);
    expect(container.querySelector("[data-vcr-decided]")).toHaveTextContent("已选定：B，理由：成功把握与样本量的折中；方案 C 周期更长。");
    // The decision form is behind the button, not a card under the table.
    expect(screen.queryByLabelText("比较目标")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "改选方案" }));
    const drawer = await screen.findByRole("dialog", { name: "选定方案" });
    expect(within(drawer).getByLabelText("比较目标")).toHaveValue("在成功把握尽量高、样本量尽量少的目标下选哪个方案");
    expect(within(drawer).getByRole("radio", { name: "B" })).toBeChecked();
    expect(within(drawer).getByLabelText("选择理由")).toHaveValue("成功把握与样本量的折中；方案 C 周期更长。");
    expect(within(drawer).getByText("平台不自动选定方案。")).toBeInTheDocument();
    expect(within(drawer).getByText("上次记录于 今天 09:07")).toBeInTheDocument();
  });

  it("is a conclusion, three things to do about it, and the table of designs — in that order", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const conclusion = container.querySelector("[data-vcr-conclusion]") as HTMLElement;
    expect(within(conclusion).getByRole("button", { name: "改选方案" })).toBeInTheDocument();
    expect(within(conclusion).getByRole("button", { name: "加一个方案" })).toBeInTheDocument();
    expect(within(conclusion).getByRole("button", { name: "改假设" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "方案的对比" });
    expect(conclusion.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The setup of the simulation is folded under the table, in words — no letters, no jargon tag — and opens on one click.
    const setup = container.querySelector("[data-vcr-setup]") as HTMLElement;
    expect(table.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(setup.closest("details")).not.toHaveAttribute("open");
    expect(within(setup.closest("details") as HTMLElement).getByText("模拟设定")).toBeInTheDocument();
    expect(setup.textContent).not.toMatch(/ADEMP/);
    expect(screen.queryByText("ADEMP")).toBeNull();
  });

  it("offers 选定方案 as the one primary action while nothing has been chosen, and 改选方案 once something is", async () => {
    const raw = fixture("ev201/trial.json");
    raw.decision = null;
    for (const design of raw.designs) design.chosen = false;
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    expect(screen.getByRole("button", { name: "选定方案" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "改选方案" })).toBeNull();
    expect(document.querySelector("[data-vcr-decided]")).toBeNull();
  });

  it("puts a draft in the conversation for 加一个方案 and for 改假设 — and does not send it", async () => {
    draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    await userEvent.click(screen.getByRole("button", { name: "加一个方案" }));
    await waitFor(() => expect(store.select).toHaveBeenCalledWith("prj_ev201", expect.any(Function)));
    expect(network.productRequest.mock.calls.some(([path, method]) => method === "POST" && String(path).includes("/run"))).toBe(false);
  });

  it("offers none of the three to a reader who cannot write, and no 改设定 either", async () => {
    const raw = fixture("ev201/study.json");
    raw.abilities = ["read"];
    draw(<TrialTab studyId={STUDY_ID} study={readVcrStudy(raw)} />);
    await trialDrawn();
    for (const name of ["选定方案", "改选方案", "加一个方案", "改假设", "改设定"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${name}`) })).toBeNull();
    }
    // What was decided is still said.
    expect(document.querySelector("[data-vcr-decided]")).not.toBeNull();
  });

  it("writes nothing until a goal is written and a design chosen, then posts the exact decision and re-reads", async () => {
    const raw = fixture("ev201/trial.json");
    raw.decision = null;
    for (const design of raw.designs) design.chosen = false;
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    await userEvent.click(screen.getByRole("button", { name: "选定方案" }));
    const drawer = await screen.findByRole("dialog", { name: "选定方案" });
    const save = within(drawer).getByRole("button", { name: "写入决策记录" });
    expect(save).toBeDisabled();
    // Nobody chose: every design is a grey.
    expect(container.querySelectorAll("tr[data-row-ours]")).toHaveLength(0);
    expect(within(drawer).getByRole("radio", { name: "D" })).toBeDisabled();

    await userEvent.click(within(drawer).getByRole("radio", { name: "B" }));
    expect(save).toBeDisabled();
    // Choosing in the form is not a recorded decision: still no brand.
    expect(container.querySelectorAll("tr[data-row-ours]")).toHaveLength(0);

    await userEvent.type(within(drawer).getByLabelText("比较目标"), "成功把握不低于 70%");
    expect(save).toBeEnabled();
    await userEvent.type(within(drawer).getByLabelText("选择理由"), "样本量更少");
    await userEvent.click(save);

    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/decisions`, "POST", {
      question: "成功把握不低于 70%",
      chosen: { id: "scn_2", code: "B", label: "方案 B 2:1 随机" },
      alternatives: [{ code: "A", label: "方案 A 单臂 + 文献对照" }, { code: "C", label: "方案 C 1:1 随机 + 一次期中分析" }],
      rationale: "样本量更少",
    }));
    expect(toasts.success).toHaveBeenCalledWith("已写入决策记录。");
    // The tab is read again, so the highlight comes back from the server, and the form is closed.
    await waitFor(() => expect(gets("trial")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "选定方案" })).toBeNull());
  });

  it("sends one decision while the first is still being written", async () => {
    let release: (value: unknown) => void = () => {};
    installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/decisions`]: () => new Promise((resolve) => { release = resolve; }),
    });
    draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    await userEvent.click(screen.getByRole("button", { name: "改选方案" }));
    const save = within(await screen.findByRole("dialog", { name: "选定方案" })).getByRole("button", { name: "写入决策记录" });
    await userEvent.click(save);
    await userEvent.click(save);
    expect(network.productRequest.mock.calls.filter(([path, method]) => String(path).endsWith("/decisions") && method === "POST")).toHaveLength(1);
    expect(save).toBeDisabled();
    release({});
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
  });

  it("keeps a stale result on screen under its bar, and leaves what a reader does about it usable", async () => {
    const raw = fixture("ev201/trial.json");
    raw.stale = { reason: "假设卡已变更", queued: false, since: null };
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    expect(container.querySelector("[data-vcr-stale]")).toHaveTextContent("假设卡已变更 · 输入已变更，这些数字可能已过期");
    const greyed = container.querySelector("[data-vcr-stale-block] .opacity-disabled") as HTMLElement;
    expect(greyed.querySelector("tr[data-vcr-design='B']")).not.toBeNull();
    // The buttons are not under the grey.
    expect(greyed.querySelector("[data-vcr-conclusion]")).toBeNull();
    expect(screen.getByRole("button", { name: "改选方案" })).toBeEnabled();
  });

  it("has no counts band of its own: the four numbers are on 总览", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    expect(container.querySelector("[data-vcr-counts]")).toBeNull();
  });

  describe("the comparison", () => {
    it("shows how many replicates the simulation ran and what each number comes from, for the designs that have them", async () => {
      const raw = fixture("ev201/trial.json");
      raw.designs[1].replicates = 5000;
      raw.designs[1].method = "解析 + 模拟";
      raw.designs[2].replicates = 3000;
      raw.designs[2].method = "模拟";
      installVcrServer(network.productRequest, { [tab("trial")]: raw });
      const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
      await trialDrawn();
      expect(screen.getByRole("columnheader", { name: "模拟次数" })).toBeInTheDocument();
      expect(container.querySelector("tr[data-vcr-design='B'] [data-vcr-replicates]")).toHaveTextContent("5,000");
      expect(container.querySelector("tr[data-vcr-design='B'] [data-vcr-method]")).toHaveTextContent("解析 + 模拟");
      expect(container.querySelector("tr[data-vcr-design='C'] [data-vcr-method]")).toHaveTextContent("模拟");
    });

    it("draws neither column where nobody has the number", async () => {
      const raw = fixture("ev201/trial.json");
      for (const design of raw.designs) { design.replicates = null; design.method = null; }
      installVcrServer(network.productRequest, { [tab("trial")]: raw });
      draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
      await trialDrawn();
      expect(screen.queryByRole("columnheader", { name: "模拟次数" })).toBeNull();
      expect(screen.queryByRole("columnheader", { name: "来源" })).toBeNull();
    });

    it("says what ± is and that a number opens what it was made from, once, under the table", async () => {
      draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
      await trialDrawn();
      expect(screen.getByText("功效后的 ± 是蒙特卡洛标准误。点任一个数，看它用了哪些假设、哪次运行。")).toBeInTheDocument();
    });

    it("opens a design's numbers for editing from its own row — written as that design's next version", async () => {
      installVcrServer(network.productRequest, {
        [`GET /vcr/studies/${STUDY_ID}/cards?kind=trial_scenario&object=scn_2`]: {
          kind: "trial_scenario", objectId: "scn_2", title: "B",
          settings: [{ path: "design.nTreat", label: "试验组人数", value: 400, unit: "人", integer: true, min: 1, max: null }],
        },
      });
      draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
      await trialDrawn();
      await userEvent.click(screen.getByRole("button", { name: "改设定：方案 B" }));
      const drawer = await screen.findByRole("dialog", { name: /改设定：B/ });
      const field = await within(drawer).findByLabelText("试验组人数（人）");
      await userEvent.clear(field);
      await userEvent.type(field, "450");
      await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/cards`, "POST",
        { kind: "trial_scenario", objectId: "scn_2", set: { "design.nTreat": 450 } }));
      await waitFor(() => expect(gets("trial")).toHaveLength(2));
    });
  });

  it("says the first sentence is missing on a study nobody has described, with no decision form", async () => {
    draw(<TrialTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />);
    expect(await screen.findByText(VCR_NO_DEFINITION)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选定方案" })).not.toBeInTheDocument();
  });

  it("says a step that was asked for is arranged", async () => {
    installVcrServer(network.productRequest, nothingIn("trial"));
    draw(<TrialTab studyId={STUDY_ID} study={withStep("trial", { status: "none", requested: true })} />);
    expect(await screen.findByText(VCR_STEP_QUEUED)).toBeInTheDocument();
  });
});
