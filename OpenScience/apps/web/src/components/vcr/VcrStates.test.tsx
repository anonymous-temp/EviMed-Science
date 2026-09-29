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

describe("a computation that failed part-way", () => {
  it("names what was kept and what was not, rather than losing both", () => {
    draw(<PartialResultNote done="方案 A、B 的零假设情景各 20,000 次" missing="方案 C 的备择情景" />);
    expect(screen.getByText(/方案 A、B 的零假设情景各 20,000 次/)).toBeInTheDocument();
    expect(screen.getByText(/未完成：方案 C 的备择情景/)).toBeInTheDocument();
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

describe("a step with nothing yet", () => {
  it("says one quiet line while it is being worked on, and offers nothing to press", () => {
    const study = emptyStudy();
    study.steps.trial = { status: "running" };
    draw(<VcrStepPending studyId={EMPTY_STUDY_ID} study={study} step="trial" />);
    expect(screen.getByText("正在进行，做完会显示在这里。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
  });

  it("says what it waits for when it was asked for but its input is not ready", () => {
    draw(<VcrStepPending studyId={EMPTY_STUDY_ID} study={emptyStudy()} step="patients" />);
    expect(screen.getByText("人群版本定下来后开始生成虚拟患者。")).toBeInTheDocument();
  });

  // 「让 AI 做」 starts the step in the study's own conversation: there is no
  // second composer on the study page.
  it("offers 让 AI 做, which starts the step in the study's conversation", async () => {
    installVcrServer(network.productRequest);
    draw(<VcrStepPending studyId={EMPTY_STUDY_ID} study={emptyStudy()} step="evidence" />);
    await userEvent.click(screen.getByRole("button", { name: "让 AI 做" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${EMPTY_STUDY_ID}/run`, "POST", { step: "evidence" }));
    await waitFor(() => expect(store.select).toHaveBeenCalledWith("prj_empty", expect.any(Function)));
  });

  // A step asked for twice is two runs: the second click does nothing (CW-18).
  it("holds one request at a time while it waits for the answer", async () => {
    let release: (value: unknown) => void = () => {};
    installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${EMPTY_STUDY_ID}/run`]: () => new Promise((resolve) => { release = resolve; }),
    });
    draw(<VcrStepPending studyId={EMPTY_STUDY_ID} study={emptyStudy()} step="evidence" />);
    const button = screen.getByRole("button", { name: "让 AI 做" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(network.productRequest.mock.calls.filter(([path]) => String(path).endsWith("/run"))).toHaveLength(1);
    release({ sessionId: "ses_1", runId: "run_1" });
    await waitFor(() => expect(store.select).toHaveBeenCalled());
  });

  // A run that could not start now stays on the page with one sentence (CW-19).
  it("stays on the page and says the run is queued behind the previous one", async () => {
    installVcrServer(network.productRequest, { [`POST /vcr/studies/${EMPTY_STUDY_ID}/run`]: { sessionId: null, runId: null, deferred: "another_run_active" } });
    draw(<VcrStepPending studyId={EMPTY_STUDY_ID} study={emptyStudy()} step="evidence" />);
    await userEvent.click(screen.getByRole("button", { name: "让 AI 做" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(VCR_DEFERRED_SENTENCE));
    expect(store.select).not.toHaveBeenCalled();
  });
});

describe("a step that did not finish", () => {
  // A failed step is not one that never ran (plan §9.6): it says it did not
  // finish, what it kept, and offers to go on from where it stopped.
  it("says so, keeps what it computed in view, and offers to continue from the checkpoint", async () => {
    installVcrServer(network.productRequest);
    const study = ev201();
    expect(study.steps.patients?.status).toBe("failed");
    draw(
      <VcrStepFailed
        studyId={STUDY_ID}
        study={study}
        step="patients"
        partial={{ done: "已算完 1,200 / 2,000 次重复的结果", missing: "其余重复没有做完，可以从检查点续跑" }}
      />,
    );
    expect(screen.getByText("这一步未完成")).toBeInTheDocument();
    expect(screen.getByText(/这一次运行只完成了一部分/)).toBeInTheDocument();
    expect(screen.getByText(/已算完 1,200 \/ 2,000 次重复的结果/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "从检查点续跑" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "patients" }));
  });

  it("is what a step with nothing to show says when it failed, instead of the empty offer", () => {
    draw(<VcrStepPending studyId={STUDY_ID} study={ev201()} step="patients" />);
    expect(screen.getByText("这一步未完成")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
  });
});
