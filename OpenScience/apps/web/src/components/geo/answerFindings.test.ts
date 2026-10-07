import { describe, expect, it } from "vitest";
import type { GeoAnswer, GeoErrorRow } from "@/lib/geoClient";
import { answerFilled } from "./__fixtures__/geoTabs";
import { answerFindings } from "./answerFindings";

const answer = (overrides: Partial<Pick<GeoAnswer, "facts" | "errors">> & { answerText?: string; id?: string } = {}) => ({
  snapshot: { ...answerFilled.snapshot, id: overrides.id ?? "snap_now", answerText: overrides.answerText ?? "它需要每天注射一次。起始剂量较低。" },
  facts: overrides.facts ?? answerFilled.facts,
  errors: overrides.errors ?? [],
});
const error = (patch: Partial<GeoErrorRow> = {}): GeoErrorRow => ({
  ...answerFilled.errors[0], id: "err_1", statement: "它需要每天注射一次", claimId: "clm_1", firstSnapshotId: "snap_now", snapshotId: "snap_now", ...patch,
});

describe("what is wrong in an answer", () => {
  it("is the judge's sentences of this answer, each with the row that carries its source and handling", () => {
    const { findings, elsewhere } = answerFindings(answer({ errors: [error()] }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ sentence: "它需要每天注射一次", error: { id: "err_1" } });
    expect(findings[0].statement?.claimId).toBe("clm_1");
    expect(elsewhere).toEqual([]);
  });

  it("does not put a sentence into the answer that the answer never said — the live case", () => {
    // The row's statement is the first sentence the claim was seen as, in an older answer; this answer says it in other words.
    const stale = error({ id: "err_stale", statement: "禁忌/慎用：个人或家族有甲状腺髓样癌", claimId: "clm_1", firstSnapshotId: "snap_old", snapshotId: "snap_now" });
    const { findings, elsewhere } = answerFindings(answer({ errors: [stale] }));
    // The finding is the sentence of THIS answer (from its facts); the older row speaks for the same claim and is not shown twice.
    expect(findings.map((finding) => finding.sentence)).toEqual(["它需要每天注射一次"]);
    expect(findings[0].error?.id).toBe("err_stale");
    expect(elsewhere).toEqual([]);
  });

  it("keeps a row of another claim apart, as a record of an earlier answer", () => {
    const earlier = error({ id: "err_old", statement: "孕妇可以放心使用", claimId: "clm_9", firstSnapshotId: "snap_old", snapshotId: "snap_old" });
    const { findings, elsewhere } = answerFindings(answer({ errors: [error(), earlier] }));
    expect(findings).toHaveLength(1);
    expect(elsewhere.map((row) => row.id)).toEqual(["err_old"]);
  });

  it("is one correction for a claim with two sources, the one first seen here and the gravest speaking for it", () => {
    const first = error({ id: "err_a", severity: "S2", firstSnapshotId: "snap_old" });
    const second = error({ id: "err_b", severity: "S2", firstSnapshotId: "snap_now" });
    const gravest = error({ id: "err_c", severity: "S4", firstSnapshotId: "snap_old" });
    const found = answerFindings(answer({ errors: [first, gravest, second] }));
    expect(found.findings).toHaveLength(1);
    expect(found.findings[0].error?.id).toBe("err_b");
    expect(found.elsewhere).toEqual([]);
    expect(answerFindings(answer({ errors: [first, gravest] })).findings[0].error?.id).toBe("err_c");
  });

  it("marks a row's sentence that stands in the text word for word even when the facts have no statement for it", () => {
    const facts = { ...answerFilled.facts!, statements: [] };
    const { findings, elsewhere } = answerFindings(answer({ facts, errors: [error()] }));
    expect(findings).toEqual([{ sentence: "它需要每天注射一次", statement: null, error: expect.objectContaining({ id: "err_1" }) }]);
    expect(elsewhere).toEqual([]);
    const away = answerFindings(answer({ facts, errors: [error({ statement: "说明书没有写的一句话" })] }));
    expect(away.findings).toEqual([]);
    expect(away.elsewhere).toHaveLength(1);
  });

  it("finds nothing in an answer with no text and no wrong statement", () => {
    expect(answerFindings({ snapshot: { ...answerFilled.snapshot, answerText: null }, facts: null, errors: [] })).toEqual({ findings: [], elsewhere: [] });
  });
});
