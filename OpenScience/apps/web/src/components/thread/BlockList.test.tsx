import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BlockList } from "./BlockList";

describe("BlockList", () => {
  it("feeds a running task row the live activity of its subagent", () => {
    render(
      <BlockList
        blocks={[
          { kind: "tool-call", title: "Visual QA for slides", status: "running", childSessionId: "ses_child" },
        ]}
        handlers={{
          subagentActivity: (id) => (id === "ses_child" ? "python3 analyze slide-03.jpg" : undefined),
        }}
      />,
    );
    expect(screen.getByText("python3 analyze slide-03.jpg")).toBeInTheDocument();
  });

  it("asks for no activity on rows that spawned no subagent", () => {
    render(
      <BlockList
        blocks={[{ kind: "tool-call", title: "ls -la", status: "running" }]}
        handlers={{
          subagentActivity: () => {
            throw new Error("must not be called without a childSessionId");
          },
        }}
      />,
    );
    expect(screen.getByText("ls -la")).toBeInTheDocument();
  });
});

describe("agent prose sanitizing", () => {
  it("strips leaked claim markers and raw comments but keeps citation refs", () => {
    const { container } = render(
      <BlockList
        blocks={[
          {
            kind: "agent",
            markdown: "文献 [1] 支持该结论。[claim:CLM-006]\n<!-- claim:CLM-001 -->\n后续分析完成。",
          },
        ]}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("[1]");
    expect(text).toContain("后续分析完成。");
    expect(text).not.toContain("claim");
    expect(text).not.toContain("CLM");
  });
});

describe("status-line tones and resend", () => {
  it("offers a resend button on a failed turn and replays its triggering text", async () => {
    const onRetry = vi.fn();
    render(
      <BlockList
        blocks={[{ kind: "status-line", text: "发送失败：model unavailable", tone: "error", retryText: "analyze the cohort" }]}
        handlers={{ onRetry }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "重发" }));
    expect(onRetry).toHaveBeenCalledWith("analyze the cohort");
  });

  it("keeps neutral outcomes (done / interrupted) free of resend and error styling", () => {
    const { container } = render(
      <BlockList
        blocks={[
          { kind: "status-line", text: "已完成", tone: "done" },
          { kind: "status-line", text: "已中断", tone: "muted" },
        ]}
        handlers={{ onRetry: vi.fn() }}
      />,
    );
    expect(screen.queryByRole("button", { name: "重发" })).not.toBeInTheDocument();
    expect(container.querySelector(".text-error")).toBeNull();
    expect(screen.getByText("已完成").parentElement).toHaveClass("text-muted");
    expect(screen.getByText("已中断").parentElement).toHaveClass("text-muted");
  });
});
