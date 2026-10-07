import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { OverviewTab } from "./OverviewTab";
import { PopulationTab } from "./PopulationTab";
import { PatientsTab } from "./PatientsTab";
import { ComparatorTab } from "./ComparatorTab";
import { TrialTab } from "./TrialTab";
import { MatchingTab } from "./MatchingTab";
import { DataTab } from "./DataTab";

/**
 * A card or a section that holds nothing but its title is not drawn (2026-10-07 live walk: 「周期、成本与成功把握的取舍」 over an empty
 * chart on the trial tab, 「定义库」 over nothing on the population tab). The seven study tabs are rendered from the server's own pages
 * and, for each part that can come back empty, from a copy of the page with that part emptied; none may leave a heading with no
 * content under it.
 */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }, { id: "prj_empty" }], select: vi.fn(), load: vi.fn() }) },
}));

const study = (change?: (raw: any) => void): VcrStudy => {
  const raw = fixture("ev201/study.json");
  raw.abilities = [...raw.abilities, "write", "run", "manage_study"];
  change?.(raw);
  return readVcrStudy(raw);
};
const tab = (name: string) => `GET /vcr/studies/${STUDY_ID}/${name}`;

/** Every heading that has a section or a card around it and nothing else in it: the title of an empty box. */
function emptyTitles(root: ParentNode): string[] {
  const titles: string[] = [];
  for (const box of root.querySelectorAll("section, [class~='rounded-card']")) {
    const headings = [...box.querySelectorAll("h1, h2, h3, h4")];
    if (headings.length === 0) continue;
    const said = (box.textContent ?? "").replace(/\s+/g, "");
    const titled = headings.map((heading) => (heading.textContent ?? "").replace(/\s+/g, "")).join("");
    // Something that is not text counts as content: a chart, a table, a control.
    if (said === titled && !box.querySelector("svg:not([aria-hidden='true']), canvas, table, input, select, textarea, button, [role='img'], [data-vcr-scatter]")) {
      titles.push(headings.map((heading) => heading.textContent).join(" "));
    }
  }
  return titles;
}

const KNOWLEDGE_EMPTY = { pack: null, definitions: [], comparisons: [], savable: [] };

beforeEach(() => { installVcrServer(network.productRequest); });

async function drawTab(node: React.ReactElement) {
  const view = render(<MemoryRouter>{node}</MemoryRouter>);
  // The tab has read its page and drawn it (every variant draws at least its headline or a card).
  await waitFor(() => expect(view.container.querySelector("[data-vcr-loading]")).toBeNull());
  // The reads that follow the page's own (the library, the packs) settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return view;
}

