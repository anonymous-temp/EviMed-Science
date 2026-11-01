import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { VcrToolbarActions } from "./VcrToolbarActions";

// A draft fills the composer and nothing runs; a button that does not say so (or look like it) sits beside buttons that run work now.
it("draws a draft with the pencil and declares its kind, and leaves a plain action without either", async () => {
  const draft = vi.fn(); const download = vi.fn();
  render(<VcrToolbarActions actions={[
    { key: "ask", label: "让 AI 调整设定", kind: "draft", onSelect: draft },
    { key: "download", label: "下载记录", onSelect: download },
  ]} />);
  const ask = screen.getByRole("button", { name: "让 AI 调整设定" });
  expect(ask).toHaveAttribute("data-action-kind", "draft");
  expect(ask.querySelector("svg.lucide-pen-line")).not.toBeNull();
  const plain = screen.getByRole("button", { name: "下载记录" });
  expect(plain).not.toHaveAttribute("data-action-kind");
  expect(plain.querySelector("svg")).toBeNull();
  await userEvent.click(ask);
  expect(draft).toHaveBeenCalledTimes(1);
  expect(download).not.toHaveBeenCalled();
});
