import assert from "node:assert/strict";
import test from "node:test";
import { asksAgainForIndexOnly } from "../src/knowledgePageService.mjs";

test("a wiki compile that wrote only its index is asked once more, and only once", () => {
  assert.equal(asksAgainForIndexOnly({ tree: "wiki", status: "completed", typed: 1, retried: false }), true, "the index alone");
  assert.equal(asksAgainForIndexOnly({ tree: "wiki", status: "completed", typed: 0, retried: false }), true, "nothing at all");
  assert.equal(asksAgainForIndexOnly({ tree: "wiki", status: "completed", typed: 1, retried: true }), false, "the second answer stands");
  assert.equal(asksAgainForIndexOnly({ tree: "wiki", status: "completed", typed: 3, retried: false }), false, "an index and pages is a wiki");
  assert.equal(asksAgainForIndexOnly({ tree: "wiki", status: "failed", typed: 0, retried: false }), false, "a failure is reported, not retried here");
  assert.equal(asksAgainForIndexOnly({ tree: "kg", status: "completed", typed: 0, retried: false }), false, "the graph has no index page");
});
