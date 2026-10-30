import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FrontierLightbox } from "@/components/frontier/FrontierLightbox";
import { ConfirmDialog } from "./ConfirmDialog";
import { Drawer } from "./Drawer";
import { FormDialog } from "./FormDialog";
import { ShortcutHelp } from "./ShortcutHelp";

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
    // The panel takes focus, not the corner 关闭: focusing the button showed its tooltip unasked, and the tooltip took the
    // first Escape, so a drawer needed two presses to close (release-11 walk).
    expect(dialog).toHaveFocus();
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("closes on the first Escape after it opens, and puts focus back on its trigger", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "打开" });
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps Tab inside and closes on Escape, returning focus to its trigger", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "打开" });
    await userEvent.click(trigger);

    // From the panel, Tab enters at the corner 关闭, then runs through the body and wraps.
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "第一个" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "最后一个" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
    // And backwards from the first stop.
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "最后一个" })).toHaveFocus();
    await userEvent.tab();

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

  it("guards X, Escape and backdrop through the same dirty-draft confirmation", async () => {
    const close = vi.fn();
    render(<Drawer title="Draft" dirty onClose={close}><input aria-label="Name" /></Drawer>);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(close).toHaveBeenCalledOnce();
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

  it("never renders implementation comments as visible drawer content", () => {
    const { container } = render(<Drawer title="Preview" onClose={() => {}}>Reader content</Drawer>);
    expect(container).not.toHaveTextContent(/keyboard equivalent|backdrop has no keyboard|role="presentation"/);
    expect(screen.getByRole("dialog")).toHaveTextContent("Reader content");
  });

  it("does not close while a save is running: the corner button is disabled and Escape or the backdrop do nothing", async () => {
    const onClose = vi.fn();
    render(<Drawer title="保存中" busy onClose={onClose}><p>正文</p></Drawer>);
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).not.toHaveBeenCalled();
  });

  // Design reference §5.2 (R13 V-12): a bar stuck to the bottom keeps at least 16 px, or the device's safe area, above the window's edge.
  describe("footer", () => {
    it("is a bar under the scrolling body, with a hairline over it and the safe-area padding under it", () => {
      render(
        <Drawer title="任务" onClose={() => {}} footer={<button type="button">保存</button>}>
          <p>正文</p>
        </Drawer>,
      );
      const dialog = screen.getByRole("dialog", { name: "任务" });
      const bar = dialog.querySelector("footer") as HTMLElement;
      expect(bar).toContainElement(screen.getByRole("button", { name: "保存" }));
      // Outside the scroller, so it stays put while the body scrolls, and last in the panel.
      expect(bar.parentElement).toBe(dialog);
      expect(bar).toBe(dialog.lastElementChild);
      expect(screen.getByText("正文").closest(".overflow-y-auto")).not.toContainElement(bar);
      expect(bar).toHaveClass("border-t", "pb-[max(1rem,env(safe-area-inset-bottom))]");
    });

    it("draws nothing when there is none", () => {
      render(<Drawer title="任务" onClose={() => {}}><p>正文</p></Drawer>);
      expect(screen.getByRole("dialog").querySelector("footer")).toBeNull();
    });
  });
});

