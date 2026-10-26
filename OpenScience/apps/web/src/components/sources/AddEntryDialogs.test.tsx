import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AddLinkDialog, NewNoteDialog } from "./AddEntryDialogs";
const api = vi.hoisted(() => ({ addSourceLink: vi.fn(), addSourceNote: vi.fn() }));
vi.mock("@/lib/sourceClient", () => api);

it("retains a link draft on cancel and failed save, and clears dirty only after confirmed save", async () => {
  const close = vi.fn(), added = vi.fn();
  api.addSourceLink.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ source: { id: "source" } });
  render(<AddLinkDialog projectId="one" onClose={close} onAdded={added} />);
  const field = screen.getByRole("textbox", { name: "网址" });
  fireEvent.change(field, { target: { value: "https://example.com/paper" } });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "取消" }));
  expect(field).toHaveValue("https://example.com/paper");
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect(screen.getByRole("button", { name: "添加" })).not.toHaveAttribute("aria-busy", "true"));
  expect(field).toHaveValue("https://example.com/paper");
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect(added).toHaveBeenCalledOnce());
  expect(field).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(close).toHaveBeenCalledOnce();
});

it("guards a new note's body even before a title is entered", () => {
  const close = vi.fn();
  render(<NewNoteDialog projectId="one" onClose={close} onAdded={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "正文" }), { target: { value: "需要保留的草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
});
