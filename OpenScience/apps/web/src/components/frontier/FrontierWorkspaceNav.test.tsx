import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { FrontierWorkspaceNav, frontierNavView } from "./FrontierWorkspaceNav";

const open = (entry: string) => render(<MemoryRouter initialEntries={[entry]}><FrontierWorkspaceNav /></MemoryRouter>);

it("lists the seven views with the page's own addresses", () => {
  open("/app/frontier?view=hot");
  const nav = screen.getByRole("navigation", { name: "前沿动态视图" });
  const links = within(nav).getAllByRole("link");
  expect(links.map(link => link.textContent)).toEqual(["精选", "全部", "关注", "热榜", "追踪", "简报", "证据专区"]);
  expect(links.map(link => link.getAttribute("href"))).toEqual(["/app/frontier", "/app/frontier?view=all", "/app/frontier?view=following", "/app/frontier?view=hot", "/app/frontier?view=track", "/app/frontier?view=daily", "/app/frontier?view=zones"]);
  expect(within(nav).getByRole("link", { name: "热榜" })).toHaveAttribute("aria-current", "page");
});
it("reads old and sub-page addresses", () => {
  expect(frontierNavView("/app/frontier", "")).toBe("selected");
  expect(frontierNavView("/app/frontier", "?view=foryou")).toBe("following");
  expect(frontierNavView("/app/frontier", "?view=weekly&week=2026-W44")).toBe("daily");
  expect(frontierNavView("/app/frontier", "?view=nonsense")).toBe("selected");
  expect(frontierNavView("/app/frontier/zones/z1", "")).toBe("zones");
  expect(frontierNavView("/app/frontier/authors/a1", "")).toBe("zones");
  expect(frontierNavView("/app/frontier/items/i1", "")).toBeNull();
  expect(frontierNavView("/app/frontier/events/e1", "")).toBeNull();
});
it("marks nothing on a reading page", () => {
  open("/app/frontier/items/i1");
  expect(screen.queryAllByRole("link").filter(link => link.getAttribute("aria-current"))).toEqual([]);
});
