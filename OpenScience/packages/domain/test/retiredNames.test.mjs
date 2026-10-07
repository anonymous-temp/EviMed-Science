import assert from "node:assert/strict";
import test from "node:test";
import { RETIRED_MODULE_NAMES, RETIRED_NAME_SEARCH_UNTIL, searchMatches, searchNeedles } from "../index.mjs";

const BEFORE = Date.parse("2026-12-01T00:00:00Z");
const AFTER = Date.parse("2027-01-08T00:00:00Z");

test("a retired module name is read as its current name while the alias lasts", () => {
  assert.deepEqual(searchNeedles("循证传播", BEFORE), ["循证传播", "循证 geo"]);
  assert.deepEqual(searchNeedles(" 虚拟临研 ", BEFORE), ["虚拟临研", "虚拟临床研究"]);
  // Only the retired word is rewritten; the rest of what was typed stays.
  assert.deepEqual(searchNeedles("循证传播 GEO 提案", BEFORE), ["循证传播 geo 提案", "循证 geo geo 提案"]);
});

test("a query with no retired name is tried as typed, and an empty one matches everything", () => {
  assert.deepEqual(searchNeedles("meta 分析", BEFORE), ["meta 分析"]);
  assert.deepEqual(searchNeedles("   ", BEFORE), []);
  assert.equal(searchMatches("", ["anything"], BEFORE), true);
});

test("the old name finds a row that holds the new name, and a row that still holds the old one", () => {
  assert.equal(searchMatches("循证传播", ["循证 GEO · 分层稿件", "写作与传播"], BEFORE), true);
  assert.equal(searchMatches("虚拟临研", ["虚拟临床研究 · 研究定义"], BEFORE), true);
  assert.equal(searchMatches("循证传播", ["a note that says 循证传播"], BEFORE), true);
  assert.equal(searchMatches("循证传播", ["Meta 分析"], BEFORE), false);
});

test("three months after the rename the old name is a word like any other", () => {
  assert.equal(RETIRED_NAME_SEARCH_UNTIL, "2027-01-07");
  assert.deepEqual(searchNeedles("循证传播", AFTER), ["循证传播"]);
  assert.equal(searchMatches("循证传播", ["循证 GEO · 分层稿件"], AFTER), false);
  // The last day itself still counts.
  assert.equal(searchMatches("循证传播", ["循证 GEO"], Date.parse("2027-01-07T12:00:00Z")), true);
});

test("each retired name maps to a distinct current name the product really uses", () => {
  assert.deepEqual(RETIRED_MODULE_NAMES.map((entry) => entry.now), ["循证 GEO", "虚拟临床研究"]);
  assert.equal(new Set(RETIRED_MODULE_NAMES.map((entry) => entry.retired)).size, RETIRED_MODULE_NAMES.length);
});
