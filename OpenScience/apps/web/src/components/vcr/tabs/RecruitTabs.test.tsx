import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { fakeRoom, renderTab } from "../__fixtures__/tabFrame";
import { DataTab } from "./DataTab";
import { MatchingTab } from "./MatchingTab";

// Only the network is doubled. The readers, the route functions and the tabs
// are the real ones, and every payload is the server's own fixture — or a copy
// of one with a single field changed.
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }], select: vi.fn(), load: vi.fn() }) },
}));

const MATCHING = `/vcr/studies/${STUDY_ID}/matching`;
const DATA = `/vcr/studies/${STUDY_ID}/data`;

/** The study as the page hands it to a tab: the server's own answer, through the real reader. */
function study(change?: (raw: any) => void): VcrStudy {
  const raw = fixture("ev201/study.json");
  change?.(raw);
  return readVcrStudy(raw);
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function drawTab(node: React.ReactElement, path = `/app/virtual-research/${STUDY_ID}/matching`) {
  return renderTab(<>{node}<Where /></>, { route: path });
}

/** A chip of the band that opens a menu, opened, and one of its items pressed (the patient, the protocol). */
async function chooseFrom(chip: string | RegExp, item: string | RegExp) {
  await userEvent.click(await screen.findByRole("button", { name: chip }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: item }));
}

const matchingReads = (server: ReturnType<typeof installVcrServer>) =>
  server.calls.filter((call) => call.method === "GET" && call.path.startsWith(MATCHING)).map((call) => new URL(call.path, "http://x").searchParams);

let server: ReturnType<typeof installVcrServer>;
let restoreRoom: () => void;

beforeEach(() => {
  restoreRoom = fakeRoom();
  server = installVcrServer(network.productRequest);
  toasts.success.mockReset();
  toasts.error.mockReset();
});
afterEach(() => restoreRoom());

/* ------------------------------------------------------------------ 患者匹配 */

describe("患者匹配 — choosing a person", () => {
  it("asks for the matching view in the trial-to-patient direction first", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    expect(await screen.findByRole("heading", { name: "P-0201" })).toBeInTheDocument();
    const [first] = matchingReads(server);
    expect(first.get("view")).toBe("matching");
    expect(first.get("direction")).toBe("trial_to_patient");
    expect(first.has("candidate")).toBe(false);
  });

  // UI-6: every candidate is a button, and choosing one re-reads the tab for
  // that person.
  it("re-reads the tab for the person chosen, with candidate= in the query", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await waitFor(() => expect(matchingReads(server).some((query) => query.get("candidate") === "P-0192")).toBe(true));
    expect(await screen.findByRole("heading", { name: "P-0192" })).toBeInTheDocument();
    expect(screen.getByText("不能判为符合：排除标准 E1 未知")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^P-0192/ })).toHaveAttribute("aria-current", "true");
  });

  it("switches between both supported matching directions and reads each by name", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    expect(matchingReads(server).every((query) => query.get("direction") === "trial_to_patient")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "给患者找试验" }));
    await waitFor(() => expect(matchingReads(server).some((query) => query.get("direction") === "patient_to_trial")).toBe(true));
    expect(screen.getByRole("button", { name: "给患者找试验" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "给试验找患者" }));
    await waitFor(() => expect(matchingReads(server).at(-1)?.get("direction")).toBe("trial_to_patient"));
    expect(screen.getByRole("button", { name: "给试验找患者" })).toHaveAttribute("aria-pressed", "true");
  });

  // The ranking hint orders a coordinator's work; it is never a probability.
  it("carries the clinical priority under its own label, with no number that reads as a probability", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    const priority = (screen.getByRole("button", { name: /^P-0192/ }).closest("li") as HTMLElement).querySelector("[data-vcr-priority]") as HTMLElement;
    expect(priority).toHaveTextContent("临床优先级（不是获益概率） · ECOG 1，一线含铂后进展");
    expect(priority.textContent).not.toMatch(/0\.8|80\s*%|%/);
    expect(document.body.textContent).not.toMatch(/获益概率\s*[\d.]/);
  });
});









