import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { readVcrStudy } from "@/lib/vcrClient";
import {
  NotApplicableCard, NotEstimableCard, PartialResultNote, Stale, StaleBar, VcrOffPage, VcrStepFailed, VcrStepPending, VCR_OFF_SENTENCE,
} from "./VcrStates";
import { EMPTY_STUDY_ID, fixture, installVcrServer, STUDY_ID } from "./__fixtures__/serverFixtures";

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

/** Where the page is, after a button was pressed: a start must leave it where it was. */
function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
const draw = (node: React.ReactElement) => render(<MemoryRouter initialEntries={["/app/virtual-research/std_1/patients"]}>{node}<Where /></MemoryRouter>);
/** The study as the readers turn the server's own answer into a page's props. */
const emptyStudy = () => readVcrStudy(fixture("empty/study.json"));
const ev201 = () => readVcrStudy(fixture("ev201/study.json"));

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  store.select.mockClear();
});

describe("the module being off", () => {
  it("is one sentence and nothing to click", () => {
    draw(<VcrOffPage />);
    expect(screen.getByText(VCR_OFF_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("「不可估计」", () => {
  // It is a finished scientific result, not a blank and not a zero.
  it("lists what is missing and what each missing thing would answer", () => {
    draw(
      <NotEstimableCard
        needs="需要 T2 · 完整治疗与纵向结局"
        items={[
          { title: "同期治疗记录", detail: "后续治疗线", answers: "换药按治疗策略处理" },
          { title: "ECOG 缺失 38%", answers: "把 ECOG 纳入熵平衡" },
        ]}
        conclusion="两项补齐后可估计"
      />,
    );
    expect(screen.getByText("不可估计")).toBeInTheDocument();
    expect(screen.getByText("缺 2 项数据")).toBeInTheDocument();
    expect(screen.getByText("同期治疗记录")).toBeInTheDocument();
    expect(screen.getByText("换药按治疗策略处理")).toBeInTheDocument();
    expect(screen.getByText("两项补齐后可估计")).toBeInTheDocument();
    // Never drawn as zero.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});

describe("a stale result", () => {
  // The numbers were true of the inputs they were computed from, so they stay
  // on screen — greyed, under the bar that says why.
  it("keeps its numbers on screen under a bar that says why and that a recomputation is queued", () => {
    draw(<Stale note={{ reason: "入排条件已变更", queued: true }}><p>成功把握 71%</p></Stale>);
    expect(screen.getByText("成功把握 71%")).toBeInTheDocument();
    expect(screen.getByText(/入排条件已变更 · 输入已变更，排队重算中/)).toBeInTheDocument();
    expect(document.querySelector("[data-vcr-stale]")).not.toBeNull();
    expect(document.querySelector("[data-vcr-stale-block] .opacity-disabled")).toHaveTextContent("成功把握 71%");
  });

  // The bar promises a queue only when one exists (CW-16).
  it("does not promise a queue that is not there", () => {
    draw(<Stale note={{ reason: "假设卡已变更", queued: false }}><p>成功把握 71%</p></Stale>);
    expect(screen.queryByText(/排队重算中/)).not.toBeInTheDocument();
    expect(screen.getByText(/输入已变更，这些数字可能已过期/)).toBeInTheDocument();
  });

  it("draws nothing extra when it is not stale", () => {
    draw(<Stale note={null}><p>成功把握 71%</p></Stale>);
    expect(screen.queryByText(/输入已变更/)).not.toBeInTheDocument();
  });

  it("says the same sentence on its own", () => {
    draw(<StaleBar queued />);
    expect(screen.getByText("输入已变更，排队重算中")).toBeInTheDocument();
  });
});

describe("a computation that stopped part-way", () => {
  const sentence = "这次模拟算完了 18,000 / 20,000 次重复就到了计算时间上限，下面是已完成部分的结果。";

  it("is one line in Chinese: how far it got, why it stopped, and that what is below is what was done", () => {
    draw(<PartialResultNote sentence={sentence} />);
    const note = document.querySelector("[data-vcr-partial]")!;
    expect(note).toHaveTextContent(sentence);
    // One box, one sentence: no second 「已完成的部分保留 / 未完成」 pair, nothing to press when no step is named.
    expect(document.querySelectorAll("[data-vcr-partial]")).toHaveLength(1);
    expect(note).not.toHaveTextContent(/已完成的部分保留|未完成/);
    expect(note.textContent).not.toMatch(/[A-Za-z]{4,}/);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers 「续算」 to a reader who may run the step, and it asks for that step again", async () => {
    installVcrServer(network.productRequest);
    const study = ev201();
    study.steps.trial = { status: "done", requested: true } as never;
    draw(<PartialResultNote sentence={sentence} resume={{ studyId: STUDY_ID, study, step: "trial" }} />);
    await userEvent.click(screen.getByRole("button", { name: "续算" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "trial" }));
  });

  it("offers it to nobody who may not run a step, and not while the step is already going on", () => {
    const reader = ev201();
    reader.abilities = ["read"];
    reader.steps.trial = { status: "done", requested: true } as never;
    const { unmount } = draw(<PartialResultNote sentence={sentence} resume={{ studyId: STUDY_ID, study: reader, step: "trial" }} />);
    expect(screen.queryByRole("button", { name: "续算" })).not.toBeInTheDocument();
    unmount();
    const running = ev201();
    running.steps.trial = { status: "running", requested: true } as never;
    draw(<PartialResultNote sentence={sentence} resume={{ studyId: STUDY_ID, study: running, step: "trial" }} />);
    expect(screen.queryByRole("button", { name: "续算" })).not.toBeInTheDocument();
  });
});

describe("a model or a route that cannot apply", () => {
  it("names the reason and the ways round it, and invents nothing", () => {
    draw(
      <NotApplicableCard
        title="预后校正：不适用"
        reason="单臂设计没有随机数据。"
        options={["换一个合适的模型", "用文献模型或情景模型"]}
      />,
    );
    expect(screen.getByText("预后校正：不适用")).toBeInTheDocument();
    expect(screen.getByText("单臂设计没有随机数据。")).toBeInTheDocument();
    expect(screen.getByText("换一个合适的模型")).toBeInTheDocument();
  });
});

/** The EV-201 study — which has a definition — with one step put in a state: what a step says when it is the step that has nothing. */
const evWithStep = (step: string, fields: Record<string, unknown>) => {
  const raw = fixture("ev201/study.json");
  raw.steps[step] = { ...raw.steps[step], ...fields };
  return readVcrStudy(raw);
};

describe("a step with nothing yet", () => {
  it("says what is being done and offers to stop it, while the step runs — never a lone 「正在进行」", () => {
    const raw = fixture("ev201/study.json");
    raw.steps.trial = { ...raw.steps.trial, status: "running" };
    raw.activity = null;
    draw(<VcrStepPending studyId={STUDY_ID} study={readVcrStudy(raw)} step="trial" />);
    const state = document.querySelector("[data-step-state='running']") as HTMLElement;
    expect(state).toHaveTextContent("正在模拟试验方案");
    expect(screen.queryByText("正在进行，做完会显示在这里。")).toBeNull();
    // Stopping is the run's: with no run or job the study reports, there is nothing to stop and no button for it.
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  });

  it("shows the engine job that works on the step: its done of total, and the way to stop it", () => {
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("trial", { status: "running" })} step="trial" />);
    const state = document.querySelector("[data-step-state='running']") as HTMLElement;
    expect(state).toHaveTextContent("计算 3 / 10");
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
  });

  it("names the run that covers the step, how far it has counted and for how long, and stops it from here", async () => {
    installVcrServer(network.productRequest);
    const raw = fixture("ev201/study.json");
    raw.steps.trial = { ...raw.steps.trial, status: "running" };
    raw.activity = {
      run: { id: "run_9", step: "trial", steps: ["trial"], label: "模拟试验方案", phase: "search", counts: { search: 6, included: 23 },
        startedAt: new Date(Date.now() - 125_000).toISOString(), placement: "open-runtime", locked: false },
      queue: [], jobs: [], last: null,
    };
    draw(<VcrStepPending studyId={STUDY_ID} study={readVcrStudy(raw)} step="trial" />);
    const state = document.querySelector("[data-step-state='running']") as HTMLElement;
    expect(state).toHaveTextContent("正在模拟试验方案");
    expect(state).toHaveTextContent("检索 6 次 · 纳入 23 篇");
    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/cancel`, "POST", {}));
  });

  // 「正在排队」 was a lie for a study nobody has described: nothing is queued, it waits for its first sentence.
  describe("on a study nobody has described", () => {
    it("says so in the words of what is missing, with the one button to the conversation — in every step's tab", async () => {
      for (const step of ["definition", "evidence", "population", "patients", "comparator", "trial", "matching"] as const) {
        const { unmount } = draw(<VcrStepPending studyId={EMPTY_STUDY_ID} study={emptyStudy()} step={step} />);
        expect(screen.getByText("先在对话里说一句要研究什么")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "说明研究问题" })).toBeInTheDocument();
        expect(screen.queryByText(/正在排队|开始后|写好后/)).toBeNull();
        // A step that cannot start yet is not offered a start that is pressed in vain.
        expect(screen.queryByRole("button", { name: "让 AI 做" })).toBeNull();
        unmount();
      }
    });

    it("opens the study's conversation view, in the same page, from that button", async () => {
      draw(<VcrStepPending studyId={EMPTY_STUDY_ID} study={emptyStudy()} step="evidence" />);
      await userEvent.click(screen.getByRole("button", { name: "说明研究问题" }));
      expect(screen.getByTestId("where")).toHaveTextContent("/app/virtual-research/std_2/chat");
      expect(store.select).not.toHaveBeenCalled();
    });
  });

  it("puts a step that was asked for on a described study in line, with no queue it could be stuck in and no sentence about it", () => {
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("patients", { status: "none", requested: true })} step="patients" />);
    const state = document.querySelector("[data-step-state='queued']") as HTMLElement;
    expect(state).toHaveTextContent("生成虚拟患者，排队中");
    expect(screen.queryByText("已安排，开始后这里会显示进度。")).toBeNull();
  });

  it("lets a person stop a step that is only in line — the cancel holds the programme, with nothing out to stop", async () => {
    installVcrServer(network.productRequest);
    const raw = fixture("ev201/study.json");
    raw.steps.patients = { ...raw.steps.patients, status: "none", requested: true };
    draw(<VcrStepPending studyId={STUDY_ID} study={readVcrStudy(raw)} step="patients" />);
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/cancel`, "POST", {}));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/virtual-research/std_1/patients");
  });

  it("offers no 取消 on a step that is in line to a reader who may not run one", () => {
    const raw = fixture("ev201/study.json");
    raw.steps.patients = { ...raw.steps.patients, status: "none", requested: true };
    raw.abilities = ["read"];
    draw(<VcrStepPending studyId={STUDY_ID} study={readVcrStudy(raw)} step="patients" />);
    expect(document.querySelector("[data-step-state='queued']")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  // A cancel holds the programme: a held step is not in line — it was stopped, and only a person's press starts it again.
  it("offers a step a cancel held its start like one never asked for, and does not call it queued", () => {
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("patients", { status: "none", requested: true, held: true })} step="patients" />);
    expect(document.querySelector("[data-step-state='queued']")).toBeNull();
    expect(document.querySelector("[data-step-state='empty']")).not.toBeNull();
    expect(screen.getByRole("button", { name: "生成虚拟患者" })).toBeInTheDocument();
  });

  it("says what a queued step waits for, from the study's own account of its queue", () => {
    const raw = fixture("ev201/study.json");
    raw.steps.patients = { ...raw.steps.patients, status: "queued", requested: true };
    raw.activity = { run: { id: "run_1", step: "evidence", steps: ["evidence"], label: "找证据、整理假设卡", phase: null, counts: {}, startedAt: null, placement: "open-runtime", locked: false },
      queue: [{ step: "patients", waitingFor: "evidence" }], jobs: [], last: null };
    draw(<VcrStepPending studyId={STUDY_ID} study={readVcrStudy(raw)} step="patients" />);
    expect(document.querySelector("[data-step-state='queued']")).toHaveTextContent("“证据”做完后自动开始");
  });

  it("is a recipe when nothing has been done: what the step uses, each a link to where it comes from, what it gives, and one button — verb and object", () => {
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("population", { status: "none", requested: false })} step="population" />);
    const state = document.querySelector("[data-step-state='empty']") as HTMLElement;
    expect(state).toHaveTextContent("还没有人群");
    expect(state).toHaveTextContent("用 研究定义 v1 · 4 张假设卡");
    expect(screen.getByRole("link", { name: "研究定义 v1" })).toHaveAttribute("href", "/app/virtual-research/std_1/data");
    expect(state).toHaveTextContent("得到 一批情景人群；接入数据（T1 及以上）后也可以筛出真实队列");
    expect(screen.getByRole("button", { name: "构建人群" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).toBeNull();
  });

  it("lets a hint replace what the step gives, and never stand in for a step's state: a running step says it is running", () => {
    const { unmount } = draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("matching", { status: "none", requested: false })} step="matching" hint="只有公开资料时的一句话。" />);
    expect(screen.getByText(/得到 只有公开资料时的一句话。/)).toBeInTheDocument();
    expect(screen.queryByText(/逐条入排判定/)).toBeNull();
    unmount();
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("matching", { status: "running" })} step="matching" hint="只有公开资料时的一句话。" />);
    expect(document.querySelector("[data-step-state='running']")).not.toBeNull();
    expect(screen.queryByText(/只有公开资料时的一句话。/)).toBeNull();
  });

  // The button starts the step and takes the reader nowhere: the page's strip says what happens next.
  it("starts the step from its button and stays where it is — there is no conversation to be sent to", async () => {
    installVcrServer(network.productRequest);
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("evidence", { status: "none", requested: false })} step="evidence" />);
    await userEvent.click(screen.getByRole("button", { name: "找证据、整理假设卡" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "evidence" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/virtual-research/std_1/patients");
    expect(store.select).not.toHaveBeenCalled();
  });

  // A step asked for twice is two runs: the second click does nothing (CW-18).
  it("holds one request at a time while it waits for the answer", async () => {
    let release: (value: unknown) => void = () => {};
    installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/run`]: () => new Promise((resolve) => { release = resolve; }),
    });
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("evidence", { status: "none", requested: false })} step="evidence" />);
    const button = screen.getByRole("button", { name: "找证据、整理假设卡" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(network.productRequest.mock.calls.filter(([path]) => String(path).endsWith("/run"))).toHaveLength(1);
    release({ accepted: true, runId: "run_1", step: "evidence", queuedBehind: [] });
    await waitFor(() => expect(button).not.toHaveAttribute("aria-busy", "true"));
  });

  // Starting a step is `run`'s: a reader who cannot start one is told why, and is not offered a button the route would refuse.
  it("offers no start to a reader who cannot run a step, and says whose it is", () => {
    const study = evWithStep("evidence", { status: "none", requested: false });
    study.abilities = ["read", "review_clinical", "export"];
    draw(<VcrStepPending studyId={STUDY_ID} study={study} step="evidence" />);
    expect(document.querySelector("[data-vcr-step-empty='evidence']")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "找证据、整理假设卡" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-empty][data-reason]")).not.toBeNull();
  });

  // A start that cannot be taken says the sentence of what holds the project, not 「定时任务」.
  it("says what holds a project that cannot take the start — a study's own step is not a scheduled task", async () => {
    installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/run`]: () => {
        throw new WebApiError("held", { status: 423, code: "runtime_reserved_for_autopilot", details: { reason: "module-step" } });
      },
    });
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("evidence", { status: "none", requested: false })} step="evidence" />);
    await userEvent.click(screen.getByRole("button", { name: "找证据、整理假设卡" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    const said = String(toasts.error.mock.calls[0][0]);
    expect(said).toContain("研究里的一个步骤");
    expect(said).not.toContain("定时任务");
  });
});

describe("a step that did not finish", () => {
  // A failed step is not one that never ran (plan §9.6): it says it did not
  // finish, what it kept, and offers to go on from where it stopped.
  it("says so, keeps what it computed in view, and offers to go on", async () => {
    installVcrServer(network.productRequest);
    const study = ev201();
    expect(study.steps.patients?.status).toBe("failed");
    draw(
      <VcrStepFailed
        studyId={STUDY_ID}
        study={study}
        step="patients"
        partial={{ sentence: "这次生成算完了 1,200 / 2,000 次重复就停下了，下面是已完成部分的结果。" }}
      />,
    );
    expect(screen.getByText("这一步未完成")).toBeInTheDocument();
    expect(screen.getByText(/这一次运行只完成了一部分/)).toBeInTheDocument();
    expect(screen.getByText(/算完了 1,200 \/ 2,000 次重复就停下了/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "接着做" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "patients" }));
  });

  it("offers no way to continue to a reader who cannot run a step", () => {
    const study = ev201();
    study.abilities = ["read"];
    draw(<VcrStepFailed studyId={STUDY_ID} study={study} step="patients" />);
    expect(screen.getByText("这一步未完成")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "接着做" })).not.toBeInTheDocument();
  });

  it("is what a step with nothing to show says when it failed, instead of the empty offer", () => {
    draw(<VcrStepPending studyId={STUDY_ID} study={ev201()} step="patients" />);
    expect(screen.getByText("这一步未完成")).toBeInTheDocument();
    expect(document.querySelector("[data-step-state='empty']")).toBeNull();
  });
});
