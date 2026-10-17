import { describe, expect, it } from "vitest";
import type { GeoGroupReading } from "@/lib/geoClient";
import { clusterRow } from "../__fixtures__/geoSpine";
import {
  answerStance,
  clusterName,
  countText,
  effectMarkers,
  engineStance,
  groupsByStage,
  groupTally,
  mentionText,
  questionGroupIndex,
  readingText,
  stageOf,
} from "./clusterModel";

describe("a reading is said in counts, and a rate only where the server sent one", () => {
  it("never makes a percentage of a thin or absent reading, whatever its numbers", () => {
    const thin: GeoGroupReading = { k: 11, n: 12, state: "thin" };
    expect(readingText(thin)).toEqual({ state: "thin", counts: "11/12", rate: null, sample: "样本不足" });
    expect(readingText({ k: null, n: null, state: "absent" })).toEqual({ state: "absent", counts: "—", rate: null, sample: null });
    expect(readingText({ k: 21, n: 36, state: "enough", rate: 58.33 })).toEqual({ state: "enough", counts: "21/36", rate: "58%", sample: null });
    // a "thin" object that smuggles a rate in is still not read as one
    expect(readingText({ k: 3, n: 4, state: "thin", rate: 75 } as unknown as GeoGroupReading).rate).toBeNull();
  });

  it("counts the answers when the platform has no reading of the group, and still prints no rate for them", () => {
    const row = clusterRow({ id: "g", name: "P1-01 品牌", mention: null, byEngine: { doubao: { answered: 40, mentioned: 30, wrong: 0 }, kimi: { answered: 12, mentioned: 6, wrong: 1 } } });
    // 52 answers is over the floor, and the count is still a count: a rate is the server's to send
    expect(mentionText(row)).toEqual({ state: "enough", counts: "36/52", rate: null, sample: null });
    expect(mentionText(row, ["kimi"])).toEqual({ state: "thin", counts: "6/12", rate: null, sample: "样本不足" });
    expect(groupTally(row)).toEqual({ answered: 52, mentioned: 36, wrong: 1 });
    expect(countText(1234, 5678)).toBe("1,234/5,678");
  });

  it("an engine is all, some, none or not asked", () => {
    expect(engineStance({ answered: 4, mentioned: 4, wrong: 0 })).toBe("all");
    expect(engineStance({ answered: 4, mentioned: 1, wrong: 0 })).toBe("some");
    expect(engineStance({ answered: 4, mentioned: 0, wrong: 0 })).toBe("none");
    expect(engineStance(null)).toBe("unmeasured");
    expect(answerStance({ engine: "doubao", snapshotId: "s", status: "valid", askedAt: "", mentionsOurs: true, wrongOurs: true, citesOurs: false })).toBe("wrong");
    expect(answerStance(null)).toBe("unmeasured");
  });
});

describe("names and stages", () => {
  it("strips the method's number from a group's name, and names an unnamed one", () => {
    expect(clusterName({ name: "P2-04 效果怎么样" })).toBe("效果怎么样");
    expect(clusterName({ name: "" })).toBe("未命名问题群");
  });

  it("orders the stages by number, then by their words as they come, 「未标阶段」 last", () => {
    const rows = [
      clusterRow({ id: "a", name: "A", journeyStage: "用药启动", journeyStageNo: 3 }),
      clusterRow({ id: "b", name: "B", journeyStage: "认知", journeyStageNo: 1 }),
      clusterRow({ id: "c", name: "C", journeyStage: "旧阶段", journeyStageNo: null }),
      clusterRow({ id: "d", name: "D", journeyStage: null, journeyStageNo: null }),
      clusterRow({ id: "e", name: "E", journeyStage: "另一旧阶段", journeyStageNo: null }),
    ];
    expect(groupsByStage(rows).map((stage) => [stage.key, stage.groups.map((group) => group.id)])).toEqual([
      ["no:1", ["b"]], ["no:3", ["a"]], ["name:旧阶段", ["c"]], ["name:另一旧阶段", ["e"]], ["name:未标阶段", ["d"]],
    ]);
  });

  it("puts a group with the words of a numbered stage in that stage: one stage is one card", () => {
    const rows = [
      clusterRow({ id: "a", name: "A", journeyStage: "就诊与方案初选", journeyStageNo: 2 }),
      clusterRow({ id: "b", name: "B", journeyStage: "就诊与方案初选", journeyStageNo: null }),
      clusterRow({ id: "c", name: "C", journeyStage: "用药启动", journeyStageNo: null }),
      clusterRow({ id: "d", name: "D", journeyStage: "用药启动", journeyStageNo: 3 }),
    ];
    const stages = groupsByStage(rows);
    expect(stages.map((stage) => [stage.no, stage.name, stage.groups.map((group) => group.id)])).toEqual([[2, "就诊与方案初选", ["a", "b"]], [3, "用药启动", ["c", "d"]]]);
    expect(stageOf({ journeyStage: " ", journeyStageNo: null })).toEqual({ no: null, name: "未标阶段" });
  });

  it("finds the group a question belongs to, from the question set", () => {
    const index = questionGroupIndex([{ id: "g1", name: "一", isControl: true, questions: [{ id: "q1" }, { id: "q2" }] }, { id: "g2", name: "二", questions: [{ id: "q3" }] }]);
    expect(index.get("q2")).toEqual({ id: "g1", name: "一", isControl: true });
    expect(index.get("q3")).toEqual({ id: "g2", name: "二", isControl: false });
    expect(questionGroupIndex(null).size).toBe(0);
  });
});

describe("what happened to a group is placed on the rounds it fell between", () => {
  const dates = ["2026-10-05", "2026-10-12", "2026-10-19"];

  it("puts each kind's first event on the first round measured on or after its day, two on one round sharing its mark", () => {
    const marks = effectMarkers(dates, [
      { kind: "published", at: "2026-10-12T02:00:00.000Z" },
      { kind: "article", at: "2026-10-11T02:00:00.000Z" },
      { kind: "cited", at: "2026-10-13T02:00:00.000Z", engine: "qianwen" },
      { kind: "cited", at: "2026-10-18T02:00:00.000Z", engine: "doubao" },
    ]);
    expect(marks).toEqual([{ index: 1, label: "稿件写成·稿件发布" }, { index: 2, label: "首次被引用" }]);
  });

  it("draws no mark when no round has a day", () => {
    expect(effectMarkers([null, null], [{ kind: "published", at: "2026-10-12T02:00:00.000Z" }])).toEqual([]);
    expect(effectMarkers(dates, [])).toEqual([]);
  });
});
