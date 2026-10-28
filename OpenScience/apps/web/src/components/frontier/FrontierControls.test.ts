import { describe, expect, it, vi } from "vitest";
import { frontierHeaderActions, frontierToolbar } from "./FrontierControls";

function props(): Parameters<typeof frontierToolbar>[0] {
  return {
    view: "daily", onView: vi.fn(),
    filters: { channel: "", lane: "", specialties: [], tag: "", evidence: "", industryKind: "", starred: false, unread: false, window: "", byTime: false },
    onFilters: vi.fn(), showWindow: false, searching: false,
    search: { label: "搜索", value: "", onChange: vi.fn() }, tag: null, hotTags: { loading: false, tags: [] },
    hot: { window: "week", board: null, windows: false, onWindow: vi.fn() },
    following: { feed: false, token: null, followList: undefined },
    issue: { filters: [], actions: null }, zones: { filters: [], summary: undefined },
    track: { filters: [] }, onClear: vi.fn(), onReset: vi.fn(),
  };
}

describe("frontier toolbar composition", () => {
  it("treats daily and weekly as destinations instead of applied filters", () => {
    const input = props();
    const toolbar = frontierToolbar(input);
    expect(toolbar.filters).toEqual([]);
    const period = toolbar.navigation?.[0];
    expect(period?.label).toBe("简报周期");
    if (period?.kind === "chips") period.onChange("weekly");
    expect(input.onView).toHaveBeenCalledWith("weekly");
  });

  it("keeps track category navigation apart from agency filtering and makes permitted creation the page's action", () => {
    const input = props();
    input.view = "track";
    input.track.filters = [
      { kind: "chips", label: "追踪类别", value: "approvals", options: [{ value: "approvals", label: "审批" }], onChange: vi.fn() },
      { kind: "select", label: "机构", value: "agency", options: [{ value: "agency", label: "机构" }], onChange: vi.fn() },
    ];
    const toolbar = frontierToolbar(input);
    expect(toolbar.navigation?.map(item => item.label)).toEqual(["追踪类别"]);
    expect(toolbar.filters?.map(item => item.label)).toEqual(["机构"]);
    // 「新建专区」 is the page's action, in its header, and only on 证据专区 for a reader who may make a zone.
    const create = vi.fn();
    expect(frontierToolbar({ ...input, view: "zones" }).actionPlan).toBeUndefined();
    const primary = frontierHeaderActions("zones", create)?.primary;
    expect(primary?.label).toBe("新建专区");
    if (primary && "onSelect" in primary) primary.onSelect?.();
    expect(create).toHaveBeenCalledOnce();
    expect(frontierHeaderActions("zones", null)).toBeUndefined();
    expect(frontierHeaderActions("all", create)).toBeUndefined();
  });
});
