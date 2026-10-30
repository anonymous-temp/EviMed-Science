import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Drawer } from "@/components/ui/Drawer";
import { RightPane } from "./RightPane";

const mocks = vi.hoisted(() => ({
  setInspectorWidth: vi.fn(),
  setInspectorMaximized: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  useUiStore: () => ({
    inspectorWidth: 520,
    inspectorMaximized: false,
    setInspectorWidth: mocks.setInspectorWidth,
    setInspectorMaximized: mocks.setInspectorMaximized,
  }),
}));
vi.mock("@/lib/platform", () => ({ isMacPlatform: () => false }));

describe("RightPane small-window overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "(min-width: 1024px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
  });

  it("reuses the pane header close action instead of stacking a second close button", () => {
    const onClose = vi.fn();
    render(
      <RightPane onClose={onClose}>
        <button type="button" aria-label="关闭任务文件">关闭</button>
      </RightPane>,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The pane covers the window, so over a drawer it is the top layer: Tab and Escape are the pane's, not the drawer's beneath it.
  it("owns Tab and Escape over a drawer that was already open beneath it", async () => {
    const closePane = vi.fn();
    const closeDrawer = vi.fn();
    render(
      <>
        <Drawer title="任务" onClose={closeDrawer}><button type="button">抽屉里</button></Drawer>
        <RightPane onClose={closePane}><button type="button">文件</button></RightPane>
      </>,
    );
    const pane = screen.getByRole("dialog", { name: "右栏" });
    screen.getByRole("button", { name: "文件" }).focus();
    await userEvent.tab();
    expect(pane).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard("{Escape}");
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closeDrawer).not.toHaveBeenCalled();
  });
});
