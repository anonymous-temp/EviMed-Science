import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VcrFollowupHistory } from "./VcrFollowupHistory";
const api = vi.hoisted(() => ({ getVcrFollowupHistory: vi.fn(), downloadVcrFollowupHistory: vi.fn() }));
vi.mock("@/lib/vcrClient", async load => ({ ...await load<object>(), ...api }));
const page = (offset = 0) => ({ available: true, readOnly: true, notice: "历史观察只读；仅显示你当前获准读取的资料。", episodes: [{ id: `episode_${offset}`, subjectKey: "研究患者甲", kind: "observation", label: "历史观察", windowStart: null, windowEnd: null, state: "read_only", exitDate: "2026-10-01T00:00:00Z", exitReason: "观察窗口结束", measurements: [{ field: "outcome", label: "结局量表", value: null, unit: "分", at: null }] }], page: { limit: 50, offset, nextOffset: offset === 0 ? 50 : null } });
beforeEach(() => { vi.clearAllMocks(); api.getVcrFollowupHistory.mockImplementation(async (_id, offset) => page(offset)); api.downloadVcrFollowupHistory.mockResolvedValue(undefined); });
afterEach(cleanup);
it("reads on explicit expansion, preserves unknown values and exports only the current authorized page", async () => {
  render(<VcrFollowupHistory studyId="std_a" canExport />);
  expect(api.getVcrFollowupHistory).not.toHaveBeenCalled();
  await userEvent.click(screen.getByText("历史观察记录（只读）"));
  expect(await screen.findByRole("table", { name: "保留的历史观察值" })).toHaveTextContent("未记录 分");
  expect(screen.getByText("观察窗口结束")).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "下一页历史记录" }));
  await waitFor(() => expect(api.getVcrFollowupHistory).toHaveBeenCalledWith("std_a", 50));
  await userEvent.click(await screen.findByRole("button", { name: "下载本页 CSV" }));
  expect(api.downloadVcrFollowupHistory).toHaveBeenCalledWith("std_a", 50, 50);
});
it("keeps a retry for history reads and offers no export without that ability", async () => {
  api.getVcrFollowupHistory.mockRejectedValueOnce(new Error("unavailable"));
  render(<VcrFollowupHistory studyId="std_a" canExport={false} />);
  await userEvent.click(screen.getByText("历史观察记录（只读）"));
  await userEvent.click(await screen.findByRole("button", { name: "重试" }));
  expect(await screen.findByRole("table", { name: "保留的历史观察值" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "下载本页 CSV" })).toBeNull();
});

it("preserves calendar-only and partial source dates without adding a clock or changing the day", async () => {
  const data = page();
  Object.assign(data.episodes[0], { exitDate: "2026-10-01", windowStart: "2026-10", windowEnd: "2026" });
  Object.assign(data.episodes[0].measurements[0], { at: "2026-10-01T09:30" });
  api.getVcrFollowupHistory.mockResolvedValueOnce(data);
  render(<VcrFollowupHistory studyId="std_a" canExport={false} />);
  await userEvent.click(screen.getByText("历史观察记录（只读）"));
  expect(await screen.findByText("2026-10-01", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("2026-10 至 2026", { exact: true })).toBeInTheDocument();
  expect(screen.getByRole("table", { name: "保留的历史观察值" })).toHaveTextContent("2026-10-01T09:30");
  expect(document.body.textContent).not.toMatch(/00:00|2026\/9\/30/);
});
it("writes explicit timestamp instants in Beijing time, whatever zone the reader is in", async () => {
  const data = page();
  Object.assign(data.episodes[0], { exitDate: "2026-10-01", windowStart: "2026-10-01T00:00:00Z", windowEnd: "2026-10-01T00:30:00+00:00" });
  api.getVcrFollowupHistory.mockResolvedValueOnce(data);
  render(<VcrFollowupHistory studyId="std_a" canExport={false} />);
  await userEvent.click(screen.getByText("历史观察记录（只读）"));
  expect(await screen.findByText("2026/10/1 08:00:00 至 2026/10/1 08:30:00", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("2026-10-01", { exact: true })).toBeInTheDocument();
});
