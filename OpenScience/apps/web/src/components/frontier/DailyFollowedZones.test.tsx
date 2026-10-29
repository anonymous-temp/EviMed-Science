import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { FrontierDaily, FrontierFollowedZone } from "@/lib/frontierClient";
import { DailyIssue, type DailyState } from "./DailyView";
import { frontierItem } from "./__fixtures__/frontierItems";

vi.mock("./FrontierDetails", () => ({ FrontierDetails: () => null, frontierDetailsOffered: () => false }));

const issue = (overrides: Partial<FrontierDaily> = {}): FrontierDaily => ({
  day: "2026-09-22", windowStart: null, windowEnd: null, generatedAt: null, lead: null, sections: [], safety: [], aiMinute: null,
  markdown: "日报", itemCount: 0, readingMinutes: 1, previousDay: null, nextDay: null, ...overrides,
});
const state = (daily: FrontierDaily): DailyState => ({ index: [{ day: daily.day, title: null, itemCount: 0, generatedAt: null }], issue: daily, loading: false, error: null, retry: () => {} });
const show = (daily: FrontierDaily, weekly = false) => render(<MemoryRouter><DailyIssue state={state(daily)} onDay={() => {}} weekly={weekly} /></MemoryRouter>);

const zones: FrontierFollowedZone[] = [
  { zoneId: "ez_1", slug: "glp1-weight", zoneTitle: "GLP-1 受体激动剂减重", entries: [
    { item: frontierItem({ id: "it_1", title: "司美格鲁肽新适应症获批", summary: "美国 FDA 批准了新的适应症。" }), category: "regulatory", categoryLabel: "监管批准" },
    { item: frontierItem({ id: "it_2", title: "肥胖治疗指南更新", summary: "" }), category: "guideline", categoryLabel: "指南与共识" },
  ] },
  { zoneId: "ez_2", slug: null, zoneTitle: "我的房颤专区", entries: [{ item: frontierItem({ id: "it_3", title: "房颤抗凝新试验" }), category: "evidence", categoryLabel: "新证据" }] },
];

describe("「你关注的专区」 in the daily and the weekly", () => {
  it("lists the key updates of the reader's zones, each zone opening by its slug or its id and each item opening its reading page", () => {
    show(issue({ followedZones: zones }));
    const section = screen.getByRole("region", { name: "你关注的专区" });
    expect(within(section).getByRole("link", { name: "GLP-1 受体激动剂减重" })).toHaveAttribute("href", "/app/frontier/zones/s/glp1-weight");
    expect(within(section).getByRole("link", { name: "我的房颤专区" })).toHaveAttribute("href", "/app/frontier/zones/ez_2");
    const rows = within(within(section).getByRole("list", { name: "GLP-1 受体激动剂减重" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole("link", { name: "司美格鲁肽新适应症获批" })).toHaveAttribute("href", "/app/frontier/items/it_1");
    expect(within(rows[0]).getByText("美国 FDA 批准了新的适应症。")).toBeInTheDocument();
    expect(rows[0]).not.toHaveTextContent("监管批准");
  });

  it("is absent for a reader with no zone update, and from a server that does not send it", () => {
    const { unmount } = show(issue({ followedZones: [] }));
    expect(screen.queryByText("你关注的专区")).not.toBeInTheDocument();
    unmount();
    show(issue());
    expect(screen.queryByText("你关注的专区")).not.toBeInTheDocument();
  });

  it("is the weekly's too, each row with the week's category in front", () => {
    show(issue({ followedZones: zones }), true);
    const section = screen.getByRole("region", { name: "你关注的专区" });
    const rows = within(within(section).getByRole("list", { name: "GLP-1 受体激动剂减重" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("监管批准");
    expect(rows[1]).toHaveTextContent("指南与共识");
  });

  it("no longer lists the things a reader typed to follow: those are zones now", () => {
    show(issue({ followedZones: zones }));
    expect(screen.queryByRole("region", { name: "你关注的" })).not.toBeInTheDocument();
  });
});
