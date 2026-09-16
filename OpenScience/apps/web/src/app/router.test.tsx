import { render, screen } from "@testing-library/react";
import { MemoryRouter, Navigate, Outlet, useLocation, useRoutes, type RouteObject } from "react-router";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

// The shell's auth gate and the lazily loaded pages are not what this is
// about; what is, is where every address people have bookmarked ends up
// (2026-09-16 review, D5).
vi.mock("./layout/AppShell", () => ({ AppShell: () => <Outlet /> }));

const { routes } = await import("./router");

function Landed() {
  const location = useLocation();
  return <p data-testid="landed">{`${location.pathname}${location.search}`}</p>;
}

/** The real route table, with every page that is not itself a redirect or
 *  the 404 replaced by a probe that says where the browser ended up. */
function probed(list: RouteObject[]): RouteObject[] {
  return list.map((route) => {
    const element = route.element as ReactElement | undefined;
    const type = element?.type as { name?: string } | string | undefined;
    const keep = element?.type === Navigate || (typeof type === "function" && ["ChatRedirect", "NotFound", "Outlet"].includes((type as { name: string }).name));
    const replaced = route.children ? <Outlet /> : keep ? element : <Landed />;
    return route.children
      ? { ...route, element: replaced, children: probed(route.children) } as RouteObject
      : { ...route, element: replaced } as RouteObject;
  });
}

// `useRoutes` inside a `MemoryRouter` rather than `createMemoryRouter`: a data
// router builds a fetch `Request` with an AbortSignal jsdom's does not satisfy.
function Table() {
  return useRoutes(probed(routes));
}

function landOn(path: string) {
  render(<MemoryRouter initialEntries={[path]}><Table /></MemoryRouter>);
}

describe("every address people already have still arrives", () => {
  it.each([
    ["/", "/app/chat"],
    ["/app", "/app/chat"],
    ["/live", "/app/chat"],
    ["/live/session-42", "/app/chat/session-42"],
    ["/runs", "/app/runs"],
    ["/files", "/app/files"],
    ["/sources", "/app/files?tab=sources"],
    ["/notebooks", "/app/files?tab=notebooks"],
    ["/memory", "/app/memory"],
    ["/agents", "/app/capabilities"],
    ["/settings", "/app/account?tab=settings"],
    ["/app/sources", "/app/files?tab=sources"],
    ["/app/notebooks", "/app/files?tab=notebooks"],
    ["/app/capsules", "/app/memory?tab=capsules"],
    ["/app/settings", "/app/account?tab=settings"],
    ["/app/ops", "/app/account?tab=ops"],
    ["/app/chat/session-7", "/app/chat/session-7"],
    ["/app/inbox", "/app/inbox"],
  ])("%s lands on %s", async (from, to) => {
    landOn(from);
    expect(await screen.findByTestId("landed")).toHaveTextContent(new RegExp(`^${to.replace(/[?]/g, "\\?")}$`));
  });

  it("an address that never existed says so rather than landing somewhere", async () => {
    landOn("/app/no-such-page");
    expect(await screen.findByText("404 · 页面不存在")).toBeInTheDocument();
    expect(screen.queryByTestId("landed")).toBeNull();
  });
});
