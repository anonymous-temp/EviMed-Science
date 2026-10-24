import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTION, parseSelection, patchSelection, selectionParams } from "./useMapSelection";

const parse = (query: string) => parseSelection(new URLSearchParams(query));

describe("the selection the five views share", () => {
  it("is the plain page at the plain address", () => {
    expect(parse("")).toEqual(DEFAULT_SELECTION);
    expect(selectionParams(DEFAULT_SELECTION).toString()).toBe("");
  });

  it("round-trips every choice through the address", () => {
    const chosen = {
      view: "time" as const, project: "prj_a", range: "2026-07-14..2026-07-20", topic: "topic:abc", kind: "decision", dimension: "aspect:habit",
      focus: "memory:rec_1", depth: 2 as const, chain: true, look: true, part: "knowledge" as const, q: "剂量",
    };
    const written = selectionParams(chosen);
    expect(parseSelection(written)).toEqual(chosen);
    // The address reads as the parameters the spec names.
    expect([...written.keys()].sort()).toEqual(["chain", "depth", "dimension", "focus", "kind", "look", "part", "project", "q", "range", "topic", "view"]);
  });

  it("refuses what it does not know: an unknown view, a range that is not the server's grammar, a focus that is no mark", () => {
    expect(parse("view=galaxy").view).toBe("graph");
    expect(parse("range=forever").range).toBe("all");
    expect(parse("range=2026-07-14").range).toBe("all");
    expect(parse("focus=nonsense").focus).toBeNull();
    // A part is one of the four the overview's cards drill into; the time view and the received packs are not parts.
    expect(parse("part=you").part).toBe("you");
    expect(parse("part=growth").part).toBeNull();
    expect(parse("part=received").part).toBeNull();
    expect(parse("depth=9").depth).toBe(1);
    expect(parse(`q=${"x".repeat(200)}`).q).toHaveLength(80);
  });

  it("keeps the parameters it does not own, such as the drawer's", () => {
    const base = new URLSearchParams("open=record:rec_1&view=activity");
    const next = selectionParams({ ...DEFAULT_SELECTION, view: "dims", kind: "decision" }, base);
    expect(next.get("open")).toBe("record:rec_1");
    expect(next.get("view")).toBe("dims");
    expect(next.get("kind")).toBe("decision");
  });

  it("drops a depth and a chain that belong to a focus when there is none, or another", () => {
    const focused = patchSelection(DEFAULT_SELECTION, { focus: "memory:a", depth: 2, chain: true });
    expect(focused).toMatchObject({ focus: "memory:a", depth: 2, chain: true });
    expect(patchSelection(focused, { focus: "memory:b" })).toMatchObject({ focus: "memory:b", depth: 1, chain: false });
    expect(patchSelection(focused, { focus: null })).toMatchObject({ focus: null, depth: 1, chain: false });
    expect(selectionParams(patchSelection(DEFAULT_SELECTION, { depth: 2 })).toString()).toBe("");
  });
});