describe("患者匹配 — what a rule says about a person", () => {
  // 不适用 is its own field (plan §7.1), never folded into 未知.
  it("marks a rule that does not apply as 不适用, not 未知", async () => {
    const payload = fixture("ev201/matching-p0192.json");
    const e3 = payload.selected.criteria.find((row: { code: string }) => row.code === "E3");
    e3.applicable = false;
    e3.state = "unknown";
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    const row = await waitFor(() => {
      const found = document.querySelector("[data-vcr-criterion='E3']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row).toHaveAttribute("data-vcr-criterion-state", "not_applicable");
    expect(row).toHaveTextContent("不适用");
    expect(row).not.toHaveTextContent("未知");
    // The rule that is unknown stays unknown.
    expect(document.querySelector("[data-vcr-criterion='E1']")).toHaveTextContent("未知");
  });

  it("shows who waits in 待复核排除 when the server sends them", async () => {
    const payload = fixture("ev201/matching.json");
    payload.pendingReview = { count: 2, subjects: ["P-0300", "P-0301"] };
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    expect(await screen.findByText("待复核排除")).toBeInTheDocument();
    const zone = document.querySelector("[data-vcr-pending-review]") as HTMLElement;
    expect(within(zone).getByText("P-0300")).toBeInTheDocument();
    expect(screen.getByText("2 人")).toBeInTheDocument();
  });

  it("says 已撤回 beside a person whose consent was withdrawn, and nothing beside the others", async () => {
    const payload = fixture("ev201/matching.json");
    payload.candidates[0].basis = "withdrawn";
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: payload.candidates[0].id });
    const withdrawn = (document.querySelector(`[data-vcr-candidate='${payload.candidates[0].id}']`) as HTMLElement).closest("li") as HTMLElement;
    expect(within(withdrawn).getByText("已撤回")).toBeInTheDocument();
    const others = payload.candidates.slice(1).map((candidate: { id: string }) => document.querySelector(`[data-vcr-candidate='${candidate.id}']`)?.closest("li") as HTMLElement).filter(Boolean);
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) expect(within(other).queryByText("已撤回")).toBeNull();
  });

  it("says 依据已更新 beside a person whose evaluation rested on a basis that has since changed", async () => {
    const payload = fixture("ev201/matching.json");
    payload.candidates[0].basis = "updated";
    payload.basisUpdated = { count: 1, subjects: [payload.candidates[0].id] };
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: payload.candidates[0].id });
    const changed = (document.querySelector(`[data-vcr-candidate='${payload.candidates[0].id}']`) as HTMLElement).closest("li") as HTMLElement;
    expect(within(changed).getByText("依据已更新")).toBeInTheDocument();
    expect(screen.getByText("1 人的评估依据已更新")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新评估" })).toBeEnabled();
  });

  it("says the recruiting side is not here, and nothing else waits", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: { view: "matching", available: false, unavailable: { code: "vcr_matching_unavailable", message: "患者匹配在本部署尚未接入；其余步骤照常。" }, funnel: [], candidates: [], selected: null, gaps: [], counts: null },
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    expect(await screen.findByText("暂时无法进行患者匹配")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "匹配患者" })).toBeNull();
    // Nothing to switch between while the recruiting side is not here: the band has no row.
    expect(screen.getByRole("group", { name: "匹配方向" })).toBeInTheDocument();
  });
});



