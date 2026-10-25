import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pendingFrontierEvents, resetFrontierTracking, useFrontierListTracking } from "@/lib/frontierTracking";
import { FrontierLinkedItem } from "./FrontierLinkedItem";
import { frontierItem } from "./__fixtures__/frontierItems";

const client = vi.hoisted(() => ({ fetchFrontierItem: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  ...client,
}));

/** What FrontierPage does around the card: the page's list tracking is mounted over it. */
function Page({ id }: { id: string }) {
  const root = useRef<HTMLDivElement>(null);
  useFrontierListTracking(root, [id]);
  return <div ref={root}><FrontierLinkedItem id={id} onClose={() => undefined} /></div>;
}

function renderLinked(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/frontier${search}`]}>
      <Routes>
        <Route path="/app/frontier" element={<Page id="a1b2c3d4e5f60718" />} />
        <Route path="*" element={<div>reading page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetFrontierTracking();
  client.fetchFrontierItem.mockReset().mockResolvedValue(frontierItem({ id: "a1b2c3d4e5f60718", title: "指定安全公告" }));
});
afterEach(() => resetFrontierTracking());

describe("a notification's linked item (G12, 2026-10-25)", () => {
  it("is the open of a `push` arrival when the link carried the marker: the card opens the reading page as push, with no list", async () => {
    renderLinked("?item=a1b2c3d4e5f60718&from=push");
    const link = await screen.findByRole("link", { name: /指定安全公告/ });
    expect(link.closest("ul")).toHaveAttribute("data-frontier-list", "push");
    await userEvent.click(link);
    expect(pendingFrontierEvents().filter((event) => event.type === "open").map((event) => [event.item, event.surface, event.list, event.slot]))
      .toEqual([["a1b2c3d4e5f60718", "push", null, null]]);
  });

  it("is no list at all without the marker: an address typed or shared by hand reads as direct on the reading page", async () => {
    renderLinked("?item=a1b2c3d4e5f60718");
    const link = await screen.findByRole("link", { name: /指定安全公告/ });
    expect(link.closest("ul")).not.toHaveAttribute("data-frontier-list");
    await userEvent.click(link);
    expect(pendingFrontierEvents().filter((event) => event.type === "open")).toEqual([]);
  });
});
