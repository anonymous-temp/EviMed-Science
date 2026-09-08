// The inbox told the researcher to go and look somewhere else.
//
// Both run-finished bodies were fixed strings — "研究结果已准备好" and "研究运行已
// 结束，请查看运行记录了解状态" — chosen only by `status === "succeeded"`. So a
// package the delivery gate refused, a run a stall timer killed, and a run that
// never started because a spend ceiling refused it all arrived under one
// sentence, and the one fact the control plane held that the reader did not
// (why) was the one thing the notice left out. The card also rendered no
// control, so a notice that named a run could not open it.
import assert from "node:assert/strict";
import test from "node:test";

import { ALL_ERROR_CODES, RUN_OUTCOME_KINDS, errorCodeMessage } from "@evimed/domain";
import { runFinishedNotice } from "../src/notificationService.mjs";

test("a clean delivery says so and nothing more", () => {
  const notice = runFinishedNotice({ status: "succeeded", errorCode: null, verification: null, artifacts: ["report.md"] });

  assert.equal(notice.outcome, "delivered");
  assert.equal(notice.title, "研究已完成");
  assert.match(notice.body, /本次运行产出 1 个文件/);
});

test("a refused package and a platform stop do not share a sentence", () => {
  const gated = runFinishedNotice({ status: "failed", errorCode: "specialist_deliverable_not_accepted" });
  const stopped = runFinishedNotice({ status: "failed", errorCode: "verification_timeout" });

  assert.equal(gated.outcome, "gated");
  assert.equal(stopped.outcome, "stopped");
  assert.notEqual(gated.title, stopped.title);
  assert.notEqual(gated.body, stopped.body);
  // The distinction that matters to the reader: one is a statement about their
  // work, the other is a statement about the platform.
  assert.match(gated.title, /质量门/);
  assert.match(stopped.title, /平台终止/);
});

test("an unverified delivery is reported as delivered-but-check-it, not as a failure", () => {
  const notice = runFinishedNotice({
    status: "succeeded",
    errorCode: null,
    verification: "unverified",
    unverifiedArtifacts: ["clinical-evidence-report.md", "citation-ledger.csv"],
    qualityNotices: ["检索日志与实际检索不吻合"],
  });

  assert.equal(notice.outcome, "qualified");
  assert.match(notice.title, /待你复核/);
  assert.match(notice.body, /需要你自己复核/);
  // The files are the researcher's work whatever the verdict; a notice that
  // omits them reads as though the run produced nothing.
  assert.match(notice.body, /本次运行产出 2 个文件/);
  assert.match(notice.body, /检索日志与实际检索不吻合/);
});

test("a run refused before it started never claims files exist", () => {
  const notice = runFinishedNotice({ status: "failed", errorCode: "credits_exhausted" });

  assert.equal(notice.outcome, "capped");
  assert.doesNotMatch(notice.body, /个文件/);
  assert.equal(notice.body, errorCodeMessage("credits_exhausted"));
});

test("every outcome class has its own title, and the walk proves it walked", () => {
  const titles = new Map();
  for (const kind of RUN_OUTCOME_KINDS) {
    // Reach each class through a code that really has it, so this cannot pass
    // by asserting over a table that no production code maps onto.
    // `unknown` is the one class no registered code can reach — that is the
    // registry being complete, which is a property worth stating rather than
    // working around. It is reachable only by a code from a future build.
    const code = kind === "delivered" ? null
      : kind === "unknown" ? "a_code_this_build_does_not_know"
        : ALL_ERROR_CODES.find((candidate) => runFinishedNotice({ status: "failed", errorCode: candidate }).outcome === kind);
    if (kind !== "delivered" && kind !== "qualified") {
      assert.ok(code, `no error code in the registry classifies as ${kind}`);
    }
    if (kind === "unknown") {
      assert.equal(ALL_ERROR_CODES.filter((candidate) => runFinishedNotice({ status: "failed", errorCode: candidate }).outcome === "unknown").length, 0,
        "a registered code classifies as unknown, which means the registry has a hole");
    }
    const notice = kind === "qualified"
      ? runFinishedNotice({ status: "succeeded", verification: "unverified" })
      : runFinishedNotice({ status: kind === "delivered" ? "succeeded" : "failed", errorCode: code ?? null });
    assert.equal(notice.outcome, kind);
    assert.ok(notice.title.trim(), `${kind} has no title`);
    titles.set(kind, notice.title);
  }
  assert.equal(titles.size, RUN_OUTCOME_KINDS.length);
  // A class that shares another's title is a class the reader cannot tell apart,
  // which is the defect this replaced.
  assert.equal(new Set(titles.values()).size, RUN_OUTCOME_KINDS.length, `two classes share a title: ${JSON.stringify([...titles])}`);
});

test("every code that can end a run produces a body with a real sentence", () => {
  const empty = [];
  for (const code of ALL_ERROR_CODES) {
    const notice = runFinishedNotice({ status: "failed", errorCode: code });
    if (!notice.body.trim() || !/[一-鿿]/.test(notice.body)) empty.push(code);
  }
  assert.deepEqual(empty, [], `codes with no Chinese sentence: ${empty.slice(0, 10).join(", ")}`);
  assert.ok(ALL_ERROR_CODES.length > 250, `the registry walked only ${ALL_ERROR_CODES.length} codes`);
});
