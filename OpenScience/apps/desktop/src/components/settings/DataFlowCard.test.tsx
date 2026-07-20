import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataFlowCard } from "./DataFlowCard";

describe("DataFlowCard", () => {
  it("states both sides of the data flow with the active model", () => {
    render(<DataFlowCard model="anthropic/claude" workspace="/Users/x/OpenScience" />);
    expect(screen.getByText("留在本机")).toBeInTheDocument();
    expect(screen.getByText(/发送给你的模型提供方/)).toBeInTheDocument();
    expect(screen.getByText("anthropic/claude")).toBeInTheDocument();
    expect(screen.getByText(/\/Users\/x\/OpenScience/)).toBeInTheDocument();
    // The copy must never promise perfection — it states scope, not guarantees.
    expect(screen.queryByText(/no errors|zero hallucination/i)).not.toBeInTheDocument();
  });

  it("shows the unconfigured state without a workspace path", () => {
    render(<DataFlowCard model={null} workspace={null} />);
    expect(screen.getByText("未配置模型")).toBeInTheDocument();
  });

  it("uses hosted wording for web deployments", () => {
    render(<DataFlowCard model={null} workspace="/workspace/default" hosted />);
    expect(screen.getByText("存储在托管工作区")).toBeInTheDocument();
    expect(screen.getByText(/服务端内核沙箱/)).toBeInTheDocument();
    expect(screen.getByText(/浏览器、工作区、日志与导出内容都不会收到它/)).toBeInTheDocument();
    expect(screen.getByText(/不会由浏览器直连模型提供方/)).toBeInTheDocument();
    expect(screen.getByText(/科学连接器只能通过服务端固定来源网关/)).toBeInTheDocument();
    expect(screen.queryByText("留在本机")).not.toBeInTheDocument();
  });
});
