import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";
import { Drawer } from "./Drawer";

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开</button>
      {open && (
        <Drawer title="自动化 Meta 分析" description="临床证据" onClose={() => { onClose(); setOpen(false); }}>
          <button type="button">第一个</button>
          <button type="button">最后一个</button>
        </Drawer>
      )}
    </>
  );
}

describe("Drawer", () => {
  it("is a modal dialog named by its heading, with focus moved in", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "打开" }));
    const dialog = screen.getByRole("dialog", { name: "自动化 Meta 分析" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("临床证据");
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
  });

  it("keeps Tab inside and closes on Escape, returning focus to its trigger", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "打开" });
    await userEvent.click(trigger);

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "第一个" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "最后一个" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();

    // Keyboard focus on the close button shows its tooltip, and the tooltip
    // is the top layer: the first Escape dismisses it (WCAG 1.4.13) without
    // moving focus, the next one closes the drawer.
    expect(document.querySelector("[role='tooltip']")).toHaveTextContent("关闭");
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[role='tooltip']")).toBeNull();
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("leaves Tab and Escape to a dialog opened from inside it, and stays open when that dialog is dismissed", async () => {
    const onClose = vi.fn();
    function WithConfirm() {
      const [asking, setAsking] = useState(false);
      return (
        <Drawer title="任务" onClose={onClose}>
          <button type="button" onClick={() => setAsking(true)}>删除任务</button>
          {asking && <ConfirmDialog title="删除任务？" body="删除后停止后续计划。" confirmLabel="删除" onCancel={() => setAsking(false)} onConfirm={() => setAsking(false)} />}
        </Drawer>
      );
    }
    render(<WithConfirm />);
    await userEvent.click(screen.getByRole("button", { name: "删除任务" }));
    const confirm = screen.getByRole("alertdialog");
    // Tab cycles inside the confirmation; the drawer does not pull focus back out of it.
    await userEvent.tab();
    expect(confirm).toContainElement(document.activeElement as HTMLElement);
    await userEvent.tab();
    expect(confirm).toContainElement(document.activeElement as HTMLElement);
    // One Escape closes the confirmation and only that.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "任务" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a click on the backdrop, not on the panel", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "打开" }));
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
