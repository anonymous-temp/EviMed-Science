// 「记忆星环」's card around the canvas: the legend, the controls, the list a keyboard walks and the way out when the picture cannot be drawn. The canvas itself needs WebGL and is
// walked in a browser; here it is a stand-in that records what it was told.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapEvent, MapNode } from "@/lib/memoryMapClient";
import { StarMapView } from "./StarMapView";

const stand = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>, explode: false,
  handle: { replay: vi.fn(() => true), stopReplay: vi.fn(), peek: vi.fn(), pulse: vi.fn() },
}));
vi.mock("@/components/charts/ring/RingCanvas", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  function StandIn(props: Record<string, unknown> & { handle: React.Ref<unknown> }) {
    if (stand.explode) throw new Error("no chunk");
    stand.props = props;
    React.useImperativeHandle(props.handle, () => stand.handle, []);
    return React.createElement("div", { role: "img", "aria-label": String(props.label) });
  }
  return { default: StandIn };
});

const memory = (id: string, extra: Partial<MapNode> = {}): MapNode => ({ id: `memory:${id}`, type: "memory", subtype: "project_fact", label: `记忆 ${id}`, weight: 0.5, at: "2026-10-01T00:00:00.000Z", state: "current", freshness: 0.8, open: { kind: "record", id }, ...extra });
const NODES: MapNode[] = [{ id: "you:account", type: "you", label: "你" }, memory("a"), memory("b", { subtype: "correction", weight: 0.9 }), memory("c", { state: "replaced" })];

function card(nodes: MapNode[], events: MapEvent[], onOpen: ReturnType<typeof vi.fn>, onUnavailable: ReturnType<typeof vi.fn>) {
  return (
    <StarMapView
      layoutDoc={{ nodes, edges: [], truncated: { nodes: 0, edges: 0 }, events }} narrowed={{ nodes, edges: [], hits: new Set(), narrowed: false }} selected={null}
      actions={{ onOpen, onFocus: vi.fn() }} onUnavailable={onUnavailable}
    />
  );
}

function draw(nodes = NODES, events: MapEvent[] = []) {
  const onOpen = vi.fn();
  const onUnavailable = vi.fn();
  const view = render(card(nodes, events, onOpen, onUnavailable));
  return { onOpen, onUnavailable, rerender: (next: MapNode[], nextEvents: MapEvent[]) => view.rerender(card(next, nextEvents, onOpen, onUnavailable)) };
}

beforeEach(() => { stand.props = null; stand.explode = false; vi.clearAllMocks(); stand.handle.replay.mockReturnValue(true); });
afterEach(cleanup);

