import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { RunStreamThread } from "./RunStreamThread";
import { emptyRunView, type RunView } from "@/lib/runStream";

function view(overrides: Partial<RunView> = {}): RunView {
  return { ...emptyRunView("run-1"), ...overrides };
}

const noop = () => {};

describe("what one run shows a person", () => {
  it("names its state in the user's language rather than an identifier", () => {
    render(<RunStreamThread view={view({ state: "succeeded" })} status="settled" retries={0} onReconnect={noop} />);
    expect(screen.getByText("已交付")).toBeInTheDocument();
  });

  it("shows a rejected deliverable's reasons while the run is still repairing", () => {
    // The gate returns its verdict as a value and the run patches in place, so
    // a user watching a second attempt should be able to see what the first was
    // rejected for — not learn it from a final failure.
    render(
      <RunStreamThread
        view={view({
          state: "running",
          attempts: 2,
          deliverables: [
            {
              id: "d1",
              contractKind: "clinical-evidence-report",
              capability: "clinical-evidence-synthesis",
              title: "二甲双胍证据综述",
              childSessionId: null,
              status: "rejected",
              issues: [
                { code: "claim_unquoted", message: "第 3 条结论没有逐字引用支撑", severity: "required", path: "report.md" },
                { code: "section_share", message: "背景章节占比偏高", severity: "advisory" },
              ],
            },
          ],
        })}
        status="live"
        retries={0}
        onReconnect={noop}
      />,
    );
    expect(screen.getByText("第 2 次提交")).toBeInTheDocument();
    expect(screen.getByText(/第 3 条结论没有逐字引用支撑/)).toBeInTheDocument();
    expect(screen.getByText("[必须修正]")).toBeInTheDocument();
    expect(screen.getByText("[建议修正]")).toBeInTheDocument();
  });

  it("says so when it fell behind the replay buffer instead of showing a partial run as whole", () => {
    render(
      <RunStreamThread
        view={view({ state: "running", missedRange: { since: 12, resumedAt: 41 } })}
        status="live"
        retries={0}
        onReconnect={noop}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("12–41");
  });

  it("counts events this build cannot render rather than dropping them", () => {
    render(
      <RunStreamThread
        view={view({ state: "running", unknownEvents: { "hook/invoked": 2, "tool-workflow/agent-start": 1 } })}
        status="live"
        retries={0}
        onReconnect={noop}
      />,
    );
    expect(screen.getByText("3 条本版本尚不能展示的事件")).toBeInTheDocument();
  });

  it("offers a reconnect rather than retrying silently behind a spinner", () => {
    render(<RunStreamThread view={view({ state: "running" })} status="error" retries={3} onReconnect={noop} />);
    expect(screen.getByRole("button", { name: /已重试 3 次/ })).toBeInTheDocument();
  });

  it("shows the budget ceiling the run actually declared, not a key nothing sends", () => {
    // `projectRunState` emits `limits: { maxSteps, maxTokens, maxChildren }`
    // and the footer asked for `limits.steps`. `undefined` is falsy, so the
    // "/ ceiling" half never rendered and a budgeted run read as an unbounded
    // one — a disagreement between two files with no error anywhere.
    render(
      <RunStreamThread
        view={view({ state: "running", budget: { steps: 12, tokens: 4000, children: 2, limits: { maxSteps: 100, maxTokens: 500000, maxChildren: 5 } } })}
        status="live"
        retries={0}
        onReconnect={noop}
      />,
    );
    expect(screen.getByText(/步骤 12 \/ 100/)).toBeInTheDocument();
    expect(screen.getByText(/令牌 4000 \/ 500000/)).toBeInTheDocument();
  });

  it("draws the run tree: which child was given what, and which contract judges it", () => {
    // The reason the tree exists: a delegating run says nothing in the
    // transcript while its children work, and that silence looks exactly like a
    // dead run. The tree is what distinguishes them.
    render(
      <RunStreamThread
        view={view({
          state: "running",
          subagents: [{ childSessionId: "c1", label: "证据综述子代理", capability: "clinical-evidence-synthesis", status: "running", report: "已检索 42 篇" }],
          deliverables: [{
            id: "d1",
            contractKind: "clinical-evidence-report",
            capability: "clinical-evidence-synthesis",
            title: "二甲双胍证据综述",
            childSessionId: "c1",
            status: "accepted",
            issues: [],
            receipt: {
              deliverableId: "d1",
              contractKind: "clinical-evidence-report",
              capability: "clinical-evidence-synthesis",
              attempt: 2,
              acceptedAt: "2026-08-31T10:00:00Z",
              files: [{ path: "clinical-evidence-report.md", sha256: "b".repeat(64), bytes: 4096 }],
              notices: [],
            },
          }],
        })}
        status="live"
        retries={0}
        onReconnect={noop}
      />,
    );
    expect(screen.getByText("运行树")).toBeInTheDocument();
    expect(screen.getByText("编排器")).toBeInTheDocument();
    expect(screen.getByText("证据综述子代理")).toBeInTheDocument();
    expect(screen.getByText("已检索 42 篇")).toBeInTheDocument();
    // The contract kind is shown in the reader's language, from the domain's
    // own label table — not as the identifier the wire carries.
    expect(screen.getByText("临床证据综述")).toBeInTheDocument();
    expect(screen.getByText("回执 · 第 2 次提交")).toBeInTheDocument();
  });

  it("shows a request from the kernel, and names the missing answer channel instead of a button that cannot work", async () => {
    // The listener is the fix; this is what the reader sees because of it. With
    // no `onAnswerInteraction` the deployment has no way to reply, and saying
    // so is the difference between a blocked run and a page that looks idle.
    render(
      <RunStreamThread
        view={view({
          state: "running",
          interactions: [{
            requestId: "r1",
            kind: "approval",
            prompt: "运行需要访问工作区之外的路径",
            tool: "bash",
            options: [],
            answered: false,
          }],
        })}
        status="live"
        retries={0}
        onReconnect={noop}
      />,
    );
    expect(screen.getByText("运行请求你的批准")).toBeInTheDocument();
    expect(screen.getByText("运行需要访问工作区之外的路径")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("fail-closed");
    expect(screen.queryByRole("button", { name: "允许一次" })).toBeNull();
  });

  it("lets a person answer once the deployment has a channel", async () => {
    const answers: { requestId: string; decision: string }[] = [];
    render(
      <RunStreamThread
        view={view({
          state: "running",
          interactions: [{
            requestId: "q1",
            kind: "question",
            prompt: "要包含 2019 年前的文献吗？",
            tool: "",
            options: [{ id: "yes", label: "要" }, { id: "no", label: "不要" }],
            answered: false,
          }],
        })}
        status="live"
        retries={0}
        onReconnect={noop}
        onAnswerInteraction={async (answer) => {
          answers.push({ requestId: answer.requestId, decision: answer.decision });
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "要" }));
    expect(answers).toEqual([{ requestId: "q1", decision: "answer" }]);
  });
});
