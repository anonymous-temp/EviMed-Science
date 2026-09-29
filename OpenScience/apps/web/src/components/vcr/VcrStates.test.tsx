import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotApplicableCard, NotEstimableCard, PartialResultNote, Stale, StaleBar, VcrOffPage, VcrStepPending, VCR_OFF_SENTENCE } from "./VcrStates";
import { study } from "./__fixtures__/vcrStudy";

const client = vi.hoisted(() => ({ runVcrStep: vi.fn() }));
vi.mock("@/lib/vcrClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vcrClient")>()),
  ...client,
}));

const store = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_1" }], select: store.select, load: store.load }) },
}));

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

beforeEach(() => {
  client.runVcrStep.mockReset();
  client.runVcrStep.mockResolvedValue({ sessionId: "ses_1" });
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
  // on screen — greyed, under the bar that says a recomputation is queued.
  it("keeps its numbers on screen under a bar that says why", () => {
    draw(<Stale stale reason="人群 v2 因入排条件 I6 修改"><p>成功把握 71%</p></Stale>);
    expect(screen.getByText("成功把握 71%")).toBeInTheDocument();
    expect(screen.getByText(/输入已变更，排队重算中/)).toBeInTheDocument();
    expect(screen.getByText(/人群 v2 因入排条件 I6 修改/)).toBeInTheDocument();
  });

  it("draws nothing extra when it is not stale", () => {
    draw(<Stale stale={false}><p>成功把握 71%</p></Stale>);
    expect(screen.queryByText(/排队重算中/)).not.toBeInTheDocument();
  });

  it("says the same sentence on its own", () => {
    draw(<StaleBar />);
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
    draw(<VcrStepPending studyId="std_1" study={study({ steps: { trial: { status: "running" } } })} step="trial" />);
    expect(screen.getByText("正在进行，做完会显示在这里。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
  });

  it("says what it waits for when it was asked for but its input is not ready", () => {
    draw(<VcrStepPending studyId="std_1" study={study({ steps: { patients: { status: "none", requested: true } } })} step="patients" />);
    expect(screen.getByText("人群版本定下来后开始生成虚拟患者。")).toBeInTheDocument();
  });

  // 「让 AI 做」 starts the step in the study's own conversation: there is no
  // second composer on the study page.
  it("offers 让 AI 做, which starts the step in the study's conversation", async () => {
    draw(<VcrStepPending studyId="std_1" study={study({ steps: { matching: { status: "none" } } })} step="matching" />);
    await userEvent.click(screen.getByRole("button", { name: "让 AI 做" }));
    await waitFor(() => expect(client.runVcrStep).toHaveBeenCalledWith("std_1", "matching"));
    await waitFor(() => expect(store.select).toHaveBeenCalledWith("prj_1", expect.any(Function)));
  });
});
