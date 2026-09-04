import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

const props = () => ({
  title: "删除记忆",
  body: "删除后不可恢复。",
  confirmLabel: "删除",
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
});

describe("ConfirmDialog", () => {
  it("labels the dialog and points aria-describedby at the body text", () => {
    render(<ConfirmDialog {...props()} />);
    const dialog = screen.getByRole("alertdialog", { name: "删除记忆" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const bodyId = dialog.getAttribute("aria-describedby");
    expect(bodyId).toBeTruthy();
    expect(document.getElementById(bodyId!)).toHaveTextContent("删除后不可恢复。");
  });

  it("moves initial focus to the cancel button", () => {
    render(<ConfirmDialog {...props()} />);
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  });

  it("traps Tab inside the dialog, wrapping at both ends", () => {
    render(<ConfirmDialog {...props()} />);
    const cancel = screen.getByRole("button", { name: "取消" });
    const confirm = screen.getByRole("button", { name: "删除" });
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it("confirms on Enter outside the buttons and does not double-fire on a focused button", async () => {
    const p = props();
    render(<ConfirmDialog {...p} />);
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(p.onConfirm).toHaveBeenCalledTimes(1);

    // Focus is on 取消: Enter activates that button's own click — cancel once,
    // and the document-level Enter handler must not confirm on top of it.
    p.onConfirm.mockClear();
    await userEvent.keyboard("{Enter}");
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(p.onConfirm).not.toHaveBeenCalled();
  });

  it("keeps Escape and overlay click as cancel", async () => {
    const p = props();
    const { container, unmount } = render(<ConfirmDialog {...p} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    unmount();

    const p2 = props();
    render(<ConfirmDialog {...p2} />);
    await userEvent.click(screen.getByRole("alertdialog").parentElement as HTMLElement);
    expect(p2.onCancel).toHaveBeenCalledTimes(1);
    expect(p2.onConfirm).not.toHaveBeenCalled();
    expect(container).toBeDefined();
  });

  it("restores focus to the element that opened the dialog", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>打开对话框</button>
          {open && (
            <ConfirmDialog
              title="t"
              body="b"
              confirmLabel="确定"
              onConfirm={() => setOpen(false)}
              onCancel={() => setOpen(false)}
            />
          )}
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "打开对话框" });
    await userEvent.click(trigger);
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(trigger).toHaveFocus();
  });
});