describe("患者匹配 — a study with protocol versions and nothing evaluated yet", () => {
  // Review V-M4/V-M5: with a protocol present the empty tab drew export, four views, two directions, a protocol select and a folded
  // panel above the empty state, and the action that starts an evaluation was inside the fold.
  const idle = (raw: any) => { raw.steps.matching = { status: "none", requested: false }; };
  const unevaluated = (change?: (page: any) => void) => {
    const page = fixture("ev201/matching.json");
    Object.assign(page, { candidates: [], selected: null, funnel: [], gaps: [], comparisons: [], timeline: [], forecast: null, pendingReview: null, ledger: [],
      sites: [], followup: [], headline: null, partner: null, counts: null, candidateRoster: ["P-0300", "P-0301"] });
    change?.(page);
    return page;
  };
  const JOBS = `POST /vcr/studies/${STUDY_ID}/jobs`;

  it("is the step's recipe and one 开始评估 — no toolbar, no controls over it — and the button queues the protocol in view for the registered people", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: unevaluated(),
      [JOBS]: { jobs: [{ jobId: "job_1", state: "queued" }], unavailable: [] },
    });
    const { container } = drawTab(<MatchingTab studyId={STUDY_ID} study={study(idle)} />);
    const start = await screen.findByRole("button", { name: "开始评估" });
    expect(screen.getByText("尚未生成匹配评估")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "开始评估" })).toHaveLength(1);
    expect(container.querySelector("[data-page-chrome]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "匹配患者" })).toBeNull();
    await userEvent.click(start);
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/jobs`, "POST",
      { kind: "match_criteria", selection: { protocolVersionIds: ["prt_1"], direction: "trial_to_patient" } }));
    expect(await screen.findByText("已提交 1 项评估。")).toBeInTheDocument();
    // The job runs on its own time, and the page reads itself when it moves: there is no button to ask for the answer.
    expect(screen.queryByRole("button", { name: "刷新结果" })).toBeNull();
    await waitFor(() => expect(matchingReads(server).length).toBeGreaterThan(1));
  });

  it("says nothing was submitted, and why, when the evaluation could not be queued", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: unevaluated(),
      [JOBS]: { jobs: [], unavailable: [{ code: "vcr_criteria_missing" }] },
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study(idle)} />);
    await userEvent.click(await screen.findByRole("button", { name: "开始评估" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("没有提交评估。方案还没有结构化的入排条件，无法匹配。");
  });

  it("keeps the step's own ask when nobody is registered to evaluate — there is nothing for 开始评估 to work on", async () => {
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: unevaluated((page) => { page.candidateRoster = []; }) });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study(idle)} />);
    expect(await screen.findByRole("button", { name: "匹配患者" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始评估" })).toBeNull();
    expect(screen.queryByRole("group", { name: "患者匹配的视图" })).toBeNull();
  });

  it("offers no 开始评估 to a reader who may not run it", async () => {
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: unevaluated() });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study((raw) => { idle(raw); raw.tier = "T1"; raw.abilities = ["read", "write"]; })} />);
    expect(await screen.findByText("得到 逐条入排判定和补证建议")).toBeInTheDocument();
    // No button — and the reason is said where it would be.
    expect(screen.queryByRole("button", { name: "开始评估" })).toBeNull();
    expect(screen.getByText("需要有运行权限的成员来开始这一步。")).toBeInTheDocument();
  });

  it("shows the controls, with 开始评估 in plain sight, once the reader has chosen a direction and the answer is empty", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => (query.get("direction") === "patient_to_trial"
        ? unevaluated()
        : withProtocols()),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: "给患者找试验" }));
    expect(await screen.findByRole("button", { name: /^查看方案/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "匹配方向" })).toBeInTheDocument();
    // 给患者找试验 starts from a person: until one is chosen there is no button that would be grey — the patient's chip is in plain sight.
    expect(screen.queryByRole("button", { name: "开始评估" })).toBeNull();
    await chooseFrom(/^患者/, "P-0300");
    expect((await screen.findByRole("button", { name: "开始评估" })).closest("details")).toBeNull();
  });
});



/** The page contract's two ids: the assessment the panel is about, and each rule's own id. */
function addressed(payload: any) {
  payload.selected.assessmentId = "asm_192";
  for (const criterion of payload.selected.criteria) criterion.criterionId = `crt_${criterion.code}`;
  return payload;
}
const P0192 = `GET ${MATCHING}?view=matching&direction=trial_to_patient&candidate=P-0192`;
const criterionRow = (code: string) => document.querySelector(`[data-vcr-criterion='${code}']`) as HTMLElement;

describe("patient matching scientific evidence requests", () => {
  async function open(abilities?: string[], write?: () => unknown) {
    server = installVcrServer(network.productRequest, {
      [P0192]: addressed(fixture("ev201/matching-p0192.json")),
      ...(write ? { [`POST /vcr/studies/${STUDY_ID}/decisions`]: write } : {}),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study(raw => { if (abilities) raw.abilities = abilities; })} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
  }

  it("records the exact subject, assessment and open criteria without recruitment side effects", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "记录待补证项" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已记录补证请求。"));
    const writes = server.calls.filter(call => call.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`/vcr/studies/${STUDY_ID}/decisions`);
    expect(writes[0].body).toMatchObject({ chosen: { kind: "evidence_request", subject: "P-0192", assessmentId: "asm_192", criteria: ["E1", "E2"], criterionIds: ["crt_E1", "crt_E2"] } });
  });

  it("offers no scientific decision write to a reader without write permission", async () => {
    await open(["read", "review_clinical"]);
    const button = screen.getByRole("button", { name: "记录待补证项" });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
  });

  it("keeps one pending decision write and releases the controls when it settles", async () => {
    let finish!: (value: object) => void;
    await open(undefined, () => new Promise(resolve => { finish = resolve; }));
    const button = screen.getByRole("button", { name: "记录待补证项" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(server.calls.filter(call => call.method === "POST")).toHaveLength(1);
    await act(async () => finish({}));
    await waitFor(() => expect(button).toBeEnabled());
  });
});

describe("患者匹配 — 改判, a person's hand on a rule", () => {
  async function open(change?: (payload: any) => void, reader: VcrStudy = study()) {
    const payload = addressed(fixture("ev201/matching-p0192.json"));
    change?.(payload);
    server = installVcrServer(network.productRequest, { [P0192]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={reader} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
  }

  it("posts the person's state and their grounds to the rule of the assessment the panel is about, then re-reads the person", async () => {
    await open();
    await userEvent.click(within(criterionRow("E1")).getByRole("button", { name: "改判" }));
    expect(await screen.findByText("平台判为：未知")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("你的判定"), "not_satisfied");
    await userEvent.type(screen.getByLabelText("依据"), "病历写明有脑转移");
    const reads = matchingReads(server).length;
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(
      `/vcr/studies/${STUDY_ID}/assessments/asm_192/judgments/crt_E1/override`, "POST", { state: "not_satisfied", note: "病历写明有脑转移" }));
    expect(toasts.success).toHaveBeenCalledWith("已记录改判。");
    await waitFor(() => expect(matchingReads(server).length).toBeGreaterThan(reads));
    expect(screen.queryByLabelText("你的判定")).toBeNull();
  });

  it("sends the state alone when no grounds were given, and is one request however often 保存 is pressed", async () => {
    let finish: (value: unknown) => void = () => undefined;
    await open();
    server = installVcrServer(network.productRequest, {
      [P0192]: addressed(fixture("ev201/matching-p0192.json")),
      [`POST /vcr/studies/${STUDY_ID}/assessments/asm_192/judgments/crt_E1/override`]: () => new Promise((resolve) => { finish = resolve; }),
    });
    await userEvent.click(within(criterionRow("E1")).getByRole("button", { name: "改判" }));
    const save = await screen.findByRole("button", { name: "保存" });
    await userEvent.click(save);
    await userEvent.click(save);
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({ state: "unknown" });
    await act(async () => { finish({}); });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已记录改判。"));
  });

  it("says a refusal in words and keeps the drawer for another try", async () => {
    await open();
    server = installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/assessments/asm_192/judgments/crt_E1/override`]: () => { throw new WebApiError("no", { status: 404, code: "vcr_assessment_not_found" }); },
    });
    await userEvent.click(within(criterionRow("E1")).getByRole("button", { name: "改判" }));
    await userEvent.click(await screen.findByRole("button", { name: "保存" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(screen.getByLabelText("你的判定")).toBeInTheDocument();
  });

  it("marks a rule whose state is a person's", async () => {
    await open((payload) => { payload.selected.criteria.find((row: any) => row.code === "E1").overridden = true; });
    expect(criterionRow("E1").querySelector("[data-vcr-overridden]")).toHaveTextContent("人工改判");
    expect(criterionRow("E2").querySelector("[data-vcr-overridden]")).toBeNull();
  });

  it("offers no 改判 or 复核 for a panel that does not name its assessment", async () => {
    await open((payload) => { delete payload.selected.assessmentId; });
    expect(screen.queryByRole("button", { name: "改判" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复核这份评估" })).toBeNull();
  });

  it("offers no 改判 on a rule that does not name itself", async () => {
    await open((payload) => { for (const row of payload.selected.criteria) delete row.criterionId; });
    expect(screen.queryByRole("button", { name: "改判" })).toBeNull();
    expect(screen.getByRole("button", { name: "复核这份评估" })).toBeEnabled();
  });

  it("offers none to a reader who may neither write the ledger nor review", async () => {
    await open(undefined, study((raw) => { raw.abilities = ["read", "write", "contact_patients"]; }));
    expect(screen.queryByRole("button", { name: "改判" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复核这份评估" })).toBeNull();
  });


});

describe("患者匹配 — 复核这份评估, a reviewer's countersignature", () => {
  async function open(change?: (payload: any) => void, reader: VcrStudy = study()) {
    const payload = addressed(fixture("ev201/matching-p0192.json"));
    change?.(payload);
    server = installVcrServer(network.productRequest, { [P0192]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={reader} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
  }

  it("countersigns the assessment named in the path, once, and re-reads the person", async () => {
    await open();
    const reads = matchingReads(server).length;
    await userEvent.click(screen.getByRole("button", { name: "复核这份评估" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/assessments/asm_192/review`, "POST", {}));
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(toasts.success).toHaveBeenCalledWith("已记录复核。");
    await waitFor(() => expect(matchingReads(server).length).toBeGreaterThan(reads));
  });

  it("is one signature however often it is pressed while the first is in flight", async () => {
    let finish: (value: unknown) => void = () => undefined;
    await open();
    server = installVcrServer(network.productRequest, {
      [P0192]: addressed(fixture("ev201/matching-p0192.json")),
      [`POST /vcr/studies/${STUDY_ID}/assessments/asm_192/review`]: () => new Promise((resolve) => { finish = resolve; }),
    });
    const sign = screen.getByRole("button", { name: "复核这份评估" });
    await userEvent.click(sign);
    await userEvent.click(sign);
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    await act(async () => { finish({}); });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已记录复核。"));
  });

  it("says who signed an assessment that is reviewed, and offers no second signature", async () => {
    await open((payload) => { payload.selected.reviewedBy = "reviewer-1"; payload.selected.reviewedByName = "赵复核"; });
    expect(document.querySelector("[data-vcr-reviewed-by]")).toHaveTextContent("已复核 · 赵复核");
    expect(document.querySelector("[data-vcr-reviewed-by]")).not.toHaveTextContent("reviewer-1");
    expect(screen.queryByRole("button", { name: "复核这份评估" })).toBeNull();
  });

  it("never prints the account id of whoever signed: with no name it says nothing of them", async () => {
    await open((payload) => { payload.selected.reviewedBy = "usr_3f9a"; payload.selected.reviewedByName = null; });
    expect(document.querySelector("[data-vcr-reviewed-by]")).toHaveTextContent("已复核");
    expect(document.querySelector("[data-vcr-reviewed-by]")).not.toHaveTextContent("usr_3f9a");
    expect(screen.queryByRole("button", { name: "复核这份评估" })).toBeNull();
  });

  it("is a clinical reviewer's, not a coordinator's", async () => {
    await open(undefined, study((raw) => { raw.abilities = ["read", "review_clinical"]; }));
    expect(screen.getByRole("button", { name: "复核这份评估" })).toBeEnabled();
    expect(within(criterionRow("E1")).getByRole("button", { name: "改判" })).toBeEnabled();
  });
});

describe("患者匹配 — every citation a verdict rests on (E-06)", () => {
  it("shows each citation with the document it is in and the date of what it records, the first being the rule's evidence", async () => {
    const payload = addressed(fixture("ev201/matching-p0192.json"));
    const row = payload.selected.criteria.find((entry: any) => entry.code === "E1");
    const citation = (quote: string, source: string, at: string, start: number) => ({ quote, source, at, locator: { documentId: "prj_x", start, end: start + 8 } });
    row.evidence = citation("2026-09-26 处方多西他赛", "document-aaaa1111.txt", "9 月 26 日", 0);
    row.evidenceItems = [row.evidence, citation("2026-06-01 给予多西他赛", "document-bbbb2222.txt", "6 月 1 日", 40)];
    server = installVcrServer(network.productRequest, { [P0192]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
    const cell = criterionRow("E1");
    expect(cell).toHaveTextContent("“2026-09-26 处方多西他赛”");
    expect(cell).toHaveTextContent("document-aaaa1111.txt · 9 月 26 日");
    expect(cell).toHaveTextContent("“2026-06-01 给予多西他赛”");
    expect(cell).toHaveTextContent("document-bbbb2222.txt · 6 月 1 日");
  });
});

describe("患者匹配 — what the evidence of a rule has been through", () => {
  // Review V-M8: negation, a correction and a conflict were told only in the folded timeline at the foot of the tab, so a 满足 or 不满足
  // on a rule's own row said nothing of its evidence having been denied, corrected or contradicted, nor whose records the fold held.
  const AT = (start: number) => ({ documentId: "doc_192", start, end: start + 8 });
  const entry = (extra: Record<string, unknown>) => ({ id: "f_x", variable: "v", value: null, unit: null, at: null, assertion: "affirmed", experiencer: "patient",
    medicationState: null, correctionOf: null, quote: null, superseded: false, conflictFactIds: [], correctionReason: null, locator: null, ...extra });
  const cite = (code: string, quote: string, locator: unknown) => (payload: any) => {
    payload.selected.criteria.find((row: any) => row.code === code).evidence = { quote, locator, source: "病历原文", at: "9 月 1 日" };
  };
  async function open(change: (payload: any) => void, reader: VcrStudy = study()) {
    const payload = addressed(fixture("ev201/matching-p0192.json"));
    change(payload);
    server = installVcrServer(network.productRequest, { [P0192]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={reader} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
  }
  const timeline = (payload: any) => {
    cite("I1", "否认脑转移", AT(10))(payload);
    cite("I2", "ECOG 1 分", AT(40))(payload);
    cite("I3", "一线含铂双药", AT(70))(payload);
    payload.timeline = [
      entry({ id: "f_1", variable: "brain_mets", quote: "否认脑转移", assertion: "negated", locator: AT(10) }),
      entry({ id: "f_2", variable: "ecog", quote: "ECOG 1 分", superseded: true, conflictFactIds: ["f_4"], locator: AT(40) }),
      entry({ id: "f_3", variable: "platinum", quote: "一线含铂双药", correctionOf: "f_0", correctionReason: "检验科更正", locator: AT(70) }),
      entry({ id: "f_4", variable: "ecog", quote: "ECOG 2 分", conflictFactIds: ["f_2"], locator: AT(120) }),
    ];
  };

  it("tags a rule whose evidence was denied, one that has since been corrected or contradicted, and one that is itself a correction — on the rule's own row", async () => {
    await open(timeline);
    expect(within(criterionRow("I1")).getByText("已否认")).toBeInTheDocument();
    expect(within(criterionRow("I2")).getByText("已有更正")).toBeInTheDocument();
    expect(within(criterionRow("I2")).getByText("记录有冲突")).toBeInTheDocument();
    expect(within(criterionRow("I3")).getByText("更正记录")).toBeInTheDocument();
    // The mark itself is unchanged: the tag says what the evidence went through, the state says what the platform judged.
    expect(criterionRow("I1")).toHaveAttribute("data-vcr-criterion-state", "satisfied");
  });

  it("tags nothing on a rule that has no evidence, or whose evidence is a cell of the data table", async () => {
    await open(timeline);
    // I1..I3 carry caveats; the rule with no evidence and the snapshot cells do not.
    for (const code of ["E1", "E2", "E3"]) expect(criterionRow(code).querySelector("[data-vcr-caveats]")).toBeNull();
  });

  it("tags nothing on a rule whose evidence no recorded fact stands behind", async () => {
    await open((payload) => { timeline(payload); payload.timeline = payload.timeline.filter((fact: any) => fact.id === "f_4"); });
    expect(document.querySelectorAll("[data-vcr-caveats]")).toHaveLength(0);
  });

  it("tags nothing when the page carries no timeline — a reader who may not read patient-level records sees no facts to tag", async () => {
    await open((payload) => { timeline(payload); payload.timeline = []; });
    expect(document.querySelectorAll("[data-vcr-caveats]")).toHaveLength(0);
  });

  it("names whose records the fold holds", async () => {
    await open(timeline);
    expect(screen.getByText("P-0192 的临床记录与更正")).toBeInTheDocument();
  });
});

describe("患者匹配 — whose records the timeline holds", () => {
  // The timeline under the panel is the facts of the person the page was asked for (`?candidate=`). An unevaluated person has no
  // assessment, so the server answers with their facts under the first candidate's panel: the two are different people, and the
  // fold must say whose facts it holds, and the rows of the panel must not be tagged from another person's facts.
  const AT = { documentId: "doc_shared", start: 10, end: 18 };
  const fact = (id: string, extra: Record<string, unknown> = {}) => ({ id, variable: "brain_mets", value: null, unit: null, at: null, assertion: "affirmed",
    experiencer: "patient", medicationState: null, correctionOf: null, quote: "否认脑转移", superseded: false, conflictFactIds: [], correctionReason: null,
    locator: AT, ...extra });
  /** The first candidate's page; the panel's first rule cites a span of a document, and `facts` are the page's timeline. */
  const page = (facts: unknown[]) => {
    const raw = fixture("ev201/matching.json");
    raw.candidateRoster = ["P-0300"];
    raw.selected.criteria[0].evidence = { quote: "否认脑转移", locator: AT, source: "病历原文", at: "9 月 1 日" };
    raw.timeline = facts;
    return raw;
  };
  const NEGATED = fact("f_neg", { assertion: "negated" });

  it("names the person the page was asked for, not the person of the panel above it, when they are two", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => page(query.get("candidate") === "P-0300"
        ? [fact("f_300", { quote: "P-0300 的既往史", locator: { documentId: "doc_300", start: 0, end: 8 } })]
        : [fact("f_201", { quote: "P-0201 的既往史", locator: { documentId: "doc_201", start: 0, end: 8 } })]),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    // Nobody was asked for: the page's own person.
    expect(screen.getByText("P-0201 的临床记录与更正")).toBeInTheDocument();
    await chooseFrom(/^患者/, "P-0300");
    expect(await screen.findByText("P-0300 的临床记录与更正")).toBeInTheDocument();
    expect(screen.queryByText("P-0201 的临床记录与更正")).toBeNull();
    // The server has no assessment of P-0300, so the panel is still the first candidate's.
    expect(screen.getByRole("heading", { name: "P-0201" })).toBeInTheDocument();
  });

  it("keeps naming the person whose facts are on screen while the next person's page is read", async () => {
    let arrive: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => (query.get("candidate") === "P-0192"
        ? new Promise((resolve) => { arrive = resolve; })
        : page([fact("f_201", { quote: "P-0201 的既往史", locator: { documentId: "doc_201", start: 0, end: 8 } })])),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await waitFor(() => expect(matchingReads(server).some((query) => query.get("candidate") === "P-0192")).toBe(true));
    // P-0192's page has not come: the facts are still P-0201's, and so is the name over them.
    expect(screen.getByText("P-0201 的临床记录与更正")).toBeInTheDocument();
    expect(screen.queryByText("P-0192 的临床记录与更正")).toBeNull();
    // It comes — the server's own page for P-0192, with that person's facts — and the name follows the facts.
    const arrived = fixture("ev201/matching-p0192.json");
    arrived.timeline = [fact("f_192", { quote: "P-0192 的既往史", locator: { documentId: "doc_192", start: 0, end: 8 } })];
    await act(async () => { arrive(arrived); });
    expect(await screen.findByText("P-0192 的临床记录与更正")).toBeInTheDocument();
    expect(screen.queryByText("P-0201 的临床记录与更正")).toBeNull();
  });

  it("tags the rules of the panel from the panel's person's facts, and from nobody else's", async () => {
    server = installVcrServer(network.productRequest, {
      // Whoever the facts are, one of them is a denial of the span the first rule of the panel cites: a shared document.
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => {
        const raw = page([NEGATED]);
        // The page asked for P-0300 is told apart by its list: the second candidate is not in it.
        if (query.get("candidate") === "P-0300") raw.candidates = raw.candidates.slice(0, 1);
        return raw;
      },
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    expect(within(criterionRow("I1")).getByText("已否认")).toBeInTheDocument();
    // Asked for another person, the panel is still P-0201's but the facts are not: the rule is not tagged by them.
    await chooseFrom(/^患者/, "P-0300");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^P-0207/ })).toBeNull());
    expect(screen.getByRole("heading", { name: "P-0201" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-vcr-caveats]")).toHaveLength(0);
  });
});

describe("患者匹配 — one word for the person", () => {
  // Review V-M9: the direction switch said 患者 and the select beside it 受试者. The product's own word in the recruiting tab
  // is 患者 (给试验找患者, 患者证据, 匹配患者, 联系真实患者).
  it("says 患者 in the controls and in the referral ledger, and never 受试者", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: "患者" }));
    expect(await screen.findByRole("menuitemradio", { name: "全部已登记患者" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(document.body.textContent).not.toMatch(/受试者/);
    expect(screen.queryByRole("button", { name: "转诊" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/受试者/);
  });
});



/* ------------------------------------------------------------------ 数据与证据 */

const dataPath = (card?: string) => `/app/virtual-research/${STUDY_ID}/data${card ? `?card=${card}` : ""}`;
const detail = () => document.querySelector("[data-vcr-assumption-detail]") as HTMLElement;

/** The server's matching page with two protocol versions to look at. */
function withProtocols(change?: (payload: any) => void) {
  const payload = fixture("ev201/matching.json");
  payload.protocols = [
    { id: "prt_1", version: 1, title: "EV-201 方案 v1", sourceRef: null },
    { id: "prt_2", version: 2, title: "EV-201 方案 v2", sourceRef: null },
  ];
  payload.protocolVersionId = "prt_1";
  change?.(payload);
  return payload;
}

describe("患者匹配 — the controls stay while another page is read", () => {
  // Review V-M2: the load key holds the protocol and the direction, and while a new key loaded the tab drew its toolbar and a
  // skeleton alone — the control just used, the comparison panel and a half-made choice were unmounted, and a keyboard reader's
  // focus fell to <body>. The controls are in the band now, which the tab's body does not remount.
  it("keeps the chip the reader changed — the same element — with the open comparison panel and its choice, while the other protocol's page loads", async () => {
    let arrive: (page: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => (query.get("protocolVersionId") === "prt_2"
        ? new Promise((resolve) => { arrive = resolve; })
        : withProtocols()),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByText("比较多个方案"));
    const panel = screen.getByText("比较多个方案").closest("details")!;
    expect(panel).toHaveAttribute("open");
    const group = () => screen.getByRole("group", { name: "选择方案（最多 10 项）" });
    await userEvent.click(within(group()).getByRole("checkbox", { name: "EV-201 方案 v2" }));
    const chip = screen.getByRole("button", { name: /^查看方案/ });
    await chooseFrom(/^查看方案/, "EV-201 方案 v2");
    await waitFor(() => expect(matchingReads(server).some((query) => query.get("protocolVersionId") === "prt_2")).toBe(true));
    // The page for prt_2 has not arrived: the tab is loading, and the controls are the ones the reader was using.
    expect(document.querySelector("[data-vcr-loading='tab']")).not.toBeNull();
    expect(screen.getByRole("button", { name: "查看方案：EV-201 方案 v2" })).toBe(chip);
    expect(panel).toHaveAttribute("open");
    expect(within(group()).getByRole("checkbox", { name: "EV-201 方案 v2" })).toBeChecked();
    expect(within(group()).getByRole("checkbox", { name: "EV-201 方案 v1" })).not.toBeChecked();
    await act(async () => { arrive(withProtocols((payload) => { payload.protocolVersionId = "prt_2"; })); });
    await waitFor(() => expect(document.querySelector("[data-vcr-loading='tab']")).toBeNull());
    expect(screen.getByRole("button", { name: "查看方案：EV-201 方案 v2" })).toBe(chip);
    expect(panel).toHaveAttribute("open");
    expect(within(group()).getByRole("checkbox", { name: "EV-201 方案 v2" })).toBeChecked();
    expect(within(group()).getByRole("checkbox", { name: "EV-201 方案 v1" })).not.toBeChecked();
  });

  it("keeps the controls when the page for the protocol chosen cannot be read, so another protocol can be chosen", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => {
        if (query.get("protocolVersionId") === "prt_2") throw new WebApiError("no", { status: 500, code: "vcr_unavailable" });
        return withProtocols();
      },
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    const chip = screen.getByRole("button", { name: /^查看方案/ });
    await chooseFrom(/^查看方案/, "EV-201 方案 v2");
    expect(await screen.findByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看方案：EV-201 方案 v2" })).toBe(chip);
    await chooseFrom(/^查看方案/, "EV-201 方案 v1");
    expect(await screen.findByRole("heading", { name: "P-0201" })).toBeInTheDocument();
  });
});

describe("数据与证据 — which card is open", () => {
  it("opens the card the address names, by key or by id", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("target_hr"));
    expect(await screen.findByRole("heading", { name: "目标 HR" })).toBeInTheDocument();
  });

  it("opens a card named by its id too, and a click moves the address", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("asm_3"));
    expect(await screen.findByRole("heading", { name: "脱落率" })).toBeInTheDocument();
    await userEvent.click(document.querySelector("[data-vcr-assumption='asm_4']") as HTMLElement);
    expect(await screen.findByRole("heading", { name: "对照组 ORR" })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("card=orr_control");
  });

  // 关键假设 is the study's own flag, not "has a key".
  it("filters 关键假设 on the cards the designs rest on", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath());
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    // One chip, pressed or not — not a row of five.
    await userEvent.click(screen.getByRole("button", { name: "关键假设" }));
    const listed = [...document.querySelectorAll("[data-vcr-assumption]")].map((node) => node.getAttribute("data-vcr-assumption"));
    expect(listed).toEqual(["asm_1", "asm_2"]);
  });
});

describe("数据与证据 — the card's §6.1 fields", () => {
  it("shows the five-class source type, applicability, sensitivity and what uses the card", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    expect(within(detail()).getByText("外部证据")).toBeInTheDocument();
    expect(within(detail()).getByText("汇总")).toBeInTheDocument();
    expect(screen.getByText("二线 NSCLC，多西他赛单药；含中国人群的研究")).toBeInTheDocument();
    expect(screen.getByText("敏感性范围 3–5.6")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "方案 B 2:1 随机" })).toHaveAttribute("href", "/app/virtual-research/std_1/trial");
    expect(screen.getByRole("heading", { name: "改动记录" })).toBeInTheDocument();
    expect(screen.queryByText("版本记录")).toBeNull();
    // UI-27: no line beside a title that explains the system.
    expect(screen.queryByText("下游结果随版本重算")).toBeNull();
  });

  it("shows the countersignature's kind and time in the detail, with no 「已复核」 chip on the card, and no invented display name", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("orr_control"));
    await screen.findByRole("heading", { name: "对照组 ORR" });
    // The chip that used to say 「已复核（昨天）」 beside the title is gone (owner ruling 2026-10-10); who signed what, when, stays in the detail.
    expect(screen.queryByText(/已复核|复核后有变更/)).toBeNull();
    // A missing display name stays absent; immutable account ids are not names.
    expect(screen.getByText("统计复核 · 昨天")).toBeInTheDocument();
    expect(screen.queryByText(/u_stat/)).toBeNull();
    // A card already countersigned offers no second countersignature.
    expect(screen.queryByRole("button", { name: "签注复核" })).toBeNull();
  });

  it("links the quote's source only when it is an http(s) address", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    expect(screen.getByRole("link", { name: /打开原文/ })).toHaveAttribute("href", "https://example.org/NCT09900001");
  });

  it("does not turn an unsafe quote address into a link", async () => {
    const payload = fixture("ev201/data.json");
    payload.assumptions[0].detail.quoteLink = "javascript:alert(document.cookie)";
    server = installVcrServer(network.productRequest, { [`GET ${DATA}`]: payload });
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    expect(screen.getByText("— NCT09900001，第 6 页，表 2")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /打开原文/ })).toBeNull();
    expect(document.querySelector("a[href^='javascript']")).toBeNull();
  });

  // UI-20: a precedent opens to the registry's own words beside the normalised value.
  it("opens a precedent row to what the registry says, planned and actual in columns of their own", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath());
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    expect(screen.getByRole("columnheader", { name: "计划入组" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "实际入组" })).toBeInTheDocument();
    // The registry's own record opens in a drawer from the row; the number in its first cell is the keyboard's way in.
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(within(document.querySelector("[data-vcr-precedent='CTR20990001']") as HTMLElement).getByRole("button", { name: "打开 CTR20990001 的登记记录" }));
    const opened = await screen.findByRole("dialog", { name: "CTR20990001" });
    expect(opened.querySelector("[data-vcr-precedent-detail='CTR20990001']")).toHaveTextContent("多西他赛对照 III 期（中国人群）");
  });
});

describe("数据与证据 — 改这张卡", () => {
  // UI-8 / PB-18: the card's next version, with exactly the allow-listed body.
  it("writes the card's next version with the value, unit and note, then re-reads the tab", async () => {
    server = installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/assumptions`]: { id: "asm_9", key: "control_median_pfs", version: 2 },
    });
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    await userEvent.click(screen.getByRole("button", { name: "改这张卡" }));
    const value = screen.getByLabelText("取值");
    expect(value).toHaveValue(4.1);
    expect(screen.getByLabelText("单位")).toHaveValue("个月");
    expect(screen.getByLabelText("说明")).toHaveValue("7 项随机效应汇总");
    await userEvent.clear(value);
    await userEvent.type(value, "4.3");
    const reads = server.calls.filter((call) => call.path === DATA).length;
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/assumptions`, "POST", {
      key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 4.3, unit: "个月", note: "7 项随机效应汇总",
      // A person's value is an expert setting: it keeps the endpoint and applicability and no pooled evidence.
      endpoint: "PFS", applicability: { population: "二线 NSCLC，多西他赛单药", region: "含中国人群的研究", calibre: "overall" },
      sourceKind: "expert_set", valueSource: "assumed",
    }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已保存。"));
    await waitFor(() => expect(server.calls.filter((call) => call.path === DATA).length).toBe(reads + 1));
  });

  it("sends one version however often 保存 is pressed while it is in flight", async () => {
    let finish: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/assumptions`]: () => new Promise((resolve) => { finish = resolve; }),
    });
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("dropout_annual"));
    await screen.findByRole("heading", { name: "脱落率" });
    await userEvent.click(screen.getByRole("button", { name: "改这张卡" }));
    const form = document.querySelector("[data-vcr-assumption-edit]") as HTMLFormElement;
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    await userEvent.click(within(form).getByRole("button", { name: /保存/ }));
    const posts = server.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    // A card with no note sends no note.
    expect(posts[0].body).toEqual({ key: "dropout_annual", name: "脱落率", pointValue: 10, unit: "%/年", applicability: {}, sourceKind: "expert_set", valueSource: "assumed" });
    await act(async () => { finish({ version: 2 }); });
  });

  it("is not offered to a reader who may not write", async () => {
    const reader = study((raw) => { raw.abilities = ["read", "review_clinical"]; });
    drawTab(<DataTab studyId={STUDY_ID} study={reader} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    expect(screen.queryByRole("button", { name: "改这张卡" })).toBeNull();
  });
});

describe("数据与证据 — 签注复核", () => {
  // PB-19: a countersignature on the version on screen, of a kind the reader holds.
  it("lets the lead pick the kind, and signs the version on screen", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    await userEvent.click(screen.getByRole("button", { name: "签注复核" }));
    await userEvent.click(screen.getByRole("radio", { name: "统计复核" }));
    await userEvent.type(screen.getByLabelText("备注"), "核对过 7 项来源");
    await userEvent.click(screen.getByRole("button", { name: "签注" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/reviews`, "POST", {
      kind: "statistical", nodes: ["assumption:control_median_pfs@1"], note: "核对过 7 项来源",
    }));
    expect(toasts.success).toHaveBeenCalledWith("已签注统计复核。");
  });

  it("signs a clinical reviewer's own kind, with no choice to make", async () => {
    const reviewer = study((raw) => { raw.abilities = ["read", "review_clinical", "export"]; });
    drawTab(<DataTab studyId={STUDY_ID} study={reviewer} />, dataPath("target_hr"));
    await screen.findByRole("heading", { name: "目标 HR" });
    await userEvent.click(screen.getByRole("button", { name: "签注复核" }));
    expect(screen.queryByRole("radiogroup", { name: "复核类型" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "签注" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/reviews`, "POST", {
      kind: "clinical", nodes: ["assumption:target_hr@1"],
    }));
  });

  it("is not offered to a reader with no review role", async () => {
    const viewer = study((raw) => { raw.abilities = ["read"]; });
    drawTab(<DataTab studyId={STUDY_ID} study={viewer} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    expect(screen.queryByRole("button", { name: "签注复核" })).toBeNull();
  });
});
