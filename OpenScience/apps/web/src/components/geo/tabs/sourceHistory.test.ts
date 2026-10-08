import { describe, expect, it } from "vitest";
import type { GeoSourceHistoryPoint } from "@/lib/geoClient";
import { sourceHistoryModel } from "./sourceHistory";

const three = "v1|P1,P2|deepseek,doubao,kimi|web";
const two = "v1|P1,P2|deepseek,kimi|web";
const point = (day: string, cited: number, wrongOurs: number, coverage: string | null): GeoSourceHistoryPoint =>
  ({ roundId: `r_${day}`, kind: "weekly", sampleDate: `2026-09-${day}`, coverage, cited, wrongOurs, mentionsOurs: 0 });

describe("a source's counts across rounds", () => {
  it("compares the latest round with the one before it when they were measured over the same thing", () => {
    const model = sourceHistoryModel([point("07", 12, 1, three), point("14", 14, 2, three), point("21", 20, 2, three)]);
    expect(model?.columns.map((column) => [column.label, column.cited, column.wrongOurs, column.breakBefore])).toEqual([
      ["9月7日", 12, 1, false], ["9月14日", 14, 2, false], ["9月21日", 20, 2, false],
    ]);
    expect(model?.broken).toBe(false);
    expect(model?.sentence).toBe("较上一轮（9月14日）：被引用多 6 个，讲错的回答持平");
  });

  it("marks the column where the engine set changed and does not compare across it: a sentence, no number of change", () => {
    const model = sourceHistoryModel([point("07", 12, 1, two), point("14", 14, 2, two), point("21", 30, 5, three)]);
    expect(model?.columns.map((column) => column.breakBefore)).toEqual([false, false, true]);
    expect(model?.broken).toBe(true);
    expect(model?.sentence).toBe("引擎范围有变化，不与上一轮比较");
    expect(model?.sentence).not.toMatch(/多|少|持平/);
  });

  it("goes back to comparing once two rounds after the change share a coverage", () => {
    const model = sourceHistoryModel([point("07", 12, 1, two), point("14", 30, 5, three), point("21", 28, 3, three)]);
    expect(model?.columns.map((column) => column.breakBefore)).toEqual([false, true, false]);
    expect(model?.sentence).toBe("较上一轮（9月14日）：被引用少 2 个，讲错的回答少 2 个");
  });

  it("says a round whose coverage was not recorded is not compared, differently from a change", () => {
    const model = sourceHistoryModel([point("07", 12, 1, null), point("14", 14, 1, two)]);
    expect(model?.columns[1].breakBefore).toBe(true);
    expect(model?.sentence).toBe("测量范围没有记录，不与上一轮比较");
  });

  it("is nothing before there are two rounds, or for a site no round cited", () => {
    expect(sourceHistoryModel(undefined)).toBeNull();
    expect(sourceHistoryModel([point("07", 3, 0, two)])).toBeNull();
    expect(sourceHistoryModel([point("07", 0, 0, two), point("14", 0, 0, two)])).toBeNull();
  });
});
