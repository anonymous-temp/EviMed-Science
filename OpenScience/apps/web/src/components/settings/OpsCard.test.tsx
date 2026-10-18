import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CopyId, OPS_TONE, OpsBody, OpsCard, OpsNothing, OpsRow, OpsRows } from "./OpsCard";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast }));

beforeEach(() => vi.clearAllMocks());

describe("the operator console's card", () => {
  it("is one shell: a named region, a 14 / 600 title, the description, one refresh icon", async () => {
    const refresh = vi.fn();
    render(
      <OpsCard title="操作审计" description="该工作区最近的项目操作" refresh={{ label: "刷新审计事件", loading: false, onRefresh: refresh }}>
        <OpsBody><OpsRows label="项目操作"><OpsRow>一行</OpsRow><OpsRow>又一行</OpsRow></OpsRows></OpsBody>
      </OpsCard>,
    );
    expect(screen.getByRole("region", { name: "操作审计" })).toBeInTheDocument();
    const title = screen.getByRole("heading", { name: "操作审计" });
    expect(title.className).toContain("text-ui");
    expect(title.className).toContain("font-semibold");
    await userEvent.click(screen.getByRole("button", { name: "刷新审计事件" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("draws its rows as a list with the rule under each — the same stroke as the header's — and none under the last", () => {
    render(<OpsCard title="任务"><OpsBody><OpsRows label="后台任务"><OpsRow>甲</OpsRow><OpsRow>乙</OpsRow></OpsRows></OpsBody></OpsCard>);
    const rows = within(screen.getByRole("list", { name: "后台任务" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.className).toContain("border-b");
      expect(row.className).not.toMatch(/(^|\s)border-t(\s|$)/);
    }
    expect(rows[1].className).toContain("last:border-b-0");
  });

  it("gives a good state no colour: only a thing to look at is amber and only a failure red", () => {
    expect(OPS_TONE.ok).toBe("");
    expect(OPS_TONE.warn).toBe("text-warn");
    expect(OPS_TONE.failed).toBe("text-error");
    // No green and no blue for a state that went well: the walk counts every colour of text on the page.
    for (const tone of Object.values(OPS_TONE)) expect(tone).not.toMatch(/text-ok|text-accent|text-success/);
  });

  it("says what a list holds when it holds nothing, inside the box where the rows would be", () => {
    render(<OpsCard title="错误账本"><OpsBody><OpsRows label="失败的请求"><OpsNothing>暂无近期 API 错误。</OpsNothing></OpsRows></OpsBody></OpsCard>);
    expect(within(screen.getByRole("list", { name: "失败的请求" })).getByText("暂无近期 API 错误。")).toBeInTheDocument();
  });
});

describe("an identifier an operator searches the logs for", () => {
  it("is a copy button, not page text: the tooltip holds it and the click puts it on the clipboard", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    render(<CopyId value="src_20a9d3af2947385e47bee76791993e26" label="复制“资料”的标识" />);
    const button = screen.getByRole("button", { name: "复制“资料”的标识" });
    // Not in the visible text of the page.
    const copy = document.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[role="tooltip"]').forEach((node) => node.remove());
    expect(copy.textContent).not.toContain("src_20a9d3af");
    await userEvent.click(button);
    expect(write).toHaveBeenCalledWith("src_20a9d3af2947385e47bee76791993e26");
    expect(toast.success).toHaveBeenCalledWith("已复制");
  });

  it("says so when the clipboard refuses", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    render(<CopyId value="req_1" label="复制错误标识" />);
    await userEvent.click(screen.getByRole("button", { name: "复制错误标识" }));
    expect(toast.error).toHaveBeenCalledWith("没有复制成功");
  });
});
