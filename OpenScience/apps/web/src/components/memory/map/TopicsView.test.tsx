import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapTopic } from "@/lib/memoryMapClient";
import { TopicsView, trendWords } from "./TopicsView";

const editTopic = vi.fn();
vi.mock("@/lib/memoryMapClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/memoryMapClient")>("@/lib/memoryMapClient")),
  editTopic: (...args: unknown[]) => editTopic(...args),
}));

const topic = (id: string, label: string, weight: number, trend = 0): MapTopic => ({ id, label, weight, trend, members: [] });
const topics = [topic("topic:a", "数据库与性能", 10, 1), topic("topic:b", "预算与采购", 6, -2), topic("topic:c", "心衰随访", 6)];

const view = (props: Partial<Parameters<typeof TopicsView>[0]> = {}) => {
  const onChoose = vi.fn();
  const onChanged = vi.fn();
  render(<TopicsView topics={topics} selected={null} grouping={false} status="ready" onChoose={onChoose} onChanged={onChanged} {...props} />);
  return { onChoose, onChanged };
};

beforeEach(() => editTopic.mockReset().mockResolvedValue({ status: "ready", topics: [] }));
afterEach(cleanup);

describe("主题", () => {
  it("ranks the topics with the number each word's size stands for, and says the trend in words and a sign", () => {
    view();
    const list = screen.getByRole("list", { name: "主题排行" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent?.replace(/\s+/gu, " "))).toEqual([
      expect.stringContaining("数据库与性能10 条记忆 · ↑ 近 30 天 +1"), expect.stringContaining("预算与采购6 条记忆 · ↓ 近 30 天 −2"), expect.stringContaining("心衰随访6 条记忆 · → 持平"),
    ]);
    expect(trendWords(0)).toBe("→ 持平");
  });

  it("narrows the map to a topic from its row, and lets go on a second press", async () => {
    const user = userEvent.setup();
    const { onChoose } = view();
    await user.click(screen.getByRole("button", { name: "数据库与性能" }));
    expect(onChoose).toHaveBeenLastCalledWith("topic:a");
    cleanup();
    const second = view({ selected: "topic:a" });
    await user.click(screen.getByRole("button", { name: "数据库与性能" }));
    expect(second.onChoose).toHaveBeenLastCalledWith(null);
  });

  it("renames a topic in place without asking anything, then reads the map again", async () => {
    const user = userEvent.setup();
    const { onChanged } = view();
    await user.click(screen.getByRole("button", { name: "“预算与采购”的操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "改名" }));
    const box = screen.getByRole("textbox", { name: "主题的新名字" });
    await user.clear(box);
    await user.type(box, "季度预算");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(editTopic).toHaveBeenCalledWith("topic:b", { label: "季度预算" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("merges a topic into another, and dismisses one with 「不是这个」, which also lets go of it", async () => {
    const user = userEvent.setup();
    const { onChoose, onChanged } = view({ selected: "topic:c" });
    await user.click(screen.getByRole("button", { name: "“心衰随访”的操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "预算与采购" }));
    await waitFor(() => expect(editTopic).toHaveBeenCalledWith("topic:c", { mergeInto: "topic:b" }));
    await user.click(screen.getByRole("button", { name: "“心衰随访”的操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "不是这个" }));
    await waitFor(() => expect(editTopic).toHaveBeenCalledWith("topic:c", { dismiss: true }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith(null));
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("draws no cloud under six topics: the ranking says it better", () => {
    view();
    expect(screen.getByText("主题还不多，先看右边的排行。")).toBeInTheDocument();
    expect(document.querySelector("[data-chart='topic-cloud']")).toBeNull();
  });

  it("draws the cloud from six topics up, and names it for a screen reader", () => {
    view({ topics: Array.from({ length: 6 }, (_, index) => topic(`topic:${index}`, `主题 ${index}`, 10 - index)) });
    expect(screen.getByRole("img", { name: "主题云，共 6 个主题，排行在旁边。" })).toBeInTheDocument();
    expect(document.querySelector("[data-chart='topic-cloud']")).not.toBeNull();
  });

  it("says why there is none: being grouped, or too few memories", () => {
    view({ topics: [], grouping: true, status: "stale" });
    expect(screen.getByRole("status")).toHaveTextContent("正在把记忆整理成主题");
    cleanup();
    view({ topics: [], status: "empty" });
    expect(screen.getByRole("status")).toHaveTextContent("再多聊几次");
  });

  it("says what failed when an edit fails, and keeps the topic", async () => {
    editTopic.mockRejectedValueOnce(new Error("no"));
    const user = userEvent.setup();
    const { onChanged } = view();
    await user.click(screen.getByRole("button", { name: "“预算与采购”的操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "不是这个" }));
    await waitFor(() => expect(editTopic).toHaveBeenCalled());
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByText("预算与采购")).toBeInTheDocument();
  });
});
