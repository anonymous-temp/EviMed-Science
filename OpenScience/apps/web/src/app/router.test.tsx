import { render, screen } from "@testing-library/react";
import { MemoryRouter, Navigate, Outlet, useLocation, useRoutes, type RouteObject } from "react-router";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

// The shell's auth gate and the lazily loaded pages are not what this is
// about; what is, is where every address people have bookmarked ends up
// (2026-09-16 review, D5).
vi.mock("./layout/AppShell", () => ({ AppShell: () => <Outlet /> }));

// `/app/runs?run=<id>` is resolved through the ledger, which is a request; the
// lookup is stubbed so this file stays about addresses.
const findRunSession = vi.fn<(runId: string) => Promise<string | null>>();
vi.mock("@/lib/runLocation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runLocation")>()),
  findRunSession: (runId: string) => findRunSession(runId),
}));

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
    const keep = element?.type === Navigate || (typeof type === "function" && ["ChatRedirect", "RunRedirect", "NotFound", "Outlet"].includes((type as { name: string }).name));
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
    // The run ledger page was deleted on 2026-09-20; its addresses resolve to
    // the conversation the run happened in, or to the surface itself.
    ["/runs", "/app/chat"],
    ["/app/runs", "/app/chat"],
    ["/files", "/app/files"],
    ["/sources", "/app/files?tab=sources"],
    // The computational notebook was deleted on 2026-09-19; its addresses
    // land on the files it sat beside.
    ["/notebooks", "/app/files"],
    ["/memory", "/app/memory"],
    ["/agents", "/app/capabilities"],
    ["/settings", "/app/account?tab=settings"],
    ["/app/sources", "/app/files?tab=sources"],
    ["/app/notebooks", "/app/files"],
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
    expect(await screen.findByText("页面不存在")).toBeInTheDocument();
    expect(screen.queryByTestId("landed")).toBeNull();
  });

  // What a Feishu card, a pushed notice and an old bookmark carry is a run id.
  it("opens a link that names a run in the conversation that run happened in", async () => {
    findRunSession.mockResolvedValue("ses_7");
    landOn("/app/runs?run=run_1");
    expect(await screen.findByTestId("landed")).toHaveTextContent("/app/chat/ses_7");
    expect(findRunSession).toHaveBeenCalledWith("run_1");
  });

  it("lands a run nothing can be found for on the conversation surface", async () => {
    findRunSession.mockResolvedValue(null);
    landOn("/app/runs?run=run_gone");
    expect(await screen.findByTestId("landed")).toHaveTextContent(/^\/app\/chat$/);
  });
});
