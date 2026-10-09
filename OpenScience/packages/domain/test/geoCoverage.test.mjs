import assert from "node:assert/strict";
import test from "node:test";
import { geoCoverageDifference, geoCoverageKey, geoCoverageStatement, geoSurfaceKey, parseGeoCoverageKey } from "../index.mjs";

const round = { setVersion: 2, pools: ["P2", "P1", "P3", "P4"], engines: ["kimi", "doubao", "deepseek"], surface: { mode: "web" } };

test("a coverage key is the same however the round listed what it measured, and names what was measured", () => {
  const key = geoCoverageKey(round);
  assert.equal(key, "v2|P1,P2,P3,P4|deepseek,doubao,kimi|web");
  assert.equal(geoCoverageKey({ ...round, engines: ["deepseek", "kimi", "doubao", "kimi"], pools: ["P4", "P3", "P2", "P1"] }), key);
  assert.deepEqual(parseGeoCoverageKey(key), { setVersion: "v2", pools: ["P1", "P2", "P3", "P4"], engines: ["deepseek", "doubao", "kimi"], surface: "web" });
});

test("only what changes what an engine is asked is surface: the transport and the digests a round records are not", () => {
  assert.equal(geoSurfaceKey(null), "web");
  assert.equal(geoSurfaceKey({ mode: "web", deep: false, newChat: true, city: "北京" }), "web;fast;newchat;city=北京");
  assert.equal(geoSurfaceKey({ mode: "web", transport: "wss", signed: true, responseDigest: "abc", intervention: { policyRevisionId: "r1" } }), "web");
  assert.equal(geoCoverageKey({ ...round, surface: { mode: "web", responseDigest: "x" } }), geoCoverageKey({ ...round, surface: { mode: "web", responseDigest: "y" } }));
});

test("a round nobody answered has no coverage, and a separator in a value cannot forge another key", () => {
  assert.equal(geoCoverageKey({ ...round, engines: [] }), null);
  assert.equal(geoCoverageKey({ setVersion: null, pools: [], engines: ["a|b,c"], surface: null }), "v-||a b c|web");
  assert.equal(parseGeoCoverageKey("not a key"), null);
});

test("two readings are compared when their keys are equal and in no other case; what moved is said", () => {
  const five = geoCoverageKey({ ...round, engines: ["kimi", "doubao", "deepseek", "qianwen", "yuanbao"] });
  const three = geoCoverageKey(round);
  assert.deepEqual(geoCoverageDifference(three, three), { comparable: true, unknown: false, engines: false, questions: false, surface: false });
  const engines = geoCoverageDifference(three, five);
  assert.deepEqual([engines.comparable, engines.engines, engines.questions, engines.surface], [false, true, false, false]);
  assert.equal(geoCoverageStatement(engines), "引擎范围有变化，不与上一轮比较");
  const questions = geoCoverageDifference(three, geoCoverageKey({ ...round, setVersion: 3 }));
  assert.deepEqual([questions.engines, questions.questions], [false, true]);
  assert.equal(geoCoverageStatement(questions), "问句范围有变化，不与上一轮比较");
  assert.equal(geoCoverageStatement(geoCoverageDifference(three, geoCoverageKey({ ...round, pools: ["P1", "P2"] }))), "问句范围有变化，不与上一轮比较");
  assert.equal(geoCoverageStatement(geoCoverageDifference(three, geoCoverageKey({ ...round, surface: { mode: "web", newChat: true } }))), "测量方式有变化，不与上一轮比较");
  assert.equal(geoCoverageStatement(geoCoverageDifference(three, geoCoverageKey({ ...round, setVersion: 3, engines: ["kimi"] }))), "测量范围有变化，不与上一轮比较");
  assert.equal(geoCoverageStatement(geoCoverageDifference(three, three)), null);
  assert.equal(geoCoverageStatement(null), null);
});

test("no key from either server is compared as it always was; a null is a server that does not know, and is compared with nothing", () => {
  assert.equal(geoCoverageDifference(undefined, undefined).comparable, true);
  const key = geoCoverageKey(round);
  for (const [before, after] of [[null, key], [key, null], [null, null], [undefined, key], [key, undefined]]) {
    const difference = geoCoverageDifference(before, after);
    assert.deepEqual([difference.comparable, difference.unknown], [false, true], `${before} vs ${after}`);
    assert.equal(geoCoverageStatement(difference), "测量范围没有记录，不与上一轮比较");
  }
});
