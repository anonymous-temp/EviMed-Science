import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SELECTION, type MapSelection } from "./useMapSelection";
import { mapToolbar, rangeLabel } from "./mapToolbar";

const search = { draft: "", setDraft: vi.fn(), clear: vi.fn(), composition: {} };
const doc = { facets: { projects: [], kinds: [{ id: "preference", label: "偏好", count: 4 }], topics: [], dimensions: [] }, summary: { memories: 10, documents: 0, methods: 0, projects: 0, needsLook: 2, since: null } };
const build = (selection: Partial<MapSelection> = {}, over: Partial<Parameters<typeof mapToolbar>[0]> = {}) => mapToolbar({
  selection: { ...DEFAULT_SELECTION, ...selection }, doc, topicName: null, aspectName: null, focusLabel: null,
  onView: vi.fn(), onNarrow: vi.fn(), onClear: vi.fn(), search, ...over,
});
const labels = (toolbar: ReturnType<typeof build>) => (toolbar.filters ?? []).map((filter) => `${filter.kind}:${filter.label}`);

describe("the map's one row of controls", () => {
  it("is the five views first — pinned, and never counted as a filter — then what narrows them, then the search", () => {
    const toolbar = build({ view: "topics" });
    const views = toolbar.filters![0];
    expect(views).toMatchObject({ kind: "chips", label: "地图的视图", value: "topics", neutral: "topics", pinned: true });
    expect(views?.kind === "chips" ? views.options.map((option) => option.label) : null).toEqual(["关系", "主题", "维度", "时间", "活跃"]);
    expect(labels(toolbar)).toEqual(["chips:地图的视图", "select:全部时间", "select:种类", "toggle:只看需要看一眼的"]);
    expect(toolbar.search).toMatchObject({ label: "搜索记忆地图", value: "", maxLength: 80 });
    expect(toolbar.onClear).toBeDefined();
  });

  it("has no filter for nothing: no kinds and nothing to look at, no menu and no toggle — and the views and the search before the document is read", () => {
    const empty = { facets: { projects: [], kinds: [], topics: [], dimensions: [] }, summary: { memories: 0, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null } };
    expect(labels(build({}, { doc: empty }))).toEqual(["chips:地图的视图", "select:全部时间"]);
    expect(labels(build({}, { doc: null }))).toEqual(["chips:地图的视图", "select:全部时间"]);
  });

  it("keeps the look toggle while it is on, so the page can let go of it, and draws each narrowing as a mark that lets go with a press", () => {
    const onNarrow = vi.fn();
    const toolbar = build({ look: true, topic: "topic:a", dimension: "aspect:x", focus: "memory:m1", depth: 2, chain: true }, {
      doc: { ...doc, summary: { ...doc.summary, needsLook: 0 } }, topicName: "回答风格", aspectName: "偏好", focusLabel: "记忆 m1", onNarrow,
    });
    expect(labels(toolbar)).toEqual([
      "chips:地图的视图", "select:全部时间", "select:种类", "toggle:只看需要看一眼的", "toggle:主题：回答风格", "toggle:维度：偏好", "toggle:聚焦：记忆 m1", "select:深度", "toggle:来源链",
    ]);
    const marks = (toolbar.filters ?? []).filter((filter) => filter.kind === "toggle" && filter.label.includes("："));
    for (const mark of marks) { if (mark.kind === "toggle") { expect(mark.pressed).toBe(true); mark.onChange(false); } }
    expect(onNarrow.mock.calls.map(([patch]) => patch)).toEqual([{ topic: null }, { dimension: null }, { focus: null }]);
  });

  it("draws the part a card of the overview opened the map on as a mark that lets go of it, in the overview's own word", () => {
    const onNarrow = vi.fn();
    const toolbar = build({ part: "method" }, { onNarrow });
    expect(labels(toolbar)).toContain("toggle:只看：做法");
    const mark = (toolbar.filters ?? []).find((filter) => filter.kind === "toggle" && filter.label === "只看：做法");
    expect(mark).toMatchObject({ pressed: true });
    if (mark?.kind === "toggle") mark.onChange(false);
    expect(onNarrow).toHaveBeenCalledWith({ part: null });
    expect(labels(build({}))).not.toContain("toggle:只看：做法");
  });

  it("has no depth or source chain for a group of marks, which has no neighbours to reach and no sources of its own", () => {
    expect(labels(build({ focus: "cluster:preference" }, { focusLabel: "一组标记" }))).not.toContain("select:深度");
    expect(labels(build({ focus: "cluster:preference" }, { focusLabel: "一组标记" }))).not.toContain("toggle:来源链");
  });

  it("offers the window as a menu on every view but 时间, and as a mark that lets go of it there — one entry for the window, never two", () => {
    const onNarrow = vi.fn();
    const menu = build({ view: "graph", range: "30d" }, { onNarrow }).filters!.find((filter) => filter.kind === "select" && filter.allLabel === "全部时间");
    expect(menu).toMatchObject({ value: "30d" });
    if (menu?.kind === "select") menu.onChange(null);
    expect(onNarrow).toHaveBeenLastCalledWith({ range: "all" });
    // A window chosen on the bars (or a day on the calendar) is a menu entry of its own, named by its days, and not a gap in the menu.
    const custom = build({ view: "activity", range: "2026-10-11..2026-10-11" }).filters!.find((filter) => filter.kind === "select" && filter.allLabel === "全部时间");
    expect(custom).toMatchObject({ value: "2026-10-11..2026-10-11" });
    expect(labels(build({ view: "time" }))).not.toContain("select:全部时间");
    const windowed = build({ view: "time", range: "2026-09-14..2026-09-20" }, { onNarrow });
    const mark = windowed.filters!.find((filter) => filter.kind === "toggle");
    expect(mark).toMatchObject({ pressed: true });
    expect(mark?.label).toMatch(/^时间：.+ 至 .+$/u);
    if (mark?.kind === "toggle") mark.onChange(false);
    expect(onNarrow).toHaveBeenLastCalledWith({ range: "all" });
  });

  it("names a range by its days", () => {
    expect(rangeLabel("2026-09-14..2026-09-20")).toMatch(/^.+ 至 .+$/u);
    expect(rangeLabel("2026-10-11..2026-10-11")).not.toContain("至");
    expect(rangeLabel("all")).toBe("全部时间");
  });
});
