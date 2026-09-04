import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
