import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@/lib/store";
import { WORKFLOW_STARTERS } from "@/components/thread/WorkflowStarters";
import { CommandPalette } from "./CommandPalette";

function Pathname() {
  return <div data-testid="path">{useLocation().pathname}</div>;
}

const mocks = vi.hoisted(() => {
  const useRuntimeStore = vi.fn() as unknown as ReturnType<typeof vi.fn> & {
    getState: ReturnType<typeof vi.fn>;
  };
  const state = { startDraft: vi.fn(), sendPrompt: vi.fn(async (_text: string): Promise<string | null> => null) };
  useRuntimeStore.getState = vi.fn(() => state);
  return { useRuntimeStore, state, hosted: false };
});

vi.mock("@/lib/runtime", () => ({ useRuntimeStore: mocks.useRuntimeStore }));
vi.mock("@/lib/apiClient", () => ({
  get hasWebApi() {
    return mocks.hosted;
  },
}));
vi.mock("@/lib/tauri", () => ({ isTauri: false }));

describe("CommandPalette", () => {
  beforeEach(() => {
    useUiStore.setState({ paletteOpen: false, theme: "light" });
    mocks.hosted = false;
    vi.clearAllMocks();
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

    await user.type(input, "报告");
    expect(screen.getByText("核查报告与证据")).toBeInTheDocument();
    expect(screen.queryByText("分析研究数据")).not.toBeInTheDocument();
  });

  it("lists every main page under 导航, trimmed to the desktop on non-hosted shells", async () => {
    useUiStore.setState({ paletteOpen: true });
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );

    expect(screen.getByText("导航")).toBeInTheDocument();
    expect(screen.getByText("动作")).toBeInTheDocument();
    for (const label of ["新任务", "知识库", "科研笔记本", "运行记录", "打开设置", "切换主题"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Hosted-only pages stay out of the desktop palette, mirroring the Sidebar.
    expect(screen.queryByText("科研记忆")).not.toBeInTheDocument();
    expect(screen.queryByText("科研工作流")).not.toBeInTheDocument();
  });

  it("adds 科研记忆 and 科研工作流 on the hosted web", () => {
    mocks.hosted = true;
    useUiStore.setState({ paletteOpen: true });
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );

    expect(screen.getByText("科研记忆")).toBeInTheDocument();
    expect(screen.getByText("科研工作流")).toBeInTheDocument();
  });

  it("navigates to a main page when a 导航 action is selected", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ paletteOpen: true });
    render(
      <MemoryRouter initialEntries={["/live"]}>
        <Pathname />
        <CommandPalette />
      </MemoryRouter>,
    );

    await user.click(screen.getByText("知识库"));
    expect(screen.getByTestId("path").textContent).toBe("/files");
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

  // Regression: palette actions referenced nonexistent starter ids ("analyze"/"audit")
  // and sent an empty prompt. Each action must send its real starter prompt.
  it("workflow actions send their starter prompt, never an empty one", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ paletteOpen: true });
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );

    const cases: [string, string][] = [
      ["分析研究数据", "data-analysis"],
      ["核查报告与证据", "evidence-audit"],
    ];
    for (const [label, starterId] of cases) {
      const expected = WORKFLOW_STARTERS.find((s) => s.id === starterId)?.prompt;
      expect(expected).toBeTruthy();
      await user.click(screen.getByText(label));
      expect(mocks.state.sendPrompt).toHaveBeenCalledWith(expected);
      // The palette closes on select; reopen for the next action.
      act(() => useUiStore.setState({ paletteOpen: true }));
    }
    for (const call of mocks.state.sendPrompt.mock.calls) {
      expect(call[0].trim()).not.toBe("");
    }
  });
});
