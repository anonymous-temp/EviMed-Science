import assert from "node:assert/strict";
import test from "node:test";

import { foldToFit } from "../src/memoryMap.mjs";
import { FRESHNESS_DURABLE, freshnessOf } from "../src/memoryMapSources/common.mjs";
import { recordsContribution } from "../src/memoryMapSources/records.mjs";
import { MAX_VERSIONS_PER_FILE, replacedStatements } from "../src/memoryMapSources/replacedStatements.mjs";
import { lineFingerprint, memoryLines } from "../src/nativeMemoryOverlay.mjs";

const NOW = new Date("2026-10-30T00:00:00.000Z");
const days = (count) => new Date(NOW.getTime() - count * 86_400_000).toISOString();

const revision = (id, before, after, extra = {}) => ({
  id: String(id), change: "updated", actor: "engine", reason: "", before, after, undoneAt: null, changedAt: days(100 - id), ...extra,
});
const lineId = (line) => `f_${lineFingerprint(line).slice(0, 12)}`;
const profile = (body, history, rejected = []) => replacedStatements({
  fileId: "f", body, history, perLine: true, statementsOf: memoryLines, recordIdOfLine: lineId, rejected,
});
const topic = (body, history, rejected = []) => replacedStatements({
  fileId: "f", body, history, perLine: false, statementsOf: memoryLines, recordIdOfLine: lineId, rejected,
});

test("a profile line rewritten in one revision is replaced by the line that shares its words, with both ends of its time", () => {
  const before = "- 主攻方向：透析血管通路\n- 所在城市：北京";
  const after = "- 主攻方向：CKD 的凝血与内皮\n- 所在城市：北京";
  const history = [revision(1, "- 所在城市：北京", before), revision(2, before, after)];
  const [old, ...rest] = profile(after, history);
  assert.equal(rest.length, 0);
  assert.equal(old.text, "主攻方向：透析血管通路");
  assert.equal(old.successor, lineId("主攻方向：CKD 的凝血与内皮"));
  assert.equal(old.head, old.successor);
  assert.equal(old.at, history[0].changedAt);
  assert.equal(old.until, history[1].changedAt);
});

test("a line removed beside an unrelated new one is tied to no stranger", () => {
  const history = [revision(1, "- 所在城市：北京", "- 喜欢很短的回答")];
  assert.deepEqual(profile("- 喜欢很短的回答", history), []);
});

test("two lines with no label are tied by the words they share", () => {
  const found = profile("- 喜欢回答先给结论再写依据和来源", [revision(1, "- 喜欢回答先给结论再写依据", "- 喜欢回答先给结论再写依据和来源")]);
  assert.deepEqual(found.map((statement) => statement.text), ["喜欢回答先给结论再写依据"]);
});

test("taking out alone or adding alone is no replacement", () => {
  assert.deepEqual(profile("- 主攻方向：透析", [revision(1, "- 主攻方向：透析\n- 所在城市：北京", "- 主攻方向：透析")]), []);
  assert.deepEqual(topic("第一行\n第二行", [revision(1, "第一行", "第一行\n第二行")]), []);
});

test("a forget, an undo, a restore, an undone revision, the platform's own check and a deletion are no change of mind", () => {
  const rewrite = ["旧的说法在这里", "新的说法在这里"];
  for (const extra of [
    { reason: "forgotten on the memory page" }, { reason: "undo" }, { reason: "restored from forgotten" }, { undoneAt: days(1) },
    { actor: "platform" }, { actor: "conversation" }, { change: "deleted" }, { before: null }, { after: null },
  ]) assert.deepEqual(topic(rewrite[1], [revision(1, rewrite[0], rewrite[1], extra)]), [], JSON.stringify(extra));
});

test("what the person forgot is not drawn, however old the revision that said it", () => {
  const old = "主攻方向：透析血管通路";
  const history = [revision(1, `- ${old}`, "- 主攻方向：CKD 的凝血与内皮")];
  assert.equal(profile("- 主攻方向：CKD 的凝血与内皮", history).length, 1);
  assert.deepEqual(profile("- 主攻方向：CKD 的凝血与内皮", history, [{ fingerprint: lineFingerprint(old), text: null }]), []);
  assert.deepEqual(profile("- 主攻方向：CKD 的凝血与内皮", history, [{ fingerprint: "x", text: "透析血管通路" }].map((entry) => ({ ...entry, text: "主攻方向透析血管通路" }))), []);
  assert.deepEqual(topic("新的说法在这里", [revision(1, old, "新的说法在这里")], [{ fingerprint: lineFingerprint(old), text: null }]), []);
});

test("the person's own edit puts the old line on the rejection list and it stays drawn, as it stays in the drawer's versions", () => {
  const old = "目标期刊：Kidney International";
  const rejected = [{ fingerprint: lineFingerprint(old), text: null }];
  const history = [revision(1, `- ${old}`, "- 目标期刊：JASN", { actor: "user", reason: "edited on the memory page" })];
  assert.equal(profile("- 目标期刊：JASN", history, rejected).length, 1);
  assert.equal(topic("目标期刊：JASN", history, rejected).length, 1);
});

test("a line said again is in force and not replaced", () => {
  const history = [revision(1, "- 目标期刊：Kidney International", "- 目标期刊：JASN"), revision(2, "- 目标期刊：JASN", "- 目标期刊：Kidney International")];
  const found = profile("- 目标期刊：Kidney International", history);
  assert.deepEqual(found.map((statement) => statement.text), ["目标期刊：JASN"]);
  assert.equal(found[0].successor, lineId("目标期刊：Kidney International"));
});

