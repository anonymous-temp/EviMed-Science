import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShortcutHelp } from "./ShortcutHelp";

// Deterministic modifier labels — the real check sniffs the UA string.
vi.mock("@/lib/platform", () => ({ isMacPlatform: () => true }));

describe("ShortcutHelp", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("opens on ? and lists the existing shortcuts", () => {
    render(<ShortcutHelp />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "?" });

    const dialog = screen.getByRole("dialog", { name: "键盘快捷键" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("⌘K")).toBeInTheDocument();
    expect(screen.getByText("⌘B")).toBeInTheDocument();
    expect(screen.getByText("Shift+Enter")).toBeInTheDocument();
    expect(screen.getByText("打开命令面板")).toBeInTheDocument();
    // The panel takes focus so Esc/screen readers start here.
    expect(dialog).toHaveFocus();
  });

  it("Esc closes the panel and hands focus back to the previous element", () => {
    render(
      <>
        <button type="button">触发源</button>
        <ShortcutHelp />
      </>,
    );
    const trigger = screen.getByText("触发源");
    trigger.focus();

    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("never steals ? from a field the user is typing into", () => {
    render(
      <>
        <input aria-label="消息输入" />
        <ShortcutHelp />
      </>,
    );
    const input = screen.getByLabelText("消息输入");
    input.focus();

    fireEvent.keyDown(input, { key: "?" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes via the close button and toggles back open on ?", () => {
    render(<ShortcutHelp />);
    fireEvent.keyDown(window, { key: "?" });

    fireEvent.click(screen.getByRole("button", { name: "关闭快捷键面板" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
