import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@/lib/store";
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
    expect(screen.getByText("⌘B")).toBeInTheDocument();
    // The palette is gone (2026-09-22), so its key is not listed.
    expect(screen.queryByText("⌘K")).not.toBeInTheDocument();
    // The retired composer's keys are not listed as the shell's (U8).
    expect(screen.queryByText("Shift+Enter")).not.toBeInTheDocument();
    expect(screen.getByText(/由对话界面自己处理/)).toBeInTheDocument();
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

  it("opens when the chat frame forwards ? from inside it", async () => {
    const { SHORTCUT_HELP_TOGGLE_EVENT } = await import("./ShortcutHelp");
    render(<ShortcutHelp />);
    act(() => { window.dispatchEvent(new Event(SHORTCUT_HELP_TOGGLE_EVENT)); });
    expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toBeInTheDocument();
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

// WCAG 2.2 SC 2.1.4 (character key shortcuts): a shortcut that is one character can be turned off. Off, the key is left alone.
describe("the single-character ? shortcut has an off switch", () => {
  afterEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ singleKeyShortcuts: true });
  });

  it("does nothing and is not swallowed while it is off, and works again once it is back on", () => {
    useUiStore.getState().setSingleKeyShortcuts(false);
    render(<ShortcutHelp />);
    const pressed = new KeyboardEvent("keydown", { key: "?", bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(pressed); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Not preventDefault-ed: the key still types wherever it would have typed.
    expect(pressed.defaultPrevented).toBe(false);

    act(() => { useUiStore.getState().setSingleKeyShortcuts(true); });
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toBeInTheDocument();
  });

  it("is kept in this browser like the theme, on unless it was turned off", () => {
    expect(useUiStore.getState().singleKeyShortcuts).toBe(true);
    useUiStore.getState().setSingleKeyShortcuts(false);
    expect(window.localStorage.getItem("ai4s.shortcuts.single")).toBe("0");
    useUiStore.getState().setSingleKeyShortcuts(true);
    expect(window.localStorage.getItem("ai4s.shortcuts.single")).toBe("1");
  });

  it("does not take away the explicit toggle, which is a request and not a key", () => {
    useUiStore.getState().setSingleKeyShortcuts(false);
    render(<ShortcutHelp />);
    act(() => { window.dispatchEvent(new Event("evimed:shortcut-help-toggle")); });
    expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toBeInTheDocument();
  });
});
