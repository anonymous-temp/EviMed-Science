import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { overview } from "./__fixtures__/zones";
import { ZoneRail } from "./ZoneRail";

const narrow = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/useContainerNarrow", () => ({ useContainerNarrow: () => narrow.value }));

const NOW = Date.parse("2026-10-29T08:00:00Z");
const PATH = "/app/frontier/zones/s/glp1-obesity";

function weeklySide(counts: number[]) {
  const side = overview().side;
  return {
    ...side,
    weekly: counts.map((count, index) => ({ weekStart: new Date(Date.UTC(2026, 7, 10) + index * 7 * 86_400_000).toISOString().slice(0, 10), count })),
  };
}
const draw = (counts: number[]) => render(<MemoryRouter><ZoneRail side={weeklySide(counts)} path={PATH} now={NOW} /></MemoryRouter>);

afterEach(() => { cleanup(); narrow.value = false; });

describe("the weekly bars of a zone's right column", () => {
  it("opens a week that has items and leaves a week with none as a bar that is not a link, still named for a screen reader", () => {
    draw([0, 0, 4, 0, 0, 7, 0, 0, 0, 0, 0, 2]);
    const weeks = screen.getByRole("list", { name: /近 12 周每周动态条数，共 13 条/ });
    const bars = within(weeks).getAllByRole("listitem");
    expect(bars).toHaveLength(12);
    const links = within(weeks).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual(["8月24日起一周，4 条", "9月14日起一周，7 条", "10月26日起一周，2 条"]);
    // A week of none says so in words and opens nothing: a target that opens an empty list is not one.
    expect(within(bars[0]).queryByRole("link")).toBeNull();
    expect(bars[0]).toHaveTextContent("8月10日起一周，0 条");
  });

  it("gives every bar room for a 24 px target", () => {
    draw([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const item of within(screen.getByRole("list", { name: /每周动态条数/ })).getAllByRole("listitem")) expect(item).toHaveClass("min-w-6");
  });

  it("draws the newest nine where the column is too narrow for twelve bars of that size, and says how many it draws", () => {
    narrow.value = true;
    draw([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const weeks = screen.getByRole("list", { name: /近 9 周每周动态条数，共 \d+ 条/ });
    expect(within(weeks).getAllByRole("link")).toHaveLength(9);
    expect(screen.getByRole("heading", { name: "近 9 周动态" })).toBeInTheDocument();
    expect(within(weeks).getAllByRole("link")[0]).toHaveAttribute("aria-label", "8月31日起一周，4 条");
  });
});
