import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
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
