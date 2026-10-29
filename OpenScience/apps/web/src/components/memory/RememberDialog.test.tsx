import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { RememberDialog } from "./RememberDialog";
const api = vi.hoisted(() => ({ rememberMemory: vi.fn() }));
vi.mock("@/lib/memoryClient", () => api);

it("prevents a second edit during save so a confirmed save cannot discard newer unsaved words", async () => {
  let resolve!: () => void;
  api.rememberMemory.mockImplementation(() => new Promise<void>(yes => { resolve = yes; }));
  const close = vi.fn();
  render(<RememberDialog projectId="one" onClose={close} onAsked={vi.fn()} />);
  const field = screen.getByRole("textbox", { name: "要记住的内容" });
  await userEvent.type(field, "提交的草稿");
  fireEvent.click(screen.getByRole("button", { name: "记住" }));
  expect(field).toBeDisabled();
  await userEvent.type(field, "这段不能在保存中追加");
  expect(field).toHaveValue("提交的草稿");
  await act(async () => resolve());
  expect(close).toHaveBeenCalledOnce();
  expect(field).toHaveValue("");
});
