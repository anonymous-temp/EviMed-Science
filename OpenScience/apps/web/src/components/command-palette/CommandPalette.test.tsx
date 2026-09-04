import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "@/lib/store";
import { CommandPalette } from "./CommandPalette";

function Pathname() {
  return <div data-testid="path">{useLocation().pathname}</div>;
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
    expect(screen.getByText("科研记忆")).toBeInTheDocument();
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
      "科研笔记本",
      "科研记忆",
      "能力模板",
      "账户与额度",
      "打开设置",
      "切换主题",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
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
});