// A modal layer opened over a drawer owns Tab and Escape while it is up, whether or not it is one of the dialogs that register
// with the focus-layer stack (release review R1 P1-1: the shortcut sheet, the picture viewer and the small-window pane did not).
describe("a layer over a drawer", () => {
  it("leaves Tab and Escape to a form dialog opened from the drawer", async () => {
    const closeDrawer = vi.fn();
    const closeForm = vi.fn();
    function WithForm() {
      const [editing, setEditing] = useState(false);
      return (
        <Drawer title="任务" onClose={closeDrawer}>
          <button type="button" onClick={() => setEditing(true)}>改名</button>
          {editing && <FormDialog title="改名" onClose={() => { closeForm(); setEditing(false); }}><input aria-label="新名字" /></FormDialog>}
        </Drawer>
      );
    }
    render(<WithForm />);
    await userEvent.click(screen.getByRole("button", { name: "改名" }));
    expect(screen.getByLabelText("新名字")).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("dialog", { name: "改名" })).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard("{Escape}");
    expect(closeForm).toHaveBeenCalledTimes(1);
    expect(closeDrawer).not.toHaveBeenCalled();
  });

  it("leaves Escape to the keyboard-shortcut sheet opened over it, then to the drawer again", async () => {
    const closeDrawer = vi.fn();
    render(<><ShortcutHelp /><Drawer title="任务" onClose={closeDrawer}><button type="button">第一个</button></Drawer></>);
    fireEvent.keyDown(document.body, { key: "?" });
    expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toHaveFocus();
    // The first Escape is the sheet's.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "键盘快捷键" })).not.toBeInTheDocument();
    expect(closeDrawer).not.toHaveBeenCalled();
    // The second one is the drawer's.
    await userEvent.keyboard("{Escape}");
    expect(closeDrawer).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the keyboard-shortcut sheet, not in the drawer beneath it", async () => {
    render(<><ShortcutHelp /><Drawer title="任务" onClose={() => {}}><button type="button">第一个</button></Drawer></>);
    fireEvent.keyDown(document.body, { key: "?" });
    const sheet = screen.getByRole("dialog", { name: "键盘快捷键" });
    for (let press = 0; press < 3; press += 1) {
      await userEvent.tab();
      expect(sheet).toContainElement(document.activeElement as HTMLElement);
    }
    await userEvent.tab({ shift: true });
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
  });

  it("leaves Escape to the picture viewer opened over it", async () => {
    const closeDrawer = vi.fn();
    const closeViewer = vi.fn();
    render(
      <>
        <Drawer title="任务" onClose={closeDrawer}><button type="button">第一个</button></Drawer>
        <FrontierLightbox media={[{ id: "m1", url: "/m1.png", width: 10, height: 10, alt: "示意图" }]} index={0} onIndex={() => {}} onClose={closeViewer} />
      </>,
    );
    expect(screen.getByRole("dialog", { name: "图片" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(closeViewer).toHaveBeenCalledTimes(1);
    expect(closeDrawer).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the picture viewer, not in the drawer beneath it", async () => {
    render(
      <>
        <Drawer title="任务" onClose={() => {}}><button type="button">第一个</button></Drawer>
        <FrontierLightbox media={[{ id: "m1", url: "/m1.png", width: 10, height: 10, alt: "示意图" }]} index={0} onIndex={() => {}} onClose={() => {}} />
      </>,
    );
    const viewer = screen.getByRole("dialog", { name: "图片" });
    for (let press = 0; press < 3; press += 1) {
      await userEvent.tab();
      expect(viewer).toContainElement(document.activeElement as HTMLElement);
    }
  });

  // The fallback: a modal that never registers (anything written later with aria-modal and nothing else) still keeps its keys.
  it("leaves keys typed inside an unregistered modal to that modal", async () => {
    const closeDrawer = vi.fn();
    render(
      <Drawer title="任务" onClose={closeDrawer}>
        <div role="dialog" aria-modal="true" aria-label="自制弹层" tabIndex={-1}><button type="button">弹层内</button></div>
      </Drawer>,
    );
    const inner = screen.getByRole("button", { name: "弹层内" });
    inner.focus();
    const tab = fireEvent.keyDown(inner, { key: "Tab" });
    expect(tab).toBe(true);
    expect(inner).toHaveFocus();
    const escape = fireEvent.keyDown(inner, { key: "Escape" });
    expect(escape).toBe(true);
    expect(closeDrawer).not.toHaveBeenCalled();
    // The drawer's own controls still get its Escape.
    fireEvent.keyDown(screen.getByRole("dialog", { name: "任务" }), { key: "Escape" });
    expect(closeDrawer).toHaveBeenCalledTimes(1);
  });
});
