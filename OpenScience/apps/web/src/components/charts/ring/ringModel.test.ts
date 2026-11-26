import { describe, expect, it } from "vitest";
import {
  RING, SEGMENT_GAP, TAU, along, angleOf, angularDistance, cellReach, layoutRing, linkPath, neighbourhood, placeLabels, placeOf, polar, replayStart, ringHit, sparkPath,
  type RingCell, type RingSpec,
} from "./ringModel";

const cell = (id: string, segment: string, order = 0, extra: Partial<RingCell> = {}): RingCell => ({
  id, segment, order, at: order || null, length: 0.5, bright: 0.8, tone: "fact", state: "current", ...extra,
});
const spec = (cells: RingCell[], segments = ["a", "b", "c"], extra: Partial<RingSpec> = {}): RingSpec => ({
  segments: segments.map((id) => ({ id, label: id, tone: "fact" })), cells, clusters: [], links: [], particlesPerCell: 0, centre: { label: "你", tone: "you" }, ...extra,
});
const close = (value: number, target: number) => expect(Math.abs(value - target)).toBeLessThan(1e-9);

describe("angles", () => {
  it("measures clockwise from the top, the short way round", () => {
    close(polar(0, 1)[0], 0); close(polar(0, 1)[1], 1);
    close(polar(Math.PI / 2, 2)[0], 2);
    close(angleOf(1, 0), Math.PI / 2);
    close(angleOf(-1, 0), (3 * Math.PI) / 2);
    close(angularDistance(0.1, TAU - 0.1), 0.2);
  });
});

describe("where a cell stands", () => {
  it("gives each segment its share of the cells and spreads its cells evenly in their order", () => {
    const layout = layoutRing(spec([cell("a2", "a", 2), cell("a1", "a", 1), cell("b1", "b", 1), cell("b2", "b", 2), cell("c1", "c", 1), cell("c2", "c", 2)]));
    const [a, b, c] = layout.segments;
    close(a.a1 - a.a0, b.a1 - b.a0);
    close(b.a1 - b.a0, c.a1 - c.a0);
    close(b.a0 - a.a1, SEGMENT_GAP);
    expect(a.cells).toEqual(["a1", "a2"]);
    expect((layout.angles.get("a1") as number) < (layout.angles.get("a2") as number)).toBe(true);
    // Each cell is in the middle of its slot: the two cells split the segment in four.
    close((layout.angles.get("a1") as number) - a.a0, (a.a1 - a.a0) / 4);
    close(a.a1 - a.a0 + b.a1 - b.a0 + c.a1 - c.a0 + 3 * SEGMENT_GAP, TAU);
  });

  it("keeps a segment with few cells readable: it counts as a third of the average segment at least", () => {
    const many = Array.from({ length: 30 }, (_, i) => cell(`a${i}`, "a", i));
    const layout = layoutRing(spec([...many, cell("b1", "b", 1)], ["a", "b", "c"]));
    const room = TAU - 3 * SEGMENT_GAP;
    const floor = 31 / 3 / 3;
    const [, b, c] = layout.segments;
    close(b.a1 - b.a0, (room * floor) / (30 + 2 * floor));
    // An empty segment still stands as wide, with its arc and its label.
    close(c.a1 - c.a0, b.a1 - b.a0);
    expect(c.cells).toEqual([]);
  });

  it("is the same ring for the same spec, and a new cell only closes up its own segment's neighbours", () => {
    const base = [cell("a1", "a", 1), cell("a2", "a", 2), cell("b1", "b", 1)];
    expect([...layoutRing(spec(base)).angles]).toEqual([...layoutRing(spec(base)).angles]);
    const before = layoutRing(spec(base, ["a", "b"]));
    const after = layoutRing(spec([...base, cell("a3", "a", 3)], ["a", "b"]));
    expect(after.segments[0].cells).toEqual(["a1", "a2", "a3"]);
    expect((after.angles.get("a3") as number) > (after.angles.get("a2") as number)).toBe(true);
    expect(before.segments[0].cells).toEqual(["a1", "a2"]);
  });

  it("stands one segment alone round the whole ring, with its cloud at the centre", () => {
    const layout = layoutRing(spec([cell("x", "a", 1)], ["a"]));
    close(layout.segments[0].a1 - layout.segments[0].a0, TAU);
    expect(layout.segments[0].anchor).toEqual([0, 0]);
  });

  it("stands clusters at their segment's cloud, a crowd side by side, and those of no segment round the centre, never on it", () => {
    const layout = layoutRing(spec([cell("a1", "a", 1)], ["a", "b"], {
      clusters: [{ id: "m1", segment: "a", tone: "fact", mass: 10 }, { id: "m2", segment: "a", tone: "fact", mass: 10 }, { id: "root", segment: null, tone: "you", mass: 10 }],
    }));
    expect(layout.clusters.get("m1")).toEqual(layout.segments[0].anchor);
    expect(layout.clusters.get("m2")).not.toEqual(layout.clusters.get("m1"));
    const [rx, ry] = layout.clusters.get("root") as readonly [number, number];
    close(Math.hypot(rx, ry), 0.24);
  });
});

