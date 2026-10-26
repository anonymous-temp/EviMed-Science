import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { AsyncSwitch } from "./AsyncSwitch";

it("retains focus and a single write while pending, and locks unknown outcomes until a successful read", async () => {
  let reject!: (error: unknown) => void;
  const write = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
  const read = vi.fn().mockResolvedValue(false);
  render(<AsyncSwitch label="远程设置" checked={false} onChange={write} readChecked={read} />);
  const control = screen.getByRole("switch"); control.focus();
  fireEvent.click(control); fireEvent.click(control);
  expect(write).toHaveBeenCalledTimes(1);
  expect(control).toHaveFocus();
  expect(control).not.toBeDisabled();
  expect(control).toHaveAttribute("aria-checked", "true");
  await act(async () => reject(new Error("timeout")));
  // The write may have been saved: the line says so and asks for a check, never for a retry.
  expect(screen.getByText("没有收到保存结果；结果待确认，请刷新状态")).toBeInTheDocument();
  expect(screen.queryByText(/未能保存|请重试/)).not.toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
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

it("settles on the write's own confirmed result and reads nothing back", async () => {
  const read = vi.fn().mockResolvedValue(false);
  // The page's `checked` does not move (no reload yet): the confirmed write is what the switch shows.
  const { rerender } = render(<AsyncSwitch label="设置" checked={false} onChange={async () => undefined} readChecked={read} />);
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() => expect(screen.getByRole("switch")).not.toHaveAttribute("aria-busy"));
  expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  // The page's own reload then moves `checked`, and that is shown.
  rerender(<AsyncSwitch label="设置" checked onChange={async () => undefined} readChecked={read} />);
  expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  expect(read).not.toHaveBeenCalled();
});

it("shows the state a confirmed write answers with, even when it is not the one asked for", async () => {
  render(<AsyncSwitch label="设置" checked={false} onChange={async () => false} readChecked={async () => true} />);
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() => expect(screen.getByRole("switch")).not.toHaveAttribute("aria-busy"));
  expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  expect(screen.queryByRole("button", { name: "刷新核对状态" })).not.toBeInTheDocument();
});

it("says a positive refusal once, in the switch's own line", async () => {
  render(<AsyncSwitch label="设置" checked={false} onChange={async () => { throw new WebApiError("没有权限", { status: 403 }); }} readChecked={async () => false} />);
  fireEvent.click(screen.getByRole("switch"));
  expect(await screen.findAllByText("当前账号没有执行这项操作的权限。")).toHaveLength(1);
});
