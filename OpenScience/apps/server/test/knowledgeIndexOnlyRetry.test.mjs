import assert from "node:assert/strict";
import test from "node:test";
import { asksAgainForIndexOnly, compileRetryMode } from "../src/knowledgePageService.mjs";

test("a wiki compile that wrote only its index is asked once more, and only once", () => {
  assert.equal(asksAgainForIndexOnly({ tree: "wiki", status: "completed", typed: 1, retried: false }), true, "the index alone");
  assert.equal(asksAgainForIndexOnly({ tree: "wiki", status: "completed", typed: 0, retried: false }), true, "nothing at all");
  assert.equal(asksAgainForIndexOnly({ tree: "wiki", status: "completed", typed: 1, retried: true }), false, "the second answer stands");
  assert.equal(asksAgainForIndexOnly({ tree: "wiki", status: "completed", typed: 3, retried: false }), false, "an index and pages is a wiki");
  assert.equal(asksAgainForIndexOnly({ tree: "wiki", status: "failed", typed: 0, retried: false }), false, "a failure is reported, not retried here");
  assert.equal(asksAgainForIndexOnly({ tree: "kg", status: "completed", typed: 0, retried: false }), false, "the graph has no index page");
});

test("the retry asks for a full run only of an engine that reads it: v0.5.2 and later, never v0.5.1.1, v0.5.0 or an engine that has not answered", () => {
  // From v0.5.2 a compile is incremental by default and the same instruction over the same sources writes nothing, so a retry that
  // does not say `full` would repeat the failure for free.
  for (const version of ["v0.5.2", "v0.5.2.1", "v0.5.3", "v0.6.0", "0.5.2", "v1.0.0"]) assert.equal(compileRetryMode({ engineVersion: version }), "full", version);
  for (const version of ["v0.5.1.1", "v0.5.1", "v0.5.0", "v0.4.23", "v0.5", "main", "", null, undefined]) assert.equal(compileRetryMode({ engineVersion: /** @type {any} */ (version) }), null, String(version));
  assert.equal(compileRetryMode(), null);
});
