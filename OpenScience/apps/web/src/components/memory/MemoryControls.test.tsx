import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MemoryControls } from "./MemoryControls";
const api = vi.hoisted(() => ({ fetchMemorySettings: vi.fn(), updateMemorySettings: vi.fn() }));
vi.mock("@/lib/apiClient", async original => ({ ...(await original<object>()), ...api, getWebProjectId: () => "one" }));

it("keeps the memory switch focused while pending and reconciles an unknown write before admitting another", async () => {
  const current = { learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null };
  api.fetchMemorySettings.mockResolvedValue(current);
  let reject!: (error: unknown) => void;
  api.updateMemorySettings.mockImplementation(() => new Promise((_, no) => { reject = no; }));
  render(<MemoryControls onReset={vi.fn()} onShare={vi.fn()} onForgotten={vi.fn()} />);
  const control = await screen.findByRole("switch", { name: "记忆" });
  control.focus(); fireEvent.click(control); fireEvent.click(control);
  expect(api.updateMemorySettings).toHaveBeenCalledTimes(1);
  expect(control).toHaveFocus(); expect(control).not.toBeDisabled();
  await act(async () => reject(new Error("timeout")));
  fireEvent.click(control); expect(api.updateMemorySettings).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "刷新核对状态" }));
  await waitFor(() => expect(control).toHaveAttribute("aria-checked", "true"));
  expect(api.fetchMemorySettings).toHaveBeenCalledTimes(2);
});
