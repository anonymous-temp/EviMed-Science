import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy } from "@/lib/vcrClient";
import {
  NotApplicableCard, NotEstimableCard, PartialResultNote, Stale, StaleBar, VcrOffPage, VcrStepFailed, VcrStepPending, VCR_OFF_SENTENCE,
} from "./VcrStates";
import { VCR_DEFERRED_SENTENCE } from "./useVcrRun";
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

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);
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
  it("says one quiet line while it is being worked on, and offers nothing to press", () => {
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("trial", { status: "running" })} step="trial" />);
    expect(screen.getByText("正在进行，做完会显示在这里。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
  });

  // 「正在排队」 was a lie for a study nobody has described: nothing is queued, it waits for its first sentence.
  describe("on a study nobody has described", () => {
    it("says so in the words of what is missing, with the way to the conversation — in every step's tab", async () => {
      for (const step of ["definition", "evidence", "population", "patients", "comparator", "trial", "matching"] as const) {
        const { unmount } = draw(<VcrStepPending studyId={EMPTY_STUDY_ID} study={emptyStudy()} step={step} />);
        expect(screen.getByText("先在对话里说一句要研究什么")).toBeInTheDocument();
        expect(screen.queryByText(/正在排队|开始后|写好后/)).toBeNull();
        unmount();
      }
    });

    it("keeps 让 AI 做 in view and not pressable until a definition exists, and 去对话 opens the study's conversation", async () => {
      installVcrServer(network.productRequest);
      draw(<VcrStepPending studyId={EMPTY_STUDY_ID} study={emptyStudy()} step="evidence" />);
      const ask = screen.getByRole("button", { name: "让 AI 做" });
      expect(ask).toBeDisabled();
      await userEvent.click(ask);
      expect(network.productRequest.mock.calls.some(([path]) => String(path).endsWith("/run"))).toBe(false);
      await userEvent.click(screen.getByRole("button", { name: "去对话" }));
      await waitFor(() => expect(store.select).toHaveBeenCalledWith("prj_empty", expect.any(Function)));
    });

    it("shows a reader who cannot run a step no 让 AI 做 at all", () => {
      const study = emptyStudy();
      study.abilities = ["read"];
      draw(<VcrStepPending studyId={EMPTY_STUDY_ID} study={study} step="evidence" />);
      expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "去对话" })).toBeInTheDocument();
    });
  });

  it("says a step that was asked for on a described study is arranged, with no queue it could be stuck in", () => {
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("patients", { status: "none", requested: true })} step="patients" />);
    expect(screen.getByText("已安排，开始后这里会显示进度。")).toBeInTheDocument();
  });

  it("says what each step starts from: the empty population names what the AI will make and what T1 adds; a hint, where one is given, replaces the step's sentence", () => {
    const { unmount } = draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("population", { status: "none", requested: false })} step="population" />);
    expect(screen.getByText("还没有人群：AI 会按研究定义生成一批情景人群；接入你的数据（T1 及以上）后，也可以筛出真实队列。")).toBeInTheDocument();
    unmount();
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("matching", { status: "none", requested: false })} step="matching" hint="只有公开资料时的一句话。" />);
    expect(screen.getByText("只有公开资料时的一句话。")).toBeInTheDocument();
    expect(screen.queryByText(/还没有匹配评估/)).toBeNull();
    // A hint never hides the button, and never replaces a state: a step that is running says so.
  });

  it("does not let a hint stand in for a step's state: a running step says it is running", () => {
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("matching", { status: "running" })} step="matching" hint="只有公开资料时的一句话。" />);
    expect(screen.getByText("正在进行，做完会显示在这里。")).toBeInTheDocument();
    expect(screen.queryByText("只有公开资料时的一句话。")).toBeNull();
  });

  // 「让 AI 做」 starts the step in the study's own conversation: there is no
  // second composer on the study page.
  it("offers 让 AI 做, which starts the step in the study's conversation", async () => {
    installVcrServer(network.productRequest);
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("evidence", { status: "none", requested: false })} step="evidence" />);
    await userEvent.click(screen.getByRole("button", { name: "让 AI 做" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "evidence" }));
    await waitFor(() => expect(store.select).toHaveBeenCalledWith("prj_ev201", expect.any(Function)));
  });

  // A step asked for twice is two runs: the second click does nothing (CW-18).
  it("holds one request at a time while it waits for the answer", async () => {
    let release: (value: unknown) => void = () => {};
    installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/run`]: () => new Promise((resolve) => { release = resolve; }),
    });
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("evidence", { status: "none", requested: false })} step="evidence" />);
    const button = screen.getByRole("button", { name: "让 AI 做" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(network.productRequest.mock.calls.filter(([path]) => String(path).endsWith("/run"))).toHaveLength(1);
    release({ sessionId: "ses_1", runId: "run_1" });
    await waitFor(() => expect(store.select).toHaveBeenCalled());
  });

  // Starting a step is `run`'s: a reader who cannot start one is told what the
  // step needs, and is not offered a button the route would refuse.
  it("offers no 让 AI 做 to a reader who cannot run a step", () => {
    const study = evWithStep("evidence", { status: "none", requested: false });
    study.abilities = ["read", "review_clinical", "export"];
    draw(<VcrStepPending studyId={STUDY_ID} study={study} step="evidence" />);
    expect(document.querySelector("[data-vcr-step-empty='evidence']")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
  });

  // A run that could not start now stays on the page with one sentence (CW-19).
  it("stays on the page and says the run is queued behind the previous one", async () => {
    installVcrServer(network.productRequest, { [`POST /vcr/studies/${STUDY_ID}/run`]: { sessionId: null, runId: null, deferred: "another_run_active" } });
    draw(<VcrStepPending studyId={STUDY_ID} study={evWithStep("evidence", { status: "none", requested: false })} step="evidence" />);
    await userEvent.click(screen.getByRole("button", { name: "让 AI 做" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(VCR_DEFERRED_SENTENCE));
    expect(store.select).not.toHaveBeenCalled();
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
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
  });
});
