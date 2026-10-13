// 「这条关联不对」: a line pressed on the canvas is read out below it with the one thing the researcher may say about it.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapEdge, MapNode } from "@/lib/memoryMapClient";
import { GraphView } from "./GraphView";
import type { NarrowedMap } from "./mapModel";

// The canvas cannot be painted here: the chart is a button for each thing a press on it can name.
vi.mock("@/components/charts/MapChart", () => ({
  MapChart: ({ on }: { on: Record<string, (params: unknown) => void> }) => (
    <div>
      <button onClick={() => on.click({ dataType: "edge", data: { edgeId: "e_aaaaaaaaaaaaaaaaaaaaaaaa" } })}>压一条线</button>
      <button onClick={() => on.click({ dataType: "edge", data: { edgeId: null } })}>压一条结构线</button>
      <button onClick={() => on.click({ dataType: "node", name: "memory:b", data: { id: "memory:b" } })}>压一个标记</button>
    </div>
  ),
}));

afterEach(cleanup);

const nodes: MapNode[] = [
  { id: "you:account", type: "you", label: "你", state: "current" },
  { id: "memory:b", type: "memory", subtype: "preference", label: "有研究称该药把再入院减半", state: "check", reason: "source-retracted" },
  { id: "document:src_1", type: "document", label: "GOLD 指南", state: "current" },
];
const edges: MapEdge[] = [
  { id: "e_aaaaaaaaaaaaaaaaaaaaaaaa", from: "memory:b", to: "document:src_1", type: "rests-on", state: "retracted" },
  { id: "e_bbbbbbbbbbbbbbbbbbbbbbbb", from: "memory:b", to: "you:account", type: "belongs-to" },
];
const narrowed: NarrowedMap = { nodes, edges, hits: new Set(), narrowed: false };

function view(onHideEdge?: (edge: MapEdge) => Promise<void>) {
  const open = vi.fn();
  render(
    <GraphView doc={{ nodes, edges, truncated: { nodes: 0, edges: 0 } }} narrowed={narrowed} selected={null} actions={{ onOpen: open, onFocus: vi.fn() }}
      chain={null} focused={false} onHideEdge={onHideEdge} />,
  );
  return open;
}

describe("a line pressed on the relation view", () => {
  it("is read out in words with the one thing to say about it, and saying it hides the line", async () => {
    const hide = vi.fn().mockResolvedValue(undefined);
    view(hide);
    await userEvent.click(screen.getByRole("button", { name: "压一条线" }));
    expect(screen.getByRole("status")).toHaveTextContent("有研究称该药把再入院减半 依据 GOLD 指南");
    await userEvent.click(screen.getByRole("button", { name: "这条关联不对" }));
    expect(hide).toHaveBeenCalledWith(edges[0]);
    // Done: the readout goes, because the line is gone from the map.
    await vi.waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("can be let go of without saying anything, and a press on a mark opens the mark and lets go too", async () => {
    const hide = vi.fn();
    const open = view(hide);
    await userEvent.click(screen.getByRole("button", { name: "压一条线" }));
    await userEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "压一条线" }));
    await userEvent.click(screen.getByRole("button", { name: "压一个标记" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(1);
    expect(hide).not.toHaveBeenCalled();
  });

  it("says nothing for a line that is structure, or on a page that cannot keep the word", async () => {
    view(vi.fn());
    await userEvent.click(screen.getByRole("button", { name: "压一条结构线" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    cleanup();
    view(undefined);
    await userEvent.click(screen.getByRole("button", { name: "压一条线" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