test("a line replaced twice is a chain, each old statement pointing at the next and all at the line in force", () => {
  const history = [revision(1, "- 目标期刊：Kidney International", "- 目标期刊：JASN 正刊"), revision(2, "- 目标期刊：JASN 正刊", "- 目标期刊：CJASN 子刊")];
  const found = profile("- 目标期刊：CJASN 子刊", history);
  assert.equal(found.length, 2);
  const [first, second] = found;
  assert.equal(first.successor, second.id);
  assert.equal(second.successor, lineId("目标期刊：CJASN 子刊"));
  assert.equal(first.head, second.successor);
});

test("a topic file's rewrite replaces its previous words, whatever they share, and the newest versions are kept", () => {
  const history = Array.from({ length: MAX_VERSIONS_PER_FILE + 2 }, (_, index) => revision(index + 1, `第 ${index} 版`, `第 ${index + 1} 版`));
  const found = topic(`第 ${history.length} 版`, history);
  assert.equal(found.length, MAX_VERSIONS_PER_FILE);
  assert.deepEqual(found.map((statement) => statement.text), ["第 2 版", "第 3 版", "第 4 版"]);
  assert.equal(found[0].successor, found[1].id);
  assert.equal(found.at(-1).successor, "f");
  assert.ok(found.every((statement) => statement.head === "f"));
  assert.equal(found[1].at, found[0].until);
});

test("the map draws an old statement in grey under the memory in force, tied by a line, and counts it nowhere as a memory", () => {
  const record = { id: "f", kind: "project_fact", scope: "project", scopeId: "p1", value: "目标期刊：JASN", status: "active", createdAt: days(10), updatedAt: days(10), lastRecalledAt: days(1), recallCount: 2 };
  const contribution = recordsContribution([record], {
    replaced: [{ id: "f~r1", text: "目标期刊：Kidney International", successor: "f", head: "f", at: days(90), until: days(10) }],
  }, { now: NOW });
  const old = contribution.nodes.find((node) => node.id === "memory:f~r1");
  assert.equal(old.state, "replaced");
  assert.equal(old.until, days(10));
  assert.equal(old.freshness, 0);
  assert.deepEqual(old.open, { kind: "record", id: "f" });
  assert.equal(old.projectId, "p1");
  assert.ok(contribution.edges.some((edge) => edge.type === "replaces" && edge.from === "memory:f" && edge.to === "memory:f~r1"));
  assert.ok(contribution.edges.some((edge) => edge.type === "belongs-to" && edge.from === "memory:f~r1" && edge.to === "project:p1"));
  const live = contribution.nodes.find((node) => node.id === "memory:f");
  assert.equal(live.recalledAt, days(1));
  assert.ok(live.freshness > 0.9);
});

test("an old statement whose memory is gone or hidden is not drawn", () => {
  const contribution = recordsContribution([], { replaced: [{ id: "f~r1", text: "x", successor: "f", head: "f", at: null, until: null }] }, { now: NOW });
  assert.deepEqual(contribution.nodes, []);
  assert.deepEqual(contribution.edges, []);
});

test("what was replaced goes rather than folds: a group counts memories, and says how many it folded", () => {
  const live = Array.from({ length: 12 }, (_, index) => ({ id: `memory:${index}`, type: "memory", subtype: "profile", weight: 0.5, state: "current" }));
  const old = Array.from({ length: 6 }, (_, index) => ({ id: `memory:old${index}`, type: "memory", subtype: "profile", weight: 0.1, state: "replaced" }));
  const edges = old.map((node, index) => ({ from: `memory:${index}`, to: node.id, type: "replaces" }));
  const fitted = foldToFit([...live, ...old], edges, 6);
  assert.equal(fitted.nodes.filter((node) => node.state === "replaced").length, 0);
  const cluster = fitted.nodes.find((node) => node.type === "cluster");
  assert.equal(fitted.folded, cluster.count);
  assert.ok(fitted.edges.every((edge) => !edge.to.startsWith("memory:old")));
});

test("freshness halves with its half-life from the last write or use, use stretches it, and what is about the person does not fade", () => {
  const project = { kind: "project_fact", projectId: "p" };
  assert.equal(freshnessOf({ ...project, writtenAt: days(0) }, NOW), 1);
  assert.equal(freshnessOf({ ...project, writtenAt: days(30) }, NOW), 0.5);
  assert.equal(freshnessOf({ ...project, writtenAt: days(120), recalledAt: days(30) }, NOW), 0.5);
  assert.ok(freshnessOf({ ...project, writtenAt: days(60), recalledAt: days(60), recalls: 5 }, NOW) > freshnessOf({ ...project, writtenAt: days(60) }, NOW));
  // However often: the stretch has a ceiling.
  assert.equal(freshnessOf({ ...project, writtenAt: days(120), recalls: 1e6 }, NOW), 0.5);
  assert.equal(freshnessOf({ kind: "preference", writtenAt: days(900) }, NOW), FRESHNESS_DURABLE);
  // A project's kind is a project's memory wherever it sits, and a person's kind inside a project fades with it.
  assert.equal(freshnessOf({ kind: "decision", writtenAt: days(30) }, NOW), 0.5);
  assert.equal(freshnessOf({ kind: "preference", projectId: "p", writtenAt: days(30) }, NOW), 0.5);
  assert.equal(freshnessOf({ kind: "decision" }, NOW), FRESHNESS_DURABLE);
});
