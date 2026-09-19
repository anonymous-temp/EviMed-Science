import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapsuleTimeline, timelineSentence } from "./CapsuleTimeline";

const client = vi.hoisted(() => ({ MEMORY_CHANGED_EVENT: "evimed.memory.changed", fetchMemoryTimeline: vi.fn() }));
vi.mock("@/lib/memoryClient", () => client);

const base = { at: "2026-09-18T01:00:00.000Z", day: "2026-09-18" };

describe("the timeline's words", () => {
  it("says every event in Chinese, from codes and the stored words", () => {
    expect(timelineSentence({ ...base, id: "a", type: "memory", change: "updated", kind: "preference", before: "只看 RCT", after: "RCT 优先", by: "extraction" }))
      .toEqual({ label: "改动 · 偏好", text: "「只看 RCT」 → 「RCT 优先」（从任务中学到）" });
    expect(timelineSentence({ ...base, id: "b", type: "memory", change: "superseded", kind: "project_fact", before: "华法林 2.5 mg", after: "华法林 3 mg", wasTrue: true }))
      .toEqual({ label: "曾经如此 · 项目事实", text: "「华法林 2.5 mg」 → 现在是「华法林 3 mg」" });
    expect(timelineSentence({ ...base, id: "c", type: "run", change: "succeeded", title: "阿司匹林一级预防", recalled: 3, methods: 2 }))
      .toEqual({ label: "任务 · 已完成", text: "阿司匹林一级预防（用了 3 条记忆、2 个方法）" });
    expect(timelineSentence({ ...base, id: "d", type: "method", change: "approved", name: "证据矩阵先行" }).label).toBe("方法生效");
    expect(timelineSentence({ ...base, id: "e", type: "feedback", change: "memory-deleted", kind: "preference" }))
      .toEqual({ label: "你删除了", text: "一条偏好记忆" });
    // A code a newer server adds reads as what it is, not as a guess.
    expect(timelineSentence({ ...base, id: "f", type: "memory", change: "something-new", kind: "preference", after: "x" }).label).toBe("记忆变化 · 偏好");
  });
});

describe("时间轴", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  const page = (items: object[], nextBefore: string | null = null) => ({
    items, nextBefore, timeZone: "Asia/Shanghai", missing: [],
    density: [{ day: "2026-09-18", memory: 1, run: 1, method: 0, feedback: 0 }, { day: "2026-08-02", memory: 1, run: 0, method: 0, feedback: 0 }],
  });

  it("groups events by day, newest first, loads earlier ones, and narrows to a month", async () => {
    client.fetchMemoryTimeline
      .mockResolvedValueOnce(page([
        { ...base, id: "m1", type: "memory", change: "created", kind: "preference", after: "要中文", basis: "stated" },
        { ...base, id: "r1", type: "run", change: "succeeded", title: "阿司匹林一级预防", recalled: 2, methods: 0 },
      ], "2026-09-18T01:00:00.000Z"))
      .mockResolvedValueOnce(page([
        { at: "2026-08-02T01:00:00.000Z", day: "2026-08-02", id: "m0", type: "memory", change: "created", kind: "profile", after: "临床药师" },
      ]));
    render(<CapsuleTimeline />);
    expect(await screen.findByText("「要中文」 · 你说过")).toBeInTheDocument();
    expect(screen.getByText("阿司匹林一级预防（用了 2 条记忆）")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "过去一年共有 3 件变化" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "加载更早的" }));
    expect(await screen.findByText("「临床药师」")).toBeInTheDocument();
    expect(client.fetchMemoryTimeline).toHaveBeenLastCalledWith({ before: "2026-09-18T01:00:00.000Z", limit: 50 });
    expect(screen.queryByRole("button", { name: "加载更早的" })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("只看"), "2026-08");
    expect(screen.queryByText("「要中文」 · 你说过")).not.toBeInTheDocument();
    expect(screen.getByText("「临床药师」")).toBeInTheDocument();
    const [august] = screen.getAllByRole("list");
    expect(within(august).getByText("2026-08-02")).toBeInTheDocument();
  });

  it("says when there is nothing yet, and when it could not read", async () => {
    client.fetchMemoryTimeline.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce({ ...page([]), density: [] });
    render(<CapsuleTimeline />);
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText(/还没有任何变化/)).toBeInTheDocument());
  });
});
