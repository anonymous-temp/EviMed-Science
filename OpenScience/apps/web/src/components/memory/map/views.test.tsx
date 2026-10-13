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

  it("lets go of a chosen axis on a second press, and says the sentence instead of a radar that would be a needle", async () => {
    const onAxis = vi.fn();
    const user = userEvent.setup();
    render(<DimsView dimensions={[work, memory]} selected="aspect:a" onAxis={onAxis} />);
    expect(screen.getByText("最近 30 天的对话还不多，这里先不画图。")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /在做什么/u })).toBeNull();
    await user.click(screen.getByRole("button", { name: "偏好 8" }));
    expect(onAxis).toHaveBeenCalledWith(null);
  });

  it("says there is nothing yet with no dimension at all", () => {
    render(<DimsView dimensions={[]} selected={null} onAxis={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("再多聊几次");
  });
});

const scope = { projectId: null, range: { from: null, to: "2026-10-12", unit: "month" as const }, timeZone: "UTC", focus: null, depth: null };

describe("时间", () => {
  it("says there is nothing when there are no lineages and no events, and what it draws otherwise in words under a canvas it cannot paint", () => {
    const base = { summary: { memories: 0, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null }, scope };
    render(<TimeView doc={{ ...base, lanes: [], events: [] }} range="all" projectName={() => "项目"} onRange={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("还没有记下的事");
    cleanup();
    render(<TimeView doc={{ ...base, lanes: [], events: [] }} range="2026-09-01..2026-09-30" projectName={() => "项目"} onRange={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("这段时间里没有记下的事");
    cleanup();
    render(<TimeView doc={{ ...base, lanes: [], events: [{ id: "e1", at: "2026-10-01T00:00:00.000Z", type: "memory", change: "created", ref: "memory:a", lane: "account", kind: "decision", text: "定了" }] }} range="all" projectName={() => "项目"} onRange={() => {}} onOpen={() => {}} />);
    // An account that has replaced nothing has no lineages: the picture and its words say the events and nothing of bars.
    expect(screen.getByRole("img", { name: "时间线：1 件记下的事，列表在下方。" })).toBeInTheDocument();
    expect(screen.getByText("1 件记下的事。")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/蓝条|灰条|琥珀|沿革/u);
  });

  it("names the bars, the grey and the amber mark only when the document has them", () => {
    const base = { summary: { memories: 2, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null }, scope };
    const event = { id: "e1", at: "2026-10-01T00:00:00.000Z", type: "memory" as const, change: "created", ref: "memory:a", lane: "account", kind: "decision", text: "定了" };
    const lane = (conflict: boolean) => ({ id: "l1", label: "写作", projectId: null, segments: [{ recordId: "a", text: "先写摘要", from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", state: "replaced" as const, conflict }] });
    render(<TimeView doc={{ ...base, lanes: [lane(false)], events: [event] }} range="all" projectName={() => "项目"} onRange={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole("img", { name: "时间线：1 条沿革，1 件记下的事，列表在下方。" })).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/蓝条是一直成立的说法/u);
    expect(document.body.textContent).not.toMatch(/琥珀/u);
    cleanup();
    render(<TimeView doc={{ ...base, lanes: [lane(true)], events: [event] }} range="all" projectName={() => "项目"} onRange={() => {}} onOpen={() => {}} />);
    expect(document.body.textContent).toMatch(/琥珀小标是和另一条不一致/u);
  });
});

describe("活跃", () => {
  const doc = { scope, buckets: { unit: "day" as const, series: [{ t: "2026-10-11", memory: 2, run: 1, method: 0, feedback: 0 }, { t: "2026-10-10", memory: 0, run: 0, method: 1, feedback: 0 }] } };
  it("is a calendar of the year with its legend, the zone it counts days in and no streak", () => {
    render(<ActivityView doc={doc} range="all" onDay={() => {}} />);
    expect(screen.getByRole("img", { name: /近一年的活跃日历，共 2 天有记录/u })).toBeInTheDocument();
    expect(screen.getByText(/按你的时区（UTC）计日，一共 4 件/u)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/连续|streak|断了/u);
  });
  it("lets go of a chosen day from the sentence that says which day it is", async () => {
    const onDay = vi.fn();
    const user = userEvent.setup();
    render(<ActivityView doc={doc} range="2026-10-11..2026-10-11" onDay={onDay} />);
    await user.click(screen.getByRole("button", { name: "看的是 2026-10-11，点这里看全部" }));
    expect(onDay).toHaveBeenCalledWith(null);
  });
  it("says what to do with an empty year", () => {
    render(<ActivityView doc={{ ...doc, buckets: { unit: "day", series: [] } }} range="all" onDay={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("一年里还没有记录");
  });
});
