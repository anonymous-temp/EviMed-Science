import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrowthPanel, calendarDay } from "./GrowthPanel";

const client = vi.hoisted(() => ({ fetchMemoryGrowth: vi.fn(), fetchMemoryLearned: vi.fn() }));
vi.mock("@/lib/memoryClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/memoryClient")>("@/lib/memoryClient")), ...client }));

const learned = (days: unknown[]) => ({ timeZone: "Asia/Shanghai", days });
const longHistory = {
  unit: "week", first: "2026-09-12", fromStart: true, timeZone: "Asia/Shanghai",
  points: [{ start: "2026-08-31", known: 0 }, { start: "2026-09-07", known: 2 }, { start: "2026-09-14", known: 3 }, { start: "2026-09-21", known: 4 }], moments: [],
};

describe("a calendar day, as the researcher reads it", () => {
  it("says the month and the day, and the year only when it is not this one — from the day's own parts, so no zone moves it", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    expect(calendarDay("2026-09-22", now)).toBe("9月22日");
    expect(calendarDay("2026-01-01", now)).toBe("1月1日");
    expect(calendarDay("2025-12-31", now)).toBe("2025年12月31日");
    expect(calendarDay("not a day", now)).toBe("");
  });
});

describe("成长", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  it("lists what was learned each day, newest first, with the beginning as text and a method as a row that opens", async () => {
    client.fetchMemoryGrowth.mockResolvedValue(longHistory);
    client.fetchMemoryLearned.mockResolvedValue(learned([
      { day: "2026-09-22", items: [{ kind: "learned", what: "method", id: "m1", title: "引用标记对齐" }, { kind: "improved", what: "handbook", id: "h1", title: "每一句结论落回来源" }] },
      { day: "2026-09-12", items: [{ kind: "start", what: null, id: null, title: "" }] },
    ]));
    const onOpen = vi.fn();
    render(<GrowthPanel practices={null} canOpen={(what, id) => what === "method" && id === "m1"} onOpen={onOpen} />);
    expect(await screen.findByText("学会：引用标记对齐")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent).slice(-2)).toEqual(["9月22日", "9月12日"]);
    expect(screen.getByText("改进：每一句结论落回来源")).toBeInTheDocument();
    expect(screen.getByText("开始记住你")).toBeInTheDocument();
    // Only what the page can open is a button; nothing that looks clickable does nothing.
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["学会：引用标记对齐"]);
    await userEvent.click(screen.getByRole("button", { name: "学会：引用标记对齐" }));
    expect(onOpen).toHaveBeenCalledWith("method", "m1");
  });

  it("says the ways of working the 做法 tab lists — the count it is handed, not the moments on the line", async () => {
    client.fetchMemoryGrowth.mockResolvedValue({ ...longHistory, moments: [{ day: "2026-09-16", kind: "method", title: "引用标记对齐" }] });
    client.fetchMemoryLearned.mockResolvedValue(learned([]));
    const { rerender } = render(<GrowthPanel practices={15} canOpen={() => false} onOpen={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "9月12日开始记住你，现在有 4 条记忆，学会 15 种做法" })).toBeInTheDocument();
    // A list that could not be read is not a number.
    rerender(<GrowthPanel practices={null} canOpen={() => false} onOpen={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "9月12日开始记住你，现在有 4 条记忆" })).toBeInTheDocument();
  });

  it("says what will appear when nothing has been learned and there is no line to draw yet", async () => {
    client.fetchMemoryGrowth.mockResolvedValue({ unit: null, first: null, fromStart: false, points: [], moments: [], timeZone: "UTC" });
    client.fetchMemoryLearned.mockResolvedValue(learned([]));
    render(<GrowthPanel practices={null} canOpen={() => false} onOpen={vi.fn()} />);
    expect(await screen.findByText("还没有成长记录")).toBeInTheDocument();
    expect(screen.getByText("学会的做法和经验，会按天出现在这里。")).toBeInTheDocument();
  });

  it("keeps what it could read and says so once, with a retry, when one of the two reads fails", async () => {
    client.fetchMemoryGrowth.mockRejectedValue(new Error("down"));
    client.fetchMemoryLearned.mockResolvedValue(learned([{ day: "2026-09-12", items: [{ kind: "start", what: null, id: null, title: "" }] }]));
    render(<GrowthPanel practices={null} canOpen={() => false} onOpen={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("没有读到全部成长记录。");
    expect(screen.getByText("开始记住你")).toBeInTheDocument();
    expect(screen.queryByText("还没有成长记录")).not.toBeInTheDocument();
    client.fetchMemoryGrowth.mockResolvedValue(longHistory);
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(await screen.findByRole("img")).toBeInTheDocument();
  });
});
