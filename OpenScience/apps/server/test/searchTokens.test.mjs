import assert from "node:assert/strict";
import test from "node:test";

import { searchTokens } from "../src/searchTokens.mjs";

test("a question keeps its first 64 terms, and a two-character Chinese word inside a longer run is a term of its own", () => {
  const long = Array.from({ length: 200 }, (_, index) => `term${index}`).join(" ");
  assert.equal(searchTokens(long).length, 64);
  assert.ok(searchTokens("肾功能").includes("肾功"));
  assert.ok(searchTokens("肾功能").includes("功能"));
  assert.deepEqual(searchTokens("?!"), []);
});
