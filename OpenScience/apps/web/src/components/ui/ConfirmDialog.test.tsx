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

  // Appendix E #4 (spec §22.7): Enter is the focused control's and nobody
  // else's. A stray Enter on the panel used to confirm a deletion.
  it("never maps Enter to confirm: Enter outside a button does nothing", () => {
    const p = props();
    render(<ConfirmDialog {...p} />);
    fireEvent.keyDown(document.body, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Enter" });
    expect(p.onConfirm).not.toHaveBeenCalled();
    expect(p.onCancel).not.toHaveBeenCalled();
  });

  it("Enter where focus starts cancels; confirming takes a move to the red button", async () => {
    const p = props();
    render(<ConfirmDialog {...p} />);
    await userEvent.keyboard("{Enter}");
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(p.onConfirm).not.toHaveBeenCalled();

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "删除" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(p.onConfirm).toHaveBeenCalledTimes(1);
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

  // A confirmation that takes a moment is the caller's to guard no longer:
  // while `busy` the dialog holds still, so a second press cannot start a
  // second delete, and it cannot be dismissed out from under the request.
  it("while busy: the confirming button is disabled and spinning, and nothing dismisses the dialog", async () => {
    const p = { ...props(), busy: true };
    render(<ConfirmDialog {...p} />);
    const confirm = screen.getByRole("button", { name: "删除" });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    await userEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await userEvent.click(screen.getByRole("alertdialog").parentElement as HTMLElement);
    expect(p.onConfirm).not.toHaveBeenCalled();
    expect(p.onCancel).not.toHaveBeenCalled();
  });

  it("dismisses again once the request has settled", () => {
    const p = props();
    const view = render(<ConfirmDialog {...p} busy />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(p.onCancel).not.toHaveBeenCalled();
    view.rerender(<ConfirmDialog {...p} busy={false} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });
});
