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

it("defaults a note to the account's own materials, which every project reads, and lets the person explicitly choose a project", async () => {
 const added = vi.fn(); const personal = { id: "personal", personal: true, display: { shared: true } };
 api.addSourceNote.mockResolvedValue({ source: personal });
 render(<NewNoteDialog projectId={null} destinations={[{ id: "one", label: "研究项目" }]} onClose={() => {}} onAdded={added} />);
 const destination = screen.getByRole("combobox", { name: "保存位置" });
 expect(destination).toHaveAccessibleDescription("放进我的资料，所有项目都能用；也可以改选一个项目，只放在那个项目里。多人共享的循证 GEO 项目不读我的资料，需要时请直接保存到那个项目。");
 const title = screen.getByRole("textbox", { name: "标题" }); fireEvent.change(title, { target: { value: "Notes" } });
 fireEvent.submit(title.closest("form")!);
 await waitFor(() => expect(api.addSourceNote).toHaveBeenCalledWith(null, { title: "Notes", body: "" }));
 expect(added).toHaveBeenCalledWith(personal);
 expect(personal.display.shared).toBe(true);
 fireEvent.focus(screen.getByRole("combobox", { name: "保存位置" })); fireEvent.click(screen.getByRole("button", { name: "研究项目" }));
 expect(destination).toHaveAccessibleDescription("先保存到所选项目；之后可以在资料的“生效项目”里，让其他项目也用它。");
 fireEvent.change(title, { target: { value: "Project notes" } }); fireEvent.submit(title.closest("form")!);
 await waitFor(() => expect(api.addSourceNote).toHaveBeenCalledWith("one", { title: "Project notes", body: "" }));
});

it.each([["note", "标题"], ["link", "网址"]])("focuses the first writing field and keeps personal destination closed for %s", (kind, label) => {
 render(kind === "note" ? <NewNoteDialog projectId={null} onClose={() => {}} onAdded={() => {}} /> : <AddLinkDialog projectId={null} onClose={() => {}} onAdded={() => {}} />);
 expect(screen.getByRole("textbox", { name: label })).toHaveFocus();
 const destination = screen.getByRole("combobox", { name: "保存位置" });
 expect(destination).toHaveValue("我的资料（所有项目可用）"); expect(destination).toHaveAttribute("aria-expanded", "false");
 expect(screen.queryByRole("listbox")).toBeNull();
});
