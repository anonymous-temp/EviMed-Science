import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "@/lib/store";
import { CommandPalette } from "./CommandPalette";

function Pathname() {
  const location = useLocation();
  return <div data-testid="path">{location.pathname}<span data-testid="intent">{JSON.stringify(location.state?.runtimeUiIntent)}</span></div>;
}

describe("CommandPalette", () => {
  beforeEach(() => {
    useUiStore.setState({ paletteOpen: false, theme: "light" });
  });

  it("opens on Cmd/Ctrl+K and filters actions", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );

    expect(screen.queryByPlaceholderText("搜索操作…")).not.toBeInTheDocument();

    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByPlaceholderText("搜索操作…");
    expect(input).toBeInTheDocument();

    await user.type(input, "记忆");
    expect(screen.getByText("记忆")).toBeInTheDocument();
    expect(screen.queryByText("知识库")).not.toBeInTheDocument();
  });

  it("lists every navigation destination the sidebar has", () => {
    useUiStore.setState({ paletteOpen: true });
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );

    expect(screen.getByText("导航")).toBeInTheDocument();
    expect(screen.getByText("动作")).toBeInTheDocument();
    for (const label of [
      "新任务",
      "运行记录",
      "知识库",
      "记忆",
      "方法胶囊",
      "主动科研",
      "科研能力",
      "收件箱",
      "账户与额度",
      "打开设置",
      "切换主题",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Deleted on 2026-09-19 with the page it opened.
    expect(screen.queryByText("计算笔记本")).not.toBeInTheDocument();
  });

  // The palette used to offer two entries that started a conversation by
  // pushing a prompt through the browser's own kernel store. That store is
  // gone and the session surface is a frame on another origin, so an entry
  // like that would render and do nothing — the failure mode a palette makes
  // hardest to notice, because a closed palette looks like it worked.
  it("offers nothing that would have to send a prompt", () => {
    useUiStore.setState({ paletteOpen: true });
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );

    expect(screen.queryByText("分析研究数据")).not.toBeInTheDocument();
    expect(screen.queryByText("核查报告与证据")).not.toBeInTheDocument();
  });

  it("navigates to a workbench page when a 导航 action is selected", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ paletteOpen: true });
    render(
      <MemoryRouter initialEntries={["/app/chat"]}>
        <Pathname />
        <CommandPalette />
      </MemoryRouter>,
    );

    await user.click(screen.getByText("知识库"));
    expect(screen.getByTestId("path").textContent).toBe("/app/files");
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  it("creates a native task intent without submitting a prompt", async () => {
    useUiStore.setState({ paletteOpen: true });
    render(<MemoryRouter initialEntries={["/app/chat"]}><Pathname /><CommandPalette /></MemoryRouter>);
    await userEvent.click(screen.getByText("新任务"));
    const intent = JSON.parse(screen.getByTestId("intent").textContent!);
    expect(intent.kind).toBe("create"); expect(intent.requestId).toBeTruthy(); expect(intent.sessionId).toBeTruthy();
    expect(intent.draft).toBeUndefined(); expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  it("rotates the theme from the palette and shows the current mode as a hint", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ paletteOpen: true, theme: "light" });
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );

    expect(screen.getByText("浅色")).toBeInTheDocument();
    await user.click(screen.getByText("切换主题"));
    expect(useUiStore.getState().theme).toBe("dark");
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  // Appendix D §4: a modal layer is a dialog, keeps Tab inside, and hands
  // focus back to where it was.
  it("is a modal dialog that keeps focus inside and returns it on close", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <button type="button">外面的按钮</button>
        <CommandPalette />
      </MemoryRouter>,
    );
    const outside = screen.getByRole("button", { name: "外面的按钮" });
    outside.focus();
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "命令面板" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await screen.findByPlaceholderText("搜索操作…");
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });
});
