// The ten typed follows that were read by the model and matched against a week of the feed, with a hand label on every match
// (evals/frontier-follows/cases.json, c3-watch 2026-10-25). The model is not called here: its recorded answers are replayed through
// the checks that hold it, and the labels are held to their own arithmetic.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { followMatchPredicate } from "../src/frontierFollowMatches.mjs";
import { FOLLOW_QUERY_LIMITS, verifyFollowQuery } from "../src/frontierFollowQuery.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(await readFile(path.join(here, "..", "..", "..", "evals", "frontier-follows", "cases.json"), "utf8"));

test("the fixture holds ten typed follows, a trial name, a pair, a class and a question among them", () => {
  assert.equal(doc.cases.length, 10);
  assert.ok(doc.cases.some((entry) => entry.answer.kind === "trial"));
  assert.ok(doc.cases.some((entry) => entry.answer.kind === "question"));
  assert.ok(doc.cases.some((entry) => entry.answer.concepts.length === 2));
  assert.equal(new Set(doc.cases.map((entry) => entry.typed)).size, 10);
});

test("every recorded reading passes the checks that hold the model's answer, with no glossary at all", () => {
  for (const entry of doc.cases) {
    const query = verifyFollowQuery(entry.answer, entry.typed, null);
    assert.ok(query, `${entry.typed} is read`);
    assert.equal(query.concepts.length, entry.answer.concepts.length, `${entry.typed}: every concept is held by the typed words`);
    assert.ok(query.concepts.length <= FOLLOW_QUERY_LIMITS.concepts);
    assert.equal(query.kind, entry.answer.kind);
    for (const concept of query.concepts) assert.ok(concept.terms_zh.length + concept.terms_en.length > 0);
  }
});

test("every recorded reading becomes one matching predicate with bounded parameters", () => {
  for (const entry of doc.cases) {
    const query = verifyFollowQuery(entry.answer, entry.typed, null);
    const values = [];
    const sql = followMatchPredicate(query, (value) => { values.push(value); return `$${values.length}`; });
    assert.ok(sql, `${entry.typed} has something to look up`);
    assert.equal(sql.split(" AND ").length, query.concepts.length, "every concept is required");
    assert.ok(values.length <= 12);
    assert.ok(values.every((value) => typeof value === "string" || Array.isArray(value)));
  }
});

test("the labels are the three words, and the precision of each follow and of the ten is their count", () => {
  let matches = 0, yes = 0, partly = 0;
  for (const entry of doc.cases) {
    assert.ok(entry.matches.every((match) => ["yes", "partly", "no"].includes(match.label)), entry.typed);
    assert.ok(entry.matches.every((match) => match.concepts.length === entry.answer.concepts.length && match.concepts.every((leg) => ["key", "title", "text"].includes(leg))));
    const counted = { matches: entry.matches.length, yes: entry.matches.filter((match) => match.label === "yes").length, partly: entry.matches.filter((match) => match.label === "partly").length };
    assert.deepEqual({ matches: entry.precision.matches, yes: entry.precision.yes, partly: entry.precision.partly }, counted, entry.typed);
    assert.equal(entry.precision.strict, counted.matches ? Math.round((counted.yes / counted.matches) * 100) / 100 : null);
    assert.equal(entry.precision.lenient, counted.matches ? Math.round(((counted.yes + counted.partly) / counted.matches) * 100) / 100 : null);
    matches += counted.matches; yes += counted.yes; partly += counted.partly;
  }
  assert.deepEqual({ matches: doc.totals.matches, yes: doc.totals.yes, partly: doc.totals.partly }, { matches, yes, partly });
  assert.equal(doc.totals.strict, Math.round((yes / matches) * 100) / 100);
  assert.equal(doc.totals.lenient, Math.round(((yes + partly) / matches) * 100) / 100);
});

test("a follow that matched nothing is recorded as that, not as a precision of zero", () => {
  const empty = doc.cases.filter((entry) => entry.matches.length === 0);
  assert.ok(empty.length >= 1);
  for (const entry of empty) assert.deepEqual(entry.precision, { matches: 0, yes: 0, partly: 0, strict: null, lenient: null });
});