describe("no title over an empty box", () => {
  it("is something the check can see: a card with only its title, and a section with an empty body, are found; one with a line or a chart is not", () => {
    const { container } = render(
      <div>
        <section><h2>只有标题的卡</h2><div /></section>
        <section><h2>空的区块</h2><div><span> </span></div></section>
        <section><h2>有一行字</h2><p>内容</p></section>
        <section><h2>有一张图</h2><svg role="img" aria-label="图" /></section>
      </div>,
    );
    expect(emptyTitles(container)).toEqual(["只有标题的卡", "空的区块"]);
  });

  it("is true of the seven tabs as the server sends them", async () => {
    for (const [name, element] of [
      ["overview", <OverviewTab key="o" studyId={STUDY_ID} study={study()} />],
      ["population", <PopulationTab key="p" studyId={STUDY_ID} study={study()} />],
      ["patients", <PatientsTab key="pa" studyId={STUDY_ID} study={study()} />],
      ["comparator", <ComparatorTab key="c" studyId={STUDY_ID} study={study()} />],
      ["trial", <TrialTab key="t" studyId={STUDY_ID} study={study()} />],
      ["matching", <MatchingTab key="m" studyId={STUDY_ID} study={study()} />],
      ["data", <DataTab key="d" studyId={STUDY_ID} study={study()} />],
    ] as const) {
      const view = await drawTab(element);
      expect({ tab: name, empty: emptyTitles(view.container) }).toEqual({ tab: name, empty: [] });
      view.unmount();
    }
  });

  it("holds on the trial tab when the trade-off has nothing to place, and the power curve, the milestones and the run record are empty", async () => {
    const raw = fixture("ev201/trial.json");
    for (const design of raw.designs) {
      delete design.measures.duration_months;
      delete design.measures.assurance;
    }
    raw.powerCurve = { ...raw.powerCurve, series: [] };
    raw.milestones = [];
    raw.runRecord = [];
    raw.grid = null;
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const view = await drawTab(<TrialTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("table", { name: "方案的对比" });
    expect(view.queryByText("周期、成本与成功把握的取舍")).toBeNull();
    expect(view.queryByText("里程碑")).toBeNull();
    expect(view.queryByText("本次运行")).toBeNull();
    expect(emptyTitles(view.container)).toEqual([]);
  });

  it("holds on the population tab when the account's library holds nothing: no 「定义库」", async () => {
    const raw = fixture("ev201/population.json");
    raw.knowledge = KNOWLEDGE_EMPTY;
    installVcrServer(network.productRequest, { [tab("population")]: raw, "GET /vcr/definitions": { definitions: [] } });
    const view = await drawTab(<PopulationTab studyId={STUDY_ID} study={study()} />);
    await screen.findByText(raw.headline ?? raw.name ?? /./, { exact: false }).catch(() => null);
    expect(view.queryByRole("heading", { name: "定义库" })).toBeNull();
    expect(emptyTitles(view.container)).toEqual([]);
  });

  it("offers the library once it has a definition to use, and a population to save", async () => {
    const raw = fixture("ev201/population.json");
    raw.knowledge = { ...KNOWLEDGE_EMPTY, savable: [{ populationId: "pop_1", label: "人群 v1", name: "" }] };
    installVcrServer(network.productRequest, { [tab("population")]: raw, "GET /vcr/definitions": { definitions: [{ id: "dfn_1", name: "成人 ECOG 0-1", versions: 1, uses: 1, latest: { text: "年龄不小于 18 岁" } }] } });
    const view = await drawTab(<PopulationTab studyId={STUDY_ID} study={study()} />);
    expect(await view.findByRole("heading", { name: "定义库" })).toBeInTheDocument();
    expect(view.getByRole("button", { name: "存入定义库" })).toBeInTheDocument();
    expect(view.getByLabelText("用定义库里的定义")).toBeInTheDocument();
  });

  it("holds on the data tab when no pack is bound and the catalogue has none to choose: no 「病种定义包」", async () => {
    installVcrServer(network.productRequest, { "GET /vcr/packs": { packs: [] } });
    const view = await drawTab(<DataTab studyId={STUDY_ID} study={study((raw) => { raw.knowledge = KNOWLEDGE_EMPTY; })} />);
    await screen.findByText("对照组中位 PFS", { selector: "h2" });
    expect(view.queryByRole("heading", { name: "病种定义包" })).toBeNull();
    expect(emptyTitles(view.container)).toEqual([]);
  });

  it("draws 「病种定义包」 as the choice of the pack once the catalogue has one", async () => {
    installVcrServer(network.productRequest, { "GET /vcr/packs": { packs: [{ origin: "shipped", id: "nsclc", diseaseKey: "nsclc", name: "NSCLC", nameZh: "非小细胞肺癌", version: 1, status: "curated", counts: {}, sources: [] }] } });
    const view = await drawTab(<DataTab studyId={STUDY_ID} study={study((raw) => { raw.knowledge = KNOWLEDGE_EMPTY; })} />);
    expect(await view.findByRole("heading", { name: "病种定义包" })).toBeInTheDocument();
    expect(view.getByLabelText("选用病种定义包")).toBeInTheDocument();
  });

  it("holds on the overview when nothing has been delivered: no 「交付物」", async () => {
    const view = await drawTab(<OverviewTab studyId={STUDY_ID} study={study((raw) => { raw.overview.deliverables = []; })} />);
    expect(view.queryByRole("heading", { name: "交付物" })).toBeNull();
    expect(emptyTitles(view.container)).toEqual([]);
  });

  it("holds on a generated population with no profile: the sentence is a line, not a card, and the two cards that remain are there", async () => {
    const raw = fixture("ev201/population.json");
    Object.assign(raw, { version: "人群 v1", kind: "情景人群", method: "按设定的分布和相关性抽样", allowedUses: [{ key: "design", label: "设计" }],
      constraints: [], profile: [], profileKind: null, profileMissing: true, generated: [], criteria: [], attrition: [], outcome: null, unknownReasons: [], blockers: [],
      quality: null, headline: null, definition: null, download: null, knowledge: KNOWLEDGE_EMPTY,
      profileNote: "这个人群生成时还没有画像：点“重新生成”，按同样的设定再生成一次，就能看到每个变量的分布。" });
    installVcrServer(network.productRequest, { [tab("population")]: raw, "GET /vcr/definitions": { definitions: [] } });
    const view = await drawTab(<PopulationTab studyId={STUDY_ID} study={study()} />);
    const note = view.container.querySelector("[data-vcr-profile-missing]") as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.closest("[class~='rounded-card']")).toBeNull();
    expect(view.getByText("怎么生成的")).toBeInTheDocument();
    expect(view.getByText("能用来做什么")).toBeInTheDocument();
    expect(emptyTitles(view.container)).toEqual([]);
  });

  // The class this guards (report 「虚拟临研的完成状态没有对应的可读结果」): a page that says it is done, or offers a choice, with nothing computed under it.
  it("never offers a choice on a tab whose objects have no computed measure: no 选定方案 on designs nobody ran, no 「还没有选定模型」 over another model's assessment", async () => {
    const trial = fixture("ev201/trial.json");
    trial.designs = trial.designs.map((design: any) => ({ ...design, dominated: false, chosen: false,
      measures: Object.fromEntries(Object.entries(design.measures).filter(([key]) => key === "sample_size" || key === "cost")) }));
    trial.decision = null; trial.headline = null;
    installVcrServer(network.productRequest, { [tab("trial")]: trial });
    const trialView = await drawTab(<TrialTab studyId={STUDY_ID} study={study()} />);
    expect(trialView.queryByRole("button", { name: /选定方案|改选方案/ })).toBeNull();
    expect(trialView.queryByRole("table", { name: "方案的对比" })).toBeNull();
    expect(emptyTitles(trialView.container)).toEqual([]);
    trialView.unmount();

    const patients = fixture("ev201/patients.json");
    Object.assign(patients, { model: null, trajectories: null, example: null, panels: [], sensitivity: null, headline: null, twin: null, sets: [], counts: null, partial: null, stale: null });
    installVcrServer(network.productRequest, { [tab("patients")]: patients });
    const patientView = await drawTab(<PatientsTab studyId={STUDY_ID} study={study((raw) => { raw.steps.patients = { status: "none", requested: false }; })} />);
    expect(patientView.queryByText("还没有选定模型")).toBeNull();
    expect(emptyTitles(patientView.container)).toEqual([]);
  });

  it("holds on the matching tab before anything was judged: one sentence and one button, and no toolbar over it", async () => {
    const raw = fixture("ev201/matching.json");
    Object.assign(raw, { candidates: [], forecast: null, pendingReview: null, ledger: [], sites: [], followup: [], headline: null, partner: null });
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/matching`]: raw });
    const view = await drawTab(<MatchingTab studyId={STUDY_ID} study={study((rawStudy) => { rawStudy.steps.matching = { status: "none", requested: false }; })} />);
    expect(view.container.querySelector("[data-vcr-step-empty='matching']")).not.toBeNull();
    expect(view.queryByRole("radiogroup", { name: "匹配与招募的视图" })).toBeNull();
    expect(emptyTitles(view.container)).toEqual([]);
  });

  it("holds on the patients and comparator tabs when their parts come back with a title and no content", async () => {
    const patients = fixture("ev201/patients.json");
    patients.panels = [{ key: "bare", title: "只有标题的面板", rows: [], series: [] }];
    patients.trajectories = { ...patients.trajectories, series: [] };
    installVcrServer(network.productRequest, { [tab("patients")]: patients });
    const seen = await drawTab(<PatientsTab studyId={STUDY_ID} study={study()} />);
    expect(seen.queryByText("只有标题的面板")).toBeNull();
    expect(seen.queryByText("两种情景下的推演，以及个体之间的差异")).toBeNull();
    expect(emptyTitles(seen.container)).toEqual([]);
    seen.unmount();

    const comparator = fixture("ev201/comparator.json");
    comparator.robustness = { rows: [], qualification: null, notes: [] };
    comparator.estimand = { ...(comparator.estimand ?? {}), rows: [], note: null };
    installVcrServer(network.productRequest, { [tab("comparator")]: comparator });
    const compared = await drawTab(<ComparatorTab studyId={STUDY_ID} study={study()} />);
    expect(compared.queryByText("稳健性与预后校正分析")).toBeNull();
    expect(compared.queryByText("估计目标")).toBeNull();
    expect(emptyTitles(compared.container)).toEqual([]);
  });
});
