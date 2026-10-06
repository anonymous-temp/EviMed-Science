import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { FrontierDaily } from "@/lib/frontierClient";
import { DailyIssue, type DailyState } from "./DailyView";

vi.mock("./FrontierDetails", () => ({ FrontierDetails: () => null }));

const issue = (overrides: Partial<FrontierDaily> = {}): FrontierDaily => ({
  day: "2026-09-22", windowStart: null, windowEnd: null, generatedAt: null, lead: null, sections: [], safety: [], aiMinute: null,
  markdown: "日报", itemCount: 0, readingMinutes: 1, previousDay: null, nextDay: null, ...overrides,
});
const state = (daily: FrontierDaily): DailyState => ({ index: [{ day: daily.day, title: null, itemCount: 0, generatedAt: null }], issue: daily, loading: false, error: null, retry: () => {} });
const show = (daily: FrontierDaily, weekly = false) => render(<MemoryRouter><DailyIssue state={state(daily)} onDay={() => {}} weekly={weekly} /></MemoryRouter>);

describe("「你关注的专区」 in the daily and the weekly", () => {
  it("lists the reader's followed zones with their new and changed cards, each opening its card", () => {
    show(issue({ followedZones: [{ zoneId: "ez_1", zoneTitle: "房颤抗凝", cards: [
      { id: "ec_new", title: "阿哌沙班与卒中", summary: "一项随机对照试验。", change: "new", revision: 1, updatedAt: null },
      { id: "ec_old", title: "华法林剂量", summary: "", change: "updated", revision: 4, updatedAt: null },
    ] }] }));
    const section = screen.getByRole("region", { name: "你关注的专区" });
    expect(within(section).getByRole("link", { name: "房颤抗凝" })).toHaveAttribute("href", "/app/frontier/zones/ez_1");
    expect(within(section).getByRole("link", { name: "阿哌沙班与卒中" })).toHaveAttribute("href", "/app/frontier/zones/ez_1/evidence/ec_new");
    expect(within(section).getByRole("link", { name: "华法林剂量" })).toHaveAttribute("href", "/app/frontier/zones/ez_1/evidence/ec_old");
    const rows = within(within(section).getByRole("list", { name: "房颤抗凝" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("新");
    expect(rows[1]).toHaveTextContent("更新");
    expect(within(section).getByText("一项随机对照试验。")).toBeInTheDocument();
  });

  it("is absent for a reader who follows nothing, and from a server that does not send it", () => {
    const { unmount } = show(issue({ followedZones: [] }));
    expect(screen.queryByText("你关注的专区")).not.toBeInTheDocument();
    unmount();
    show(issue());
    expect(screen.queryByText("你关注的专区")).not.toBeInTheDocument();
  });

  it("is the weekly's too, through the same view", () => {
    show(issue({ followedZones: [{ zoneId: "ez_2", zoneTitle: "心肾", cards: [{ id: "ec_3", title: "SGLT2", summary: "", change: "updated", revision: 2, updatedAt: null }] }] }), true);
    expect(screen.getByRole("region", { name: "你关注的专区" })).toBeInTheDocument();
  });
});
