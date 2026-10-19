import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapDimension } from "@/lib/memoryMapClient";
import { ActivityView } from "./ActivityView";
import { DimsView } from "./DimsView";
import { TimeView } from "./TimeView";

afterEach(cleanup);

const axis = (id: string, label: string, value: number, previousValue: number, count = value, kinds?: string[]) => ({ id, label, value, previousValue, count, ...(kinds ? { kinds } : {}) });
const memory: MapDimension = { id: "memory", title: "各方面记了多少", previous: "30 天前", scale: "count", total: 19, previousTotal: 12, axes: [axis("aspect:a", "偏好", 8, 5, 8, ["preference"]), axis("aspect:b", "背景", 4, 3, 4), axis("aspect:c", "已定的决策", 7, 4, 7)] };
const work: MapDimension = { id: "work", title: "在做什么", previous: "前 30 天", scale: "share", total: 3, previousTotal: 9, axes: [axis("cat:普通问答", "普通问答", 1, 0.5, 3), axis("cat:写作与传播", "写作与传播", 0, 0.5, 0)] };

describe("维度", () => {
  it("draws a radar that has something to say, prints the numbers by name, and narrows the map when an axis is pressed", async () => {
    const onAxis = vi.fn();
    const user = userEvent.setup();
    render(<DimsView dimensions={[memory]} selected={null} onAxis={onAxis} />);
    expect(screen.getByRole("img", { name: /各方面记了多少：偏好 8，背景 4，已定的决策 7/u })).toBeInTheDocument();
    expect(screen.getByText("虚线是30 天前。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "偏好 8" }));
    expect(onAxis).toHaveBeenCalledWith("aspect:a");
  });

  it("lets go of a chosen axis and draws sparse dimensions as comparable bars", async () => {
    const onAxis = vi.fn();
    const user = userEvent.setup();
    render(<DimsView dimensions={[work, memory]} selected="aspect:a" onAxis={onAxis} />);
    expect(screen.getByRole("img", { name: /在做什么/u })).toBeInTheDocument();
    expect(document.querySelector('[data-dimension-view="bars"]')).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "偏好 8" }));
    expect(onAxis).toHaveBeenCalledWith(null);
  });

  it("says there is nothing yet with no dimension at all", () => {
    render(<DimsView dimensions={[]} selected={null} onAxis={() => {}} />);
    expect(screen.getByText(/再多聊几次/u)).toBeInTheDocument();
  });
});

const scope = { projectId: null, range: { from: null, to: "2026-10-12", unit: "month" as const }, timeZone: "UTC", focus: null, depth: null };