describe("the memory ring's card", () => {
  it("says what it holds as a sentence, and names the picture for a screen reader", async () => {
    draw();
    expect(screen.getByRole("heading", { name: "2 件现行的记忆" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /记忆星环：2 件现行的记忆/ })).toBeInTheDocument();
  });

  it("counts each kind in its legend, and a press hides that kind from the picture", async () => {
    draw();
    await screen.findByRole("img", { name: /记忆星环/ });
    const legend = screen.getByRole("group", { name: /图例/ });
    const fact = within(legend).getByRole("button", { name: /项目事实 1/ });
    expect(within(legend).getByRole("button", { name: /纠正 1/ })).toBeInTheDocument();
    await userEvent.click(fact);
    expect(fact).toHaveAttribute("aria-pressed", "false");
    // The replaced statement is of the same kind, so it goes with it.
    await waitFor(() => expect([...((stand.props?.view as { shown: Set<string> }).shown)].sort()).toEqual(["memory:b"]));
  });

  it("names only the encodings the picture has", async () => {
    draw([memory("a")]);
    await screen.findByRole("img", { name: /记忆星环/ });
    expect(screen.getByText("一格一条，越亮越新、越常用到")).toBeInTheDocument();
    expect(screen.queryByText(/已被替代/)).not.toBeInTheDocument();
  });

  it("stops every motion on one press, and starts it again on another", async () => {
    draw();
    await screen.findByRole("img", { name: /记忆星环/ });
    await userEvent.click(screen.getByRole("button", { name: "暂停流动" }));
    expect(stand.props?.moving).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "继续流动" }));
    expect(stand.props?.moving).toBe(true);
  });

  it("segments the ring by kind, and by project on a press, each memory keeping its kind's colour", async () => {
    draw();
    await screen.findByRole("img", { name: /记忆星环/ });
    const ids = () => (stand.props?.spec as { segments: Array<{ id: string }> }).segments.map((segment) => segment.id);
    expect(ids()).toEqual(["correction", "fact"]);
    await userEvent.click(screen.getByRole("button", { name: "按项目分段" }));
    expect(ids()).toEqual(["project:none"]);
    expect((stand.props?.spec as { cells: Array<{ tone: string }> }).cells.map((cell) => cell.tone).sort()).toEqual(["correction", "fact", "fact"]);
    expect(screen.getByRole("button", { name: "按类型分段" })).toHaveAttribute("aria-pressed", "true");
  });

  it("sends a spark to a memory written or recalled after the page opened, and none for what was there", async () => {
    const { rerender } = draw(NODES, [{ id: "e1", at: "2026-10-01T00:00:00.000Z", type: "memory", change: "created", ref: "memory:a" }]);
    await screen.findByRole("img", { name: /记忆星环/ });
    expect(stand.handle.pulse).not.toHaveBeenCalled();
    rerender(
      NODES.map((node) => (node.id === "memory:b" ? { ...node, recalledAt: "2026-11-26T10:00:00.000Z" } : node)),
      [{ id: "e1", at: "2026-10-01T00:00:00.000Z", type: "memory", change: "created", ref: "memory:a" }, { id: "e2", at: "2026-11-26T10:00:00.000Z", type: "memory", change: "updated", ref: "memory:a" }],
    );
    await waitFor(() => expect(stand.handle.pulse.mock.calls.map((call) => call[0]).sort()).toEqual(["memory:a", "memory:b"]));
  });

  it("offers no replay when no mark says when it began", async () => {
    draw([{ id: "you:account", type: "you", label: "你" }, memory("a", { at: null })]);
    await screen.findByRole("img", { name: /记忆星环/ });
    expect(screen.queryByRole("button", { name: "回放成长" })).not.toBeInTheDocument();
  });

  it("lets a keyboard walk the marks, heaviest first, light each on the picture and open it", async () => {
    const { onOpen } = draw();
    await screen.findByRole("img", { name: /记忆星环/ });
    const list = screen.getByRole("listbox", { name: /星环里的记忆/ });
    expect(within(list).queryByRole("option", { name: /你/ })).not.toBeInTheDocument();
    list.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(stand.handle.peek).toHaveBeenLastCalledWith("memory:b");
    expect(list).toHaveAttribute("aria-activedescendant", "star-mark-memory:b");
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "memory:b" }));
    await userEvent.keyboard("{Escape}");
    expect(stand.handle.peek).toHaveBeenLastCalledWith(null);
  });

  it("goes to the flat pictures when the picture cannot load", async () => {
    stand.explode = true;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { onUnavailable } = draw();
    await waitFor(() => expect(onUnavailable).toHaveBeenCalled());
    quiet.mockRestore();
  });
});


it("people and notes keep separate legend labels and open their own record from the keyboard", async () => {
  const person = memory("person-a", { subtype: "person", label: "人物甲", weight: 0.9 });
  const note = memory("note-a", { subtype: "note", label: "其他记忆甲" });
  const { onOpen } = draw([person, note]);
  await screen.findByRole("img", { name: /记忆星环/ });
  const legend=screen.getByRole("group",{name:/图例/});
  expect(within(legend).getByRole("button",{name:/人物 1/})).toBeInTheDocument();
  expect(within(legend).getByRole("button",{name:/其他记忆 1/})).toBeInTheDocument();
  screen.getByRole("listbox",{name:/星环里的记忆/}).focus();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({subtype:"person",open:{kind:"record",id:"person-a"}}));
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({subtype:"note",open:{kind:"record",id:"note-a"}}));
});