describe("the lines", () => {
  const layout = layoutRing(spec([cell("a1", "a", 1), cell("a2", "a", 2), cell("b1", "b", 1)]));

  it("runs from one cell's foot to the other's", () => {
    const path = linkPath(layout, "a1", "b1") as Array<readonly [number, number]>;
    expect(path).toHaveLength(29);
    expect(path[0]).toEqual(placeOf(layout, "a1"));
    expect(path.at(-1)).toEqual(placeOf(layout, "b1"));
    close(Math.hypot(...path[0]), RING.foot);
  });

  it("bends a line between two segments in past the centre, and one inside a segment only gently", () => {
    const across = linkPath(layout, "a1", "b1") as Array<readonly [number, number]>;
    const inside = linkPath(layout, "a1", "a2") as Array<readonly [number, number]>;
    const nearest = (path: Array<readonly [number, number]>) => Math.min(...path.map(([x, y]) => Math.hypot(x, y)));
    expect(nearest(across)).toBeLessThan(0.5);
    expect(nearest(inside)).toBeGreaterThan(0.5);
  });

  it("has no line to what the picture does not hold", () => {
    expect(linkPath(layout, "a1", "gone")).toBeNull();
  });

  it("flies a spark from the centre to the cell's foot", () => {
    const flight = sparkPath(layout, "b1") as Array<readonly [number, number]>;
    expect(flight[0]).toEqual([0, 0]);
    expect(flight.at(-1)).toEqual(placeOf(layout, "b1"));
    expect(sparkPath(layout, "gone")).toBeNull();
  });

  it("finds a place along a curve, clamped to its ends", () => {
    const points = [[0, 0], [1, 0], [1, 1]] as const;
    expect(along(points, 0.25)).toEqual([0.5, 0]);
    expect(along(points, 2)).toEqual([1, 1]);
    expect(along([], 0.5)).toEqual([0, 0]);
  });
});