describe("时间", () => {
  it("says there is nothing when there are no lineages and no events, and what it draws otherwise in words under a canvas it cannot paint", () => {
    const base = { summary: { memories: 0, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null }, scope };
    render(<TimeView doc={{ ...base, lanes: [], events: [] }} range="all" projectName={() => "项目"} onRange={() => {}} onOpen={() => {}} />);
    expect(screen.getByText(/还没有记下的事/u)).toBeInTheDocument();
    cleanup();
    render(<TimeView doc={{ ...base, scope: { ...scope, range: { ...scope.range, from: "2026-09-01", to: "2026-09-30" } }, lanes: [], events: [] }} range="2026-09-01..2026-09-30" projectName={() => "项目"} onRange={() => {}} onOpen={() => {}} />);
    expect(screen.getByText(/这段时间里没有记下的事/u)).toBeInTheDocument();
    cleanup();
    render(<TimeView doc={{ ...base, lanes: [], events: [{ id: "e1", at: "2026-10-01T00:00:00.000Z", type: "memory", change: "created", ref: "memory:a", lane: "account", kind: "decision", text: "定了" }] }} range="all" projectName={() => "项目"} onRange={() => {}} onOpen={() => {}} />);
    // An account that has replaced nothing has no lineages: the picture and its words say the events and nothing of bars.
    expect(screen.getByRole("img", { name: "时间线：1 次变化，列表在下方。" })).toBeInTheDocument();
    expect(screen.getByText("1 次变化。")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/蓝条|灰条|琥珀|沿革|一直成立|后来被替代/u);
  });

  it("names the bars, the grey and the amber mark only when the document has them", () => {
    const base = { summary: { memories: 2, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null }, scope };
    const event = { id: "e1", at: "2026-10-01T00:00:00.000Z", type: "memory" as const, change: "created", ref: "memory:a", lane: "account", kind: "decision", text: "定了" };
    const lane = (conflict: boolean) => ({ id: "l1", label: "写作", projectId: null, segments: [{ recordId: "a", text: "先写摘要", from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", state: "replaced" as const, conflict }] });
    render(<TimeView doc={{ ...base, lanes: [lane(false)], events: [event] }} range="all" projectName={() => "项目"} onRange={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole("img", { name: "时间线：1 次变化，1 条说法改过，列表在下方。" })).toBeInTheDocument();
    // The legend is marks, and only the marks the picture has — it never explains how to read it.
    expect(document.body.textContent).toMatch(/一直成立/u);
    expect(document.body.textContent).toMatch(/后来被替代/u);
    expect(document.body.textContent).not.toMatch(/不一致/u);
    cleanup();
    render(<TimeView doc={{ ...base, lanes: [lane(true)], events: [event] }} range="all" projectName={() => "项目"} onRange={() => {}} onOpen={() => {}} />);
    expect(document.body.textContent).toMatch(/和另一条说法不一致/u);
    expect(document.body.textContent).not.toMatch(/拖下面的滑块|蓝条是|灰条和灰点/u);
  });

  it("counts what happened each week in the bars' own heading, from the same events the list is made of", () => {
    const events = [
      { id: "e1", at: "2026-09-22T02:00:00.000Z", type: "memory" as const, change: "created", ref: "memory:a", lane: "account", kind: "decision", text: "定了" },
      { id: "e2", at: "2026-09-23T02:00:00.000Z", type: "memory" as const, change: "created", ref: "memory:b", lane: "account", kind: "preference", text: "偏好" },
      { id: "e3", at: "2026-10-06T02:00:00.000Z", type: "memory" as const, change: "superseded", ref: "memory:a", lane: "account", kind: "decision", text: "改了" },
      { id: "e4", at: "2026-10-07T02:00:00.000Z", type: "memory" as const, change: "updated", ref: "memory:b", lane: "account", kind: "preference", text: "小改" },
    ];
    const base = { summary: { memories: 2, documents: 0, methods: 0, projects: 0, needsLook: 0, since: "2026-09-22" }, scope };
    render(<TimeView doc={{ ...base, lanes: [], events }} range="all" projectName={() => "项目"} onRange={() => {}} onOpen={() => {}} />);
    // An update is an event and not a bar: two written, one merged, none forgotten.
    expect(screen.getByRole("heading", { name: /起，记下 2 件、合并 1 件$/u })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /每周记下、合并和忘记的数量/u })).toBeInTheDocument();
    // The legend names the three counts, in the order they are stacked, and nothing is said about how to read the bars.
    expect([...document.querySelectorAll("[data-legend-role]")].map((mark) => mark.textContent)).toEqual(["记下", "合并", "忘记"]);
    expect(document.body.textContent).not.toMatch(/拖下面的滑块/u);
  });

  it("says in the heading, not in an empty frame, when a window held nothing countable", () => {
    const base = { summary: { memories: 1, documents: 0, methods: 0, projects: 0, needsLook: 0, since: "2026-09-22" }, scope: { ...scope, range: { ...scope.range, from: "2026-10-01", to: "2026-10-07" } } };
    const event = { id: "e1", at: "2026-10-02T02:00:00.000Z", type: "memory" as const, change: "updated", ref: "memory:a", lane: "account", kind: "decision", text: "小改" };
    render(<TimeView doc={{ ...base, lanes: [], events: [event] }} range="2026-10-01..2026-10-07" projectName={() => "项目"} onRange={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole("heading", { name: /没有记下、合并或忘记什么$/u })).toBeInTheDocument();
  });
});

describe("活跃", () => {
  const doc = { scope, buckets: { unit: "day" as const, series: [{ t: "2026-10-11", memory: 2, run: 1, method: 0, feedback: 0 }, { t: "2026-10-10", memory: 0, run: 0, method: 1, feedback: 0 }] } };
  it("is a calendar of the year with its legend, the zone it counts days in and no streak", () => {
    render(<ActivityView doc={doc} range="all" onDay={() => {}} />);
    expect(screen.getByRole("img", { name: /近一年的活跃日历，共 2 天有记录/u })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "近一年有 2 天有记录，共 4 件" })).toBeInTheDocument();
    // The zone the days are counted in is said to a screen reader, and is not a grey line on the page.
    expect(screen.getByText("按你的时区（UTC）计日")).toHaveClass("sr-only");
    // The scale is the legend's marks; the colours' meaning is not explained in words.
    expect(document.body.textContent).not.toMatch(/颜色越深/u);
    expect(document.body.textContent).not.toMatch(/连续|streak|断了/u);
  });
  it("lets go of a chosen day from the sentence that says which day it is", async () => {
    const onDay = vi.fn();
    const user = userEvent.setup();
    render(<ActivityView doc={doc} range="2026-10-11..2026-10-11" onDay={onDay} />);
    await user.click(screen.getByRole("button", { name: "看的是 2026-10-11，看全部" }));
    expect(onDay).toHaveBeenCalledWith(null);
  });
  it("says what to do with an empty year", () => {
    render(<ActivityView doc={{ ...doc, buckets: { unit: "day", series: [] } }} range="all" onDay={() => {}} />);
    expect(screen.getByText(/一年里还没有记录/u)).toBeInTheDocument();
  });
});
