import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_STARTERS, WorkflowStarters } from "./WorkflowStarters";

describe("WorkflowStarters", () => {
  it("renders a Chinese open-domain research welcome with focused starters", () => {
    render(<WorkflowStarters onPick={() => {}} />);
    for (const starter of WORKFLOW_STARTERS) {
      expect(screen.getByText(starter.title)).toBeInTheDocument();
    }
    expect(screen.getByText("今天想研究什么？")).toBeInTheDocument();
    expect(screen.getByText("结合个人知识库分析")).toBeInTheDocument();
    expect(screen.queryByText(/climate/i)).not.toBeInTheDocument();
  });

  it("sends the selected Chinese research prompt", async () => {
    const onPick = vi.fn();
    render(<WorkflowStarters onPick={onPick} />);

    await userEvent.click(screen.getByText("分析研究数据"));

    expect(onPick).toHaveBeenCalledWith(expect.stringContaining("统计方法"));
  });
});