describe("what the pointer is on", () => {
  const layout = layoutRing(spec([cell("a1", "a", 1), cell("a2", "a", 2), cell("b1", "b", 1)], ["a", "b"], {
    clusters: [{ id: "member", segment: "b", tone: "fact", mass: 10 }],
  }));
  const slop = 0.05;

  it("takes the nearest cell on the cells' band, its segment just beyond it, and nothing outside the labels", () => {
    const [x, y] = polar(layout.angles.get("a2") as number, RING.cell + 0.05);
    expect(ringHit(layout, x, y, slop)).toEqual({ kind: "cell", id: "a2" });
    const [sx, sy] = polar(layout.angles.get("a2") as number, RING.cell + RING.cellLong + 0.06);
    expect(ringHit(layout, sx, sy, slop)).toEqual({ kind: "segment", id: "a" });
    const [gx, gy] = polar(layout.angles.get("a2") as number, RING.label + 0.3);
    expect(ringHit(layout, gx, gy, slop)).toBeNull();
  });

  it("takes a lone cell only near its bar, never from the far side of the ring", () => {
    const lone = layoutRing(spec([cell("a", "a", 1)], ["a"]));
    const [x, y] = polar(lone.angles.get("a") as number, RING.cell + 0.05);
    expect(ringHit(lone, x, y, 14 / 200)).toEqual({ kind: "cell", id: "a" });
    const [ox, oy] = polar((lone.angles.get("a") as number) + Math.PI, 1.1);
    expect(ringHit(lone, ox, oy, 14 / 200)).toBeNull();
  });

  it("does not take a cell the view hides", () => {
    const [x, y] = polar(layout.angles.get("a2") as number, RING.cell + 0.05);
    expect(ringHit(layout, x, y, slop, new Set(["a1", "b1"]))).not.toEqual({ kind: "cell", id: "a2" });
  });

  it("takes a segment on its arc and label, a cluster under the pointer, and the centre", () => {
    const [x, y] = polar(layout.segments[1].mid, RING.label);
    expect(ringHit(layout, x, y, slop)).toEqual({ kind: "segment", id: "b" });
    const [mx, my] = layout.clusters.get("member") as readonly [number, number];
    expect(ringHit(layout, mx + 0.01, my, slop)).toEqual({ kind: "cluster", id: "member" });
    expect(ringHit(layout, 0, 0.02, slop)).toEqual({ kind: "centre" });
  });

  it("names what a hit is tied to: a segment's cells, a cell's links", () => {
    const linked = spec([cell("a1", "a", 1), cell("b1", "b", 1)], ["a", "b"], { links: [{ id: "l", from: "a1", to: "b1", tone: "line-relates", strength: 0.3, flow: true }] });
    const placed = layoutRing(linked);
    expect([...(neighbourhood(linked, placed, { kind: "cell", id: "a1" }) as Set<string>)].sort()).toEqual(["a1", "b1"]);
    expect([...(neighbourhood(linked, placed, { kind: "segment", id: "a" }) as Set<string>)]).toEqual(["a1"]);
    expect(neighbourhood(linked, placed, { kind: "centre" })).toBeNull();
  });
});

describe("the labels", () => {
  it("stands a label alone at its segment's middle, with its code", () => {
    const [alone] = placeLabels([{ id: "a", mid: 0, width: 0.3, height: 0.1, short: 0.2 }]);
    expect(alone).toMatchObject({ id: "a", shown: true, full: true });
    close(alone.y, RING.label);
  });

  it("steps a crowding label outwards before anything else", () => {
    const [, b] = placeLabels([{ id: "a", mid: 0, width: 0.8, height: 0.12, short: 0.8 }, { id: "b", mid: 0.25, width: 0.8, height: 0.12, short: 0.8 }]);
    expect(b).toMatchObject({ shown: true, full: true });
    expect(Math.hypot(b.x, b.y)).toBeGreaterThan(RING.label + 0.1);
  });

  it("drops a label's code when stepping out is not enough, and gives a label up rather than overlap", () => {
    const placed = placeLabels([
      { id: "a", mid: 0, width: 1.2, height: 0.5, short: 1.2 },
      { id: "b", mid: 0.4, width: 0.8, height: 0.5, short: 0.1 },
      { id: "c", mid: 0.01, width: 1.2, height: 0.5, short: 1.2 },
    ]);
    expect(placed.find((label) => label.id === "b")).toMatchObject({ shown: true, full: false });
    expect(placed.find((label) => label.id === "c")).toMatchObject({ shown: false });
  });
});

describe("lengths and the replay", () => {
  it("keeps a cell's reach between the shortest and the longest", () => {
    expect(cellReach(-1)).toBe(RING.cellShort);
    expect(cellReach(2)).toBe(RING.cellLong);
  });

  it("starts at the earliest cell that says when it began, and has nothing to play without one", () => {
    expect(replayStart([{ at: 5 }, { at: 2 }, { at: null }])).toBe(2);
    expect(replayStart([{ at: null }])).toBeNull();
  });
});
