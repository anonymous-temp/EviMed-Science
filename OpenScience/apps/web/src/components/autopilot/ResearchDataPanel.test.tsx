import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ResearchState } from "@/lib/autopilotClient";
import { ResearchDataPanel } from "./ResearchDataPanel";

const materials: ResearchState["materials"] = [
  { sourceId: "src/ready", name: "方案.pdf", addedAt: "", state: "ready" },
  { sourceId: "src-reading", name: "表格.xlsx", addedAt: "", state: "reading" },
  { sourceId: "src-attention", name: "待处理", addedAt: "", state: "attention" },
  { sourceId: "src-unavailable", name: "不可用", addedAt: "", state: "unavailable" },
];
const props = () => ({ materials, loading: false, error: null, busy: false, onUpload: vi.fn(), onPick: vi.fn(), onDatabase: vi.fn(), onRemove: vi.fn(), onRetry: vi.fn() });
const draw = (input: ReturnType<typeof props>) => render(<MemoryRouter><ResearchDataPanel {...input} /></MemoryRouter>);

describe("ResearchDataPanel", () => {
  it("shows the actual associated materials and their distinct availability without claiming use", async () => {
    const input = props(); draw(input);
    expect(screen.getByText("已关联的资料可供研究使用，关联不代表已经阅读。")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "已关联资料" })).getAllByRole("listitem");
    expect(within(rows[0]).getByRole("link", { name: "方案.pdf" })).toHaveAttribute("href", "/app/files/src%2Fready");
    ["可使用", "正在读取", "需要处理", "无法使用"].forEach((status, index) => expect(within(rows[index]).getByText(status)).toBeInTheDocument());
    await userEvent.click(within(rows[0]).getByRole("button", { name: "移除 方案.pdf" }));
    expect(input.onRemove).toHaveBeenCalledWith("src/ready");
  });

  it("supports literature-only research and exposes real entry points", async () => {
    const input = { ...props(), materials: [] }; draw(input);
    expect(screen.getByText(/只用公开文献/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "上传资料" }));
    await userEvent.click(screen.getByRole("button", { name: "从知识库选择" }));
    expect(input.onUpload).toHaveBeenCalledOnce(); expect(input.onPick).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "管理数据源" })).toHaveAttribute("href", "/app/account?tab=connectors");
    expect(screen.getByRole("link", { name: "查找公开文献（PubMed）" })).toHaveAttribute("href", "https://pubmed.ncbi.nlm.nih.gov/");
  });

  it("distinguishes loading and failed reads and disables mutations while busy", async () => {
    const input = { ...props(), loading: true, busy: true }; const view = draw(input);
    expect(screen.getByRole("status")).toHaveTextContent("正在加载研究资料");
    expect(screen.queryByText(/尚未关联资料/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传资料" })).toBeDisabled();
    view.rerender(<MemoryRouter><ResearchDataPanel {...input} loading={false} error="资料加载失败" /></MemoryRouter>);
    expect(screen.getByText("资料加载失败")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "方案.pdf" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(input.onRetry).toHaveBeenCalledOnce();
    view.rerender(<MemoryRouter><ResearchDataPanel {...input} loading={false} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "移除 方案.pdf" })).toBeDisabled();
  });
});
