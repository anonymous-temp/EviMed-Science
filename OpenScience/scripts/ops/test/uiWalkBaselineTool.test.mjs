// scripts/ops/ui-walk-baseline.mjs: a walk's report becomes the entries of the walk's baseline, with the owner, the day and the reason a person gave.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { applyBaseline, baselineProblems } from "../ui-walk.mjs";
import { mergeEntries, proposeEntries } from "../ui-walk-baseline.mjs";

const run = promisify(execFile);
const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui-walk-baseline.mjs");
const who = { owner: "pagesa", until: "2026-12-31", why: "measured on the first rehearsal of R19; each page may only get better" };

/** What a walk's report holds for its findings (`report.findings`), as the walk writes them. */
const report = (profile, findings) => ({ profile, findings });
const found = (rule, view, text, value, accepted = null) => ({ rule, view, text, ...(value === undefined ? {} : { value }), accepted });

test("each finding nobody accepted becomes one entry: a number holds a page, a coverage gap is the owner walk's, a sentence is itself", () => {
  const proposed = proposeEntries(report("owner", [
    found("type-pairs", "files@desktop", "files@desktop: 7 font-size × weight pairs", 7),
    found("type-pairs", "files@desktop", "files@desktop: 9 font-size × weight pairs", 9),
    found("not-observable", "frontier@desktop", "frontier@desktop: not observable: no list on the page has a first row that opens"),
    found("not-observable", "frontier@desktop", "frontier@desktop: not observable: the page lists no mark that opens"),
    found("not-walked", "geo-answer", "geo-answer: not walked — the first project lists no wrong sentence with an answer"),
    found("notice", "inbox@desktop", "inbox@desktop: the page does not show the choice it was given"),
    found("type-pairs", "memory@desktop", "memory@desktop: 5 pairs", 5, { owner: "x", until: "2999-01-01" }),
    found("step-failed", "memory-map-drawer", "memory-map-drawer: the step could not run"),
  ]), who);
  assert.deepEqual(proposed.map((entry) => ({ ...entry, owner: undefined, until: undefined, why: undefined })), [
    { view: "files@desktop", rule: "type-pairs", max: 9 },
    { view: "frontier@desktop", rule: "not-observable", profiles: ["owner"] },
    { view: "geo-answer", rule: "not-walked", profiles: ["owner"] },
    { view: "inbox@desktop", contains: "the page does not show the choice it was given" },
  ].map((entry) => ({ ...entry, owner: undefined, until: undefined, why: undefined })));
  for (const entry of proposed) assert.deepEqual([entry.owner, entry.until, entry.why], [who.owner, who.until, who.why]);
  // What it proposes is a baseline the walk reads: every entry is valid, and it accepts what it was made from.
  assert.deepEqual(baselineProblems({ entries: proposed }), []);
  const again = applyBaseline(
    ["files@desktop: 7 font-size × weight pairs", "inbox@desktop: the page does not show the choice it was given"].map((text) => text.startsWith("files") ? found("type-pairs", "files@desktop", text, 7) : text),
    { entries: proposed }, { profile: "owner", today: "2026-10-17" },
  );
  assert.deepEqual(again.unaccepted, []);
});

test("--rule proposes the findings of the named rules alone: a debt with a name, an owner and a day is written without the findings that should still fail", () => {
  const findings = [
    found("type-pairs", "files@desktop", "files@desktop: 7 pairs", 7), found("type-pairs", "files@phone", "files@phone: 6 pairs", 6),
    found("orphan-sentence", "files@desktop", "files@desktop: 2 sentences stand alone", 2), found("notice", "inbox@desktop", "inbox@desktop: something else"),
  ];
  assert.deepEqual(proposeEntries(report("fixture", findings), who, { rules: ["type-pairs"] }).map((entry) => [entry.view, entry.rule, entry.max]), [["files@desktop", "type-pairs", 7], ["files@phone", "type-pairs", 6]]);
  assert.deepEqual(proposeEntries(report("fixture", findings), who, { rules: ["type-pairs", "orphan-sentence"] }).map((entry) => entry.rule), ["type-pairs", "type-pairs", "orphan-sentence"]);
  assert.equal(proposeEntries(report("fixture", findings), who).length, 4, "without --rule every finding is proposed, as before");
});

test("a fixture walk proposes no coverage gap, and a step that did not run is proposed by no walk", () => {
  const findings = [found("not-observable", "frontier@desktop", "frontier@desktop: not observable: no row"), found("step-failed", "files-pdf", "files-pdf: the step could not run"), found("type-pairs", "files@desktop", "files@desktop: 6 pairs", 6)];
  assert.deepEqual(proposeEntries(report("fixture", findings), who).map((entry) => entry.rule), ["type-pairs"]);
  assert.deepEqual(proposeEntries(report("owner", findings), who).map((entry) => entry.rule), ["not-observable", "type-pairs"]);
  assert.deepEqual(proposeEntries({}, who), []);
});

test("merging keeps what the file has: the larger number and the later day, one entry for one finding", () => {
  const held = { entries: [{ view: "files@desktop", rule: "type-pairs", max: 8, owner: "geos", until: "2026-11-30", why: "first" }] };
  const merged = mergeEntries(held, [
    { view: "files@desktop", rule: "type-pairs", max: 6, owner: "pagesa", until: "2026-12-31", why: "second" },
    { view: "inbox@desktop", contains: "x", owner: "pagesa", until: "2026-12-31", why: "second" },
  ]);
  assert.deepEqual(merged.entries.map((entry) => [entry.view, entry.max, entry.until, entry.owner]), [["files@desktop", 8, "2026-12-31", "geos"], ["inbox@desktop", undefined, "2026-12-31", "pagesa"]]);
  assert.equal(held.entries[0].until, "2026-11-30", "the file it was given is not changed");
});

test("the command proposes to stdout, asks for an owner, a day and a reason, and checks the shipped file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-walk-baseline-"));
  try {
    const file = path.join(dir, "report.json");
    await writeFile(file, JSON.stringify(report("owner", [found("type-pairs", "files@desktop", "files@desktop: 7 pairs", 7)])));
    const proposed = await run(process.execPath, [tool, "propose", file, "--owner", "pagesa", "--until", "2026-12-31", "--why", "rehearsal"]);
    assert.deepEqual(JSON.parse(proposed.stdout), [{ view: "files@desktop", rule: "type-pairs", max: 7, owner: "pagesa", until: "2026-12-31", why: "rehearsal" }]);
    const refused = await run(process.execPath, [tool, "propose", file, "--owner", "pagesa"]).catch((error) => error);
    assert.equal(refused.code, 2, "no default owner, day or reason: an entry nobody chose is the notice this file replaces");
    assert.match(refused.stderr, /usage: ui-walk-baseline\.mjs propose/);
    const checked = await run(process.execPath, [tool, "check"]);
    assert.match(checked.stdout, /\d+ entry\(ies\), 0 problem\(s\)/);
    assert.equal(JSON.parse(await readFile(path.join(path.dirname(tool), "ui-walk-baseline.json"), "utf8")).version, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
