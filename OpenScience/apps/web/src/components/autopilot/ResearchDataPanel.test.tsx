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
const draw = (input: ReturnType<typeof props> & { databaseAvailable?: boolean }) => render(<MemoryRouter><ResearchDataPanel {...input} /></MemoryRouter>);

describe("ResearchDataPanel", () => {
  it("lists the research's materials, labelling only those that are not ready", async () => {
    const input = props(); draw(input);
    const rows = within(screen.getByRole("list", { name: "已加入的资料" })).getAllByRole("listitem");
    expect(within(rows[0]).getByRole("link", { name: "方案.pdf" })).toHaveAttribute("href", "/app/files/src%2Fready");
    expect(rows[0].querySelector("[data-tag]")).toBeNull();
    ["正在读取", "需要处理", "无法使用"].forEach((status, index) => expect(within(rows[index + 1]).getByText(status)).toBeInTheDocument());
    await userEvent.click(within(rows[0]).getByRole("button", { name: "移除 方案.pdf" }));
    expect(input.onRemove).toHaveBeenCalledWith("src/ready");
  });

  it("is a recipe when empty and offers the database only where it exists", async () => {
    const input = { ...props(), materials: [] }; const view = draw(input);
    expect(screen.getByText(/还没有资料/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "上传资料" }));
    await userEvent.click(screen.getByRole("button", { name: "从知识库选择" }));
    await userEvent.click(screen.getByRole("button", { name: "从数据库导入" }));
    expect(input.onUpload).toHaveBeenCalledOnce(); expect(input.onPick).toHaveBeenCalledOnce(); expect(input.onDatabase).toHaveBeenCalledOnce();
    view.rerender(<MemoryRouter><ResearchDataPanel {...input} databaseAvailable={false} /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "从数据库导入" })).not.toBeInTheDocument();
  });

  it("distinguishes loading and failed reads and disables changes while busy", async () => {
    const input = { ...props(), loading: true, busy: true }; const view = draw(input);
    expect(screen.getByRole("status")).toHaveTextContent("正在载入");
    expect(screen.queryByText(/还没有资料/)).not.toBeInTheDocument();
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
