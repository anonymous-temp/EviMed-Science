import { render, screen } from "@testing-library/react";
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
              contractKind: "clinical-evidence-package",
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
    expect(screen.getByRole("button")).toHaveTextContent("已重试 3 次");
  });
});
