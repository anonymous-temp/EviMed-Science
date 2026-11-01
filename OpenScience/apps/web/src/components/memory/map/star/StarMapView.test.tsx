// 「记忆星图」's card around the canvas: the legend, the controls, the list a keyboard walks and the way out when the picture cannot be drawn. The canvas itself needs WebGL and is
// walked in a browser; here it is a stand-in that records what it was told.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapNode } from "@/lib/memoryMapClient";
import { StarMapView } from "./StarMapView";

const stand = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>, explode: false,
  handle: { home: vi.fn(), replay: vi.fn(() => true), stopReplay: vi.fn(), peek: vi.fn() },
}));
vi.mock("./StarCanvas", async () => {
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

function draw(nodes = NODES) {
  const onOpen = vi.fn();
  const onUnavailable = vi.fn();
  render(
    <StarMapView
      layoutDoc={{ nodes, edges: [], truncated: { nodes: 0, edges: 0 } }} narrowed={{ nodes, edges: [], hits: new Set(), narrowed: false }} selected={null}
      actions={{ onOpen, onFocus: vi.fn() }} onUnavailable={onUnavailable}
    />,
  );
  return { onOpen, onUnavailable };
}

beforeEach(() => { stand.props = null; stand.explode = false; vi.clearAllMocks(); stand.handle.replay.mockReturnValue(true); });
afterEach(cleanup);

describe("the star map's card", () => {
  it("says what it holds as a sentence, and names the picture for a screen reader", async () => {
    draw();
    expect(screen.getByRole("heading", { name: "2 件现行的记忆" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /记忆星图：2 件现行的记忆/ })).toBeInTheDocument();
  });

  it("counts each kind in its legend, and a press hides that kind from the picture", async () => {
    draw();
    await screen.findByRole("img", { name: /记忆星图/ });
    const legend = screen.getByRole("group", { name: /图例/ });
    const fact = within(legend).getByRole("button", { name: /项目事实 1/ });
    expect(within(legend).getByRole("button", { name: /纠正 1/ })).toBeInTheDocument();
    await userEvent.click(fact);
    expect(fact).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect([...(stand.props?.hiddenFamilies as Set<string>)]).toEqual(["fact"]));
  });

  it("names only the encodings the picture has", async () => {
    draw([memory("a")]);
    await screen.findByRole("img", { name: /记忆星图/ });
    expect(screen.getByText("越亮越新、越常用到")).toBeInTheDocument();
    expect(screen.queryByText(/灰色连橙线/)).not.toBeInTheDocument();
  });

  it("stops the turning on one press, and goes back to the start on another", async () => {
    draw();
    await screen.findByRole("img", { name: /记忆星图/ });
    await userEvent.click(screen.getByRole("button", { name: "暂停转动" }));
    expect(stand.props?.rotating).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "回正" }));
    expect(stand.handle.home).toHaveBeenCalledOnce();
  });

  it("offers no replay when no mark says when it began", async () => {
    draw([{ id: "you:account", type: "you", label: "你" }, memory("a", { at: null })]);
    await screen.findByRole("img", { name: /记忆星图/ });
    expect(screen.queryByRole("button", { name: "回放成长" })).not.toBeInTheDocument();
  });

  it("lets a keyboard walk the marks, heaviest first, light each on the picture and open it", async () => {
    const { onOpen } = draw();
    await screen.findByRole("img", { name: /记忆星图/ });
    const list = screen.getByRole("listbox", { name: /星图里的记忆/ });
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
