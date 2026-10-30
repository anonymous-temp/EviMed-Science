import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTION, parseSelection, selectionParams } from "./useOverviewSelection";

describe("what the reader chose on 总览, kept in the address", () => {
  it("is the plain page for the plain address, and writes nothing that is at its default", () => {
    expect(parseSelection(new URLSearchParams(""))).toEqual(DEFAULT_SELECTION);
    expect(selectionParams(DEFAULT_SELECTION).toString()).toBe("");
  });

  it("reads each choice and writes it back, in one order", () => {
    const params = new URLSearchParams("q=%E7%96%B3&range=90d&look=1&explore=topics&topic=t1&week=2026-10-05&project=prj_1");
    const selection = parseSelection(params);
    expect(selection).toEqual({ range: "90d", look: true, project: "prj_1", topic: "t1", week: "2026-10-05", explore: "topics", q: "疳" });
    expect(selectionParams(selection).toString()).toBe("range=90d&look=1&project=prj_1&topic=t1&week=2026-10-05&explore=topics&q=%E7%96%B3");
  });

  it("ignores what it does not know: a range that is not offered, a week that is not a day, a panel that is not one", () => {
    expect(parseSelection(new URLSearchParams("range=1y&week=last&explore=dims&look=0"))).toEqual(DEFAULT_SELECTION);
  });

  it("keeps the parameters it does not own, the open drawer first of them", () => {
    expect(selectionParams({ ...DEFAULT_SELECTION, range: "30d" }, new URLSearchParams("open=record%3Aa&tab=x")).toString()).toBe("open=record%3Aa&tab=x&range=30d");
    expect(selectionParams(DEFAULT_SELECTION, new URLSearchParams("range=30d&open=record%3Aa")).toString()).toBe("open=record%3Aa");
  });
});
