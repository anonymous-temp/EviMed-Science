import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { AsyncSwitch } from "./AsyncSwitch";

it("retains focus and a single write while pending, and locks unknown outcomes until a successful read", async () => {
  let reject!: (error: unknown) => void;
  const write = vi.fn(() => new Promise((_, no) => { reject = no; }));
  const read = vi.fn().mockResolvedValue(false);
  render(<AsyncSwitch label="远程设置" checked={false} onChange={write} readChecked={read} />);
  const control = screen.getByRole("switch"); control.focus();
  fireEvent.click(control); fireEvent.click(control);
  expect(write).toHaveBeenCalledTimes(1);
  expect(control).toHaveFocus();
  expect(control).not.toBeDisabled();
  expect(control).toHaveAttribute("aria-checked", "true");
  await act(async () => reject(new Error("timeout")));
  fireEvent.click(control);
  expect(write).toHaveBeenCalledTimes(1);
  const refresh = screen.getByRole("button", { name: "刷新核对状态" });
  read.mockRejectedValueOnce(new Error("offline")); fireEvent.click(refresh);
  expect(await screen.findByText("状态核对未完成，请稍后再刷新。")).toBeInTheDocument();
  fireEvent.click(control); expect(write).toHaveBeenCalledTimes(1);
  fireEvent.click(refresh);
  await waitFor(() => expect(control).toHaveAttribute("aria-checked", "false"));
  expect(screen.queryByRole("button", { name: "刷新核对状态" })).not.toBeInTheDocument();
});

it("rolls a positively rejected write back without requiring a recovery read", async () => {
  render(<AsyncSwitch label="设置" checked={false} onChange={async () => { throw new WebApiError("拒绝", { status: 409 }); }} readChecked={async () => false} />);
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false"));
  expect(screen.queryByRole("button", { name: "刷新核对状态" })).not.toBeInTheDocument();
});
