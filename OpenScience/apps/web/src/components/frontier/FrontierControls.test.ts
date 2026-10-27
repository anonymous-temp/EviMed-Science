import { describe, expect, it, vi } from "vitest";
import { frontierToolbar } from "./FrontierControls";

function props(): Parameters<typeof frontierToolbar>[0] {
  return {
    view: "daily", onView: vi.fn(),
    filters: { channel: "", lane: "", specialties: [], tag: "", evidence: "", starred: false, unread: false, window: "", byTime: false },
    onFilters: vi.fn(), showWindow: false, searching: false,
    search: { label: "搜索", value: "", onChange: vi.fn() }, tag: null, hotTags: { loading: false, tags: [] },
    hot: { window: "week", board: null, windows: false, onWindow: vi.fn() },
    following: { feed: false, token: null, followList: undefined },
    issue: { filters: [], actions: null }, zones: { filters: [], summary: undefined, onCreate: null },
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

  it("keeps track category navigation apart from agency filtering and exposes permitted creation", () => {
    const input = props();
    input.view = "track";
    input.track.filters = [
      { kind: "chips", label: "追踪类别", value: "approvals", options: [{ value: "approvals", label: "审批" }], onChange: vi.fn() },
      { kind: "select", label: "机构", value: "agency", options: [{ value: "agency", label: "机构" }], onChange: vi.fn() },
    ];
    const toolbar = frontierToolbar(input);
    expect(toolbar.navigation?.map(item => item.label)).toEqual(["追踪类别"]);
    expect(toolbar.filters?.map(item => item.label)).toEqual(["机构"]);
    const create = vi.fn();
    input.view = "zones";
    input.zones.onCreate = create;
    const primary = frontierToolbar(input).actionPlan?.primary;
    expect(primary?.label).toBe("新建专区");
    if (primary && "onSelect" in primary) primary.onSelect?.();
    expect(create).toHaveBeenCalledOnce();
  });
});
