// General lessons become platform handbooks (evidence-flywheel F16 and §7, 2026-10-06): the code's field checks, the model gate's closed answer, the author rule
// (three ✓ cards, or an independent second account's lesson of the same class), the independent re-check, what the supply refuses, retirement that names nobody,
// and the merge point that tells the path a lesson was applied.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evolutionToolVisible } from "@evimed/domain";
import { EvolutionService } from "../src/evolutionService.mjs";
import { HandbookConsolidation } from "../src/handbookConsolidation.mjs";
import {
  HANDBOOK_LESSON_CLASSES, HANDBOOK_TEXT_LIMITS, createPlatformHandbooks, handbookFieldChecks, handbookJudgeMessages, handbookSkillFiles, platformHandbookMetricFamilies,
} from "../src/learningPlatformHandbooks.mjs";
import { createPlatformSkillSupply } from "../src/platformSkillSupply.mjs";
import { BODY, fixture as handbookFixture, frontmatter, registry } from "./helpers/handbookFixture.mjs";

const LESSON = {
  frontmatter: { name: "denominator-check", description: "Check study denominators when summarizing preserved research results." },
  body: ["## Purpose", "Keep every denominator tied to the preserved source before stating a proportion.", "## Workflow", "Name the population each count refers to, and say so when the source gives none."].join("\n"),
  contentDigest: "sha256:aaaa",
};

function evolution() {
  /** @type {Map<string, any>} */ const rows = new Map();
  const jobs = [];
  let time = new Date("2026-10-06T04:00:00Z");
  const documents = {
    async get(owner, kind, id) { return structuredClone(rows.get(`${owner}:${kind}:${id}`) ?? null); },
    async list(owner, kind, { filter }) { return { items: [...rows.entries()].filter(([key, row]) => key.startsWith(`${owner}:${kind}:`) && Object.entries(filter).every(([name, value]) => row.payload[name] === value)).map(([, row]) => structuredClone(row)), nextCursor: null }; },
    async put(owner, kind, id, payload, { expectedRevision, projectId }) {
      const key = `${owner}:${kind}:${id}`;
      const old = rows.get(key);
      if ((old?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error("conflict"), { code: "product_revision_conflict" });
      const row = { id, payload: structuredClone(payload), projectId, revision: expectedRevision + 1, createdAt: old?.createdAt ?? time.toISOString(), updatedAt: time.toISOString() };
      rows.set(key, row);
      return structuredClone(row);
    },
  };
  /** @type {any[]} */ const notices = [];
  const service = new EvolutionService({ documents, ownerId: "operator", now: () => time,
    jobs: { async enqueue(owner, kind, payload, options) { const job = { owner, kind, payload, key: options.idempotencyKey }; jobs.push(job); return job; } },
    notifications: { async create(owner, input) { notices.push({ owner, ...input }); return {}; } } });
  return { service, rows, notices, advance(ms) { time = new Date(time.getTime() + ms); } };
}

/** A real supply over a temporary data directory, so what it refuses is the real refusal. */
async function supplyOver(enabled = true) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "platform-handbooks-"));
  return { dataDir, supply: createPlatformSkillSupply({ dataDir, evolutionEnabled: enabled }), cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

/** @param {Record<string, any>} [over] */
async function build(over = {}) {
  const e = evolution();
  const supplied = await supplyOver();
  const judged = [];
  const reviewed = [];
  const handbooks = createPlatformHandbooks({
    service: e.service, supply: supplied.supply, now: () => e.service.now(),
    facts: async () => ({ names: ["Project Heron", "ward_admissions.csv"], identifiers: [], numbers: [] }),
    judge: async (input) => { judged.push(input); return { general: true, class: "numbers-and-tables" }; },
    review: async (input) => { reviewed.push(input); return { independent: true, general: true, class: "numbers-and-tables" }; },
    established: async (ids) => new Set(ids.filter((id) => id.startsWith("senior-"))),
    ...over,
  });
  return { ...e, ...supplied, handbooks, judged, reviewed };
}
const lesson = (userId, extra = {}) => ({ userId, capabilityId: "meta-analysis", handbookId: `h-${userId}`, handbook: { ...LESSON, ...extra.handbook }, sourceProjectId: `p-${userId}`, runId: `r-${userId}`, ...extra.input });
const candidates = (f) => [...f.rows.values()].filter((row) => row.payload.recordType === "evolution-handbook-candidate");

test("the field checks are a closed list of format and token checks: attachments, identifiers, data numbers, size and the account's own names", () => {
  assert.deepEqual(handbookFieldChecks(LESSON, {}).failed, []);
  const failing = (text, facts = {}, files = undefined) => handbookFieldChecks({ ...LESSON, body: `${LESSON.body}\n${text}`, ...(files ? { files } : {}) }, facts).failed;
  assert.deepEqual(failing("", {}, { "notes.md": "x" }), ["has_attachments"]);
  for (const text of ["See 10.1056/NEJMoa1107039 for the method.", "PMID 12345678 shows it.", "Registered as NCT01234567.", "Read https://example.org/trial", "Write to someone@example.org", "Stored at /home/coder/uploads/run1"])
    assert.ok(failing(text).includes("identifier_format"), text);
  for (const text of ["The sample was 12000 patients.", "A hazard ratio of 0.74 was found.", "Roughly 3,5 per cent."]) assert.ok(failing(text).includes("data_number"), text);
  assert.deepEqual(failing("Use at least 2 sources and 3 checks."), [], "small counts are method, not data");
  assert.ok(failing("The Project Heron cohort differs.", { names: ["Project Heron"] }).includes("project_fact"));
  assert.ok(failing("Open ward_admissions.csv first.", { names: ["ward_admissions.csv"] }).includes("project_fact"));
  assert.ok(failing("Check heron first.", { names: ["Project Heron"] }).includes("project_fact"), "a whole token of a name");
  assert.deepEqual(failing("Use a quote.", { names: ["a", "of", "7"] }), [], "a fact of one or two characters is a word every lesson holds");
  assert.deepEqual(failing("Heronry is unrelated.", { names: ["heron"] }), [], "a token, not a substring");
  assert.ok(handbookFieldChecks({ ...LESSON, body: "short" }, {}).failed.includes("too_short"));
  assert.ok(handbookFieldChecks({ ...LESSON, body: "x ".repeat(HANDBOOK_TEXT_LIMITS.max) }, {}).failed.includes("too_long"));
});

test("an established author's general lesson becomes a candidate, is re-checked by an independent reviewer, and is published as a text-only skill for its capability alone", async () => {
  const f = await build();
  try {
    assert.deepEqual(await f.handbooks.consider(lesson("senior-1")), { state: "candidate" });
    assert.equal(f.judged.length, 1);
    assert.ok(!JSON.stringify(f.judged[0]).includes("senior-1") && !JSON.stringify(f.judged[0]).includes("p-senior-1"), "the judge is shown the lesson and its capability, no account or project");
    const [row] = candidates(f);
    assert.deepEqual([row.payload.status, row.payload.lessonClass, row.payload.promotedBy], ["candidate", "numbers-and-tables", "established_author"]);
    assert.deepEqual(row.payload.derivedFrom, { userId: "senior-1", handbookId: "h-senior-1", handbookDigest: "sha256:aaaa", capabilityId: "meta-analysis", sourceProjectId: "p-senior-1", runId: "r-senior-1", at: row.payload.derivedFrom.at });
    assert.deepEqual(await f.handbooks.tick(), { judged: 0, rechecked: 1, retired: 0 });
    assert.equal(f.reviewed.length, 1);
    assert.ok(!JSON.stringify(f.reviewed[0]).includes("senior-1"), "the reviewer is shown the lesson text alone");
    const [probation] = candidates(f);
    assert.equal(probation.payload.status, "probation");
    assert.deepEqual(await f.service.availableTools({capabilityId:"meta-analysis"}), []);
    await f.handbooks.observe({entryId:probation.id,version:1,runId:"evaluation-new-task",outcome:"useful",evidence:{resultId:"verified-result",attributable:true,independent:true}});
    const [done] = candidates(f);
    assert.equal(done.payload.status, "effective");
    const tool = await f.service.get(done.payload.toolId);
    assert.deepEqual([tool.payload.status, tool.payload.toolKind, tool.payload.publicationKind, tool.payload.capabilityIds, tool.payload.recheckPassed], ["active", "handbook", "skill", ["meta-analysis"], true]);
    assert.equal(evolutionToolVisible(tool.payload), true);
    assert.deepEqual((await f.service.availableTools({ capabilityId: "meta-analysis" })).map((entry) => entry.id), [tool.id]);
    assert.deepEqual(await f.service.availableTools({ capabilityId: "adr-analysis" }), []);
    // What the supply holds is the lesson's text and nothing about its origin.
    const files = await readdir(path.join(f.dataDir, ".openscience", "platform-skills", "generations"), { recursive: true });
    const skill = files.find((name) => name.endsWith("SKILL.md"));
    const text = await readFile(path.join(f.dataDir, ".openscience", "platform-skills", "generations", String(skill)), "utf8");
    assert.match(text, /Keep every denominator tied to the preserved source/);
    for (const secret of ["senior-1", "p-senior-1", "r-senior-1", "h-senior-1"]) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(files.filter((name) => name.includes("skills/") && !name.endsWith("SKILL.md") && !name.endsWith("platform-" + "")).filter((name) => /\.(py|sh|js)$/.test(name)), []);
    // The tool projection never carries provenance.
    assert.equal(JSON.stringify(await f.service.availableTools({})).includes("senior-1"), false);
  } finally { await f.cleanup(); }
});

test("a new author's lesson waits, and enters only when another account's lesson of the same capability and class passes the first two gates; the same account twice, another class and another capability do not corroborate", async () => {
  const f = await build();
  try {
    assert.equal((await f.handbooks.consider(lesson("new-1"))).state, "awaiting_corroboration");
    assert.equal((await f.handbooks.consider(lesson("new-1", { input: { handbookId: "h-second" }, handbook: { contentDigest: "sha256:bbbb" } }))).state, "awaiting_corroboration", "the same account is one voice");
    f.judged.length = 0;
    const other = f.handbooks;
    const differing = createPlatformHandbooks({ service: f.service, supply: f.supply, now: () => f.service.now(), facts: async () => ({}), established: async () => new Set(),
      judge: async () => ({ general: true, class: "citations-and-quotes" }), review: null });
    assert.equal((await differing.consider(lesson("new-2"))).state, "awaiting_corroboration", "another class is no corroboration");
    assert.equal((await other.consider(lesson("new-3", { input: { capabilityId: "adr-analysis" } }))).state, "awaiting_corroboration", "another capability is none either");
    assert.deepEqual(candidates(f).map((row) => row.payload.status), ["awaiting_corroboration", "awaiting_corroboration", "awaiting_corroboration", "awaiting_corroboration"]);
    // An independent second account's lesson of the same capability and class: both are promoted.
    assert.equal((await other.consider(lesson("new-4"))).state, "candidate");
    const promoted = candidates(f).filter((row) => row.payload.status === "candidate").map((row) => row.payload.contributor);
    assert.equal(promoted.length, 3, "the two voices of new-1 and the new one, which stand beside each other");
    assert.deepEqual(candidates(f).filter((row) => row.payload.status === "candidate").map((row) => row.payload.promotedBy), ["corroborated", "corroborated", "corroborated"]);
  } finally { await f.cleanup(); }
});

test("a lesson whose run drew on a received pack does not corroborate: shared text from a new author is not a second voice", async () => {
  const guest = new Set(["r-new-2"]);
  const f = await build({ recentGuestRun: async (_userId, runId) => guest.has(String(runId)) });
  try {
    await f.handbooks.consider(lesson("new-1"));
    assert.equal((await f.handbooks.consider(lesson("new-2"))).state, "awaiting_corroboration");
    guest.clear();
    assert.equal((await f.handbooks.consider(lesson("new-3"))).state, "candidate");
  } finally { await f.cleanup(); }
});

test("the model's answer is closed: anything but a general verdict with a listed class is dropped, a refusal is a rejection, and a judge that fails is tried again and then gives up", async () => {
  for (const [answer, reason] of [[{ general: false, class: "other" }, "not_general"], [{ general: true, class: "a made-up class" }, "judge_invalid"], [{ general: "yes" }, "judge_invalid"], [null, "judge_invalid"]]) {
    const f = await build({ judge: async () => answer });
    try {
      const result = await f.handbooks.consider(lesson("senior-1"));
      assert.deepEqual([result.state, result.reason], ["rejected", [reason]], JSON.stringify(answer));
      assert.equal(candidates(f)[0].payload.text.body.length > 0, true);
    } finally { await f.cleanup(); }
  }
  let calls = 0;
  const f = await build({ judge: async () => { calls += 1; throw Object.assign(new Error("down"), { code: "model_unavailable" }); }, report: (code) => reported.push(code) });
  const reported = [];
  try {
    assert.equal((await f.handbooks.consider(lesson("senior-1"))).state, "judge_pending");
    await f.handbooks.tick();
    assert.equal(candidates(f)[0].payload.status, "judge_pending");
    await f.handbooks.tick();
    assert.deepEqual([candidates(f)[0].payload.status, candidates(f)[0].payload.reason, calls], ["rejected", ["judge_unavailable"], 3]);
    assert.ok(reported.every((code) => code === "learning_platform_handbook_model_unavailable"));
  } finally { await f.cleanup(); }
});

test("a lesson that fails a field check is refused before any model is asked, and its text is not kept", async () => {
  const f = await build();
  try {
    const result = await f.handbooks.consider(lesson("senior-1", { handbook: { body: `${LESSON.body}\nIn Project Heron the cohort file ward_admissions.csv was 4821 rows.` } }));
    assert.deepEqual([result.state, [...result.reason ?? []].sort()], ["rejected", ["data_number", "project_fact"]]);
    assert.equal(f.judged.length, 0);
    assert.equal(candidates(f)[0].payload.text, null);
    assert.deepEqual(f.handbooks.stats().rejectedBy, { data_number: 1, project_fact: 1 });
  } finally { await f.cleanup(); }
});

test("nothing is effective before the independent re-check: no reviewer, a reviewer of the same family, a reviewer that disagrees, and a project fact that appeared since", async () => {
  const cases = [
    ["no reviewer", { review: null }, "candidate", null],
    ["not independent", { review: async () => ({ independent: false, general: true, class: "numbers-and-tables" }) }, "rejected", "review_not_independent"],
    ["disagrees", { review: async () => ({ independent: true, general: true, class: "evidence-matrix" }) }, "rejected", "review_disagrees"],
    ["says it is not general", { review: async () => ({ independent: true, general: false, class: "numbers-and-tables" }) }, "rejected", "review_disagrees"],
  ];
  for (const [label, over, status, reason] of cases) {
    const f = await build(over);
    try {
      await f.handbooks.consider(lesson("senior-1"));
      await f.handbooks.tick();
      const [row] = candidates(f);
      assert.deepEqual([row.payload.status, row.payload.reason?.[0] ?? null], [status, reason], label);
      assert.equal([...f.rows.values()].some((entry) => entry.payload.recordType === "evolution-tool"), false, `${label}: no tool exists`);
    } finally { await f.cleanup(); }
  }
  let facts = { names: [] };
  const later = await build({ facts: async () => facts });
  try {
    await later.handbooks.consider(lesson("senior-1"));
    facts = { names: ["denominator"] };
    await later.handbooks.tick();
    assert.deepEqual([candidates(later)[0].payload.status, candidates(later)[0].payload.reason], ["rejected", ["project_fact"]], "the code re-checks the facts as they are at the re-check");
  } finally { await later.cleanup(); }
});

test("the supply refuses what has not been re-checked: a handbook entry without the re-check, with a second file, with another kind of publication, and anything while the evolution module is off", async () => {
  const on = await supplyOver(true);
  const off = await supplyOver(false);
  try {
    const files = handbookSkillFiles({ name: "denominator-check", description: "d", body: LESSON.body });
    const candidate = { id: "handbook-x", files, publicationKind: "skill", capabilityIds: ["meta-analysis"], track: "M", executionTools: [] };
    const card = { id: "handbook-x", toolKind: "handbook", capabilityIds: ["meta-analysis"], track: "M" };
    await assert.rejects(on.supply.publish(candidate, { card, evaluation: { ok: true, verificationLevel: "V0" }, activate: false }), { code: "extension_contract_invalid" });
    await assert.rejects(on.supply.publish(candidate, { card, evaluation: { ok: true, verificationLevel: "V0", recheckPassed: false }, activate: false }), { code: "extension_contract_invalid" });
    await assert.rejects(on.supply.publish({ ...candidate, files: { ...files, "notes.md": "extra" } }, { card, evaluation: { ok: true, verificationLevel: "V0", recheckPassed: true }, activate: false }), { code: "extension_contract_invalid" });
    await assert.rejects(on.supply.publish({ ...candidate, publicationKind: "isolated-tool" }, { card, evaluation: { ok: true, verificationLevel: "V0", recheckPassed: true }, activate: false }), { code: "extension_contract_invalid" });
    await assert.rejects(off.supply.publish(candidate, { card, evaluation: { ok: true, verificationLevel: "V0", recheckPassed: true }, activate: false }), { code: "extension_contract_invalid" });
    const published = await on.supply.publish(candidate, { card, evaluation: { ok: true, verificationLevel: "V0", recheckPassed: true }, activate: false });
    assert.match(published.nativeName, /^platform-[a-f0-9]{24}$/);
    assert.equal(evolutionToolVisible({ status: "active", toolKind: "handbook" }), false, "a handbook entry is not visible without its re-check");
    assert.equal(evolutionToolVisible({ status: "staged", toolKind: "handbook", recheckPassed: true }), false);
  } finally { await on.cleanup(); await off.cleanup(); }
});

test("retirement is the harm test's: the candidate learns it was retired, and nothing is told to anyone — not the account the lesson came from", async () => {
  const f = await build();
  try {
    await f.handbooks.consider(lesson("senior-1"));
    await f.handbooks.tick();
    const [row] = candidates(f);
    const tool = await f.service.get(row.payload.toolId);
    await f.service.save("tool", tool.id, { ...tool.payload, status: "retired" }, tool);
    assert.deepEqual(await f.handbooks.tick(), { judged: 0, rechecked: 0, retired: 1 });
    assert.equal(candidates(f)[0].payload.status, "retired");
    assert.deepEqual(f.notices, [], "no notice anywhere");
    assert.equal(f.handbooks.stats().outcomes.retired, 1);
    assert.deepEqual(await f.service.availableTools({ capabilityId: "meta-analysis" }), []);
  } finally { await f.cleanup(); }
});

test("no more candidates are re-checked and activated in a day than the bound, and the next day has room", async () => {
  const f = await build({ perDay: 1 });
  try {
    for (const id of ["senior-1", "senior-2"]) await f.handbooks.consider(lesson(id, { handbook: { contentDigest: `sha256:${id}`, body: `${LESSON.body}\nLesson variant ${id}.` } }));
    assert.deepEqual((await f.handbooks.tick()).rechecked, 1);
    assert.deepEqual((await f.handbooks.tick()).rechecked, 0);
    f.advance(24 * 3_600_000);
    assert.deepEqual((await f.handbooks.tick()).rechecked, 1);
    assert.equal(candidates(f).filter((row) => row.payload.status === "probation").length, 2);
  } finally { await f.cleanup(); }
});

test("considering the same lesson twice is one record, and input that is not a lesson is skipped, never thrown", async () => {
  const f = await build();
  try {
    await f.handbooks.consider(lesson("senior-1"));
    assert.deepEqual(await f.handbooks.consider(lesson("senior-1")), { state: "known" });
    assert.equal(candidates(f).length, 1);
    for (const bad of [{}, { userId: "x", capabilityId: "Not A Capability", handbookId: "h", handbook: LESSON }, { userId: "x", capabilityId: "meta-analysis", handbookId: 7, handbook: LESSON }])
      assert.equal((await f.handbooks.consider(/** @type {any} */ (bad))).state, "skipped");
    const broken = createPlatformHandbooks({ service: { get: async () => { throw new Error("down"); }, list: async () => [], save: async () => {} }, supply: {}, facts: async () => ({}), judge: async () => ({}), established: async () => new Set() });
    assert.deepEqual(await broken.consider(lesson("senior-1")), { state: "failed" });
  } finally { await f.cleanup(); }
});

test("the judge is told what general means and the classes it may answer with, and shown the lesson as data", () => {
  const messages = handbookJudgeMessages({ text: "A lesson.", capabilityId: "meta-analysis" });
  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  for (const name of HANDBOOK_LESSON_CLASSES) assert.ok(messages[0].content.includes(name), name);
  assert.match(messages[0].content, /no project, patient, participant, institution, product/);
  assert.equal(messages[1].content, "A lesson.");
});

test("the merge point tells the path a lesson was applied, once, with what it needs; a stale or failed application tells nothing, and a path that throws changes nothing", async () => {
  const f = handbookFixture();
  /** @type {any[]} */ const told = [];
  await f.learning.recordHandbookCandidate("alice", f.input());
  const loop = new HandbookConsolidation({ ...f, registry, onApplied: async (applied) => { told.push(applied); throw new Error("the path is down"); } });
  const result = await loop.run({ job: f.queued[0] });
  assert.equal(result.disposition, "applied");
  assert.equal(told.length, 1);
  assert.deepEqual([told[0].userId, told[0].capabilityId, told[0].sourceProjectId, told[0].runId], ["alice", "geo-content", "source-project", "source-run"]);
  assert.equal(told[0].handbook.body, BODY);
  assert.equal(told[0].handbook.frontmatter.name, frontmatter.name);
  assert.equal((await f.documents.get("alice", "method", result.handbookId)).payload.status, "active", "the handbook stands whatever the path did");
  // A replay of the applied job is not a new application.
  const replay = await loop.run({ job: f.queued[0] });
  assert.equal(replay.handbookId, result.handbookId);
  assert.equal(told.length, 1);
  // A candidate whose capability the source run did not have never applies, so nothing is told.
  const refused = handbookFixture();
  await refused.learning.recordHandbookCandidate("alice", refused.input({ capabilityId: "meta-analysis" }));
  const quiet = new HandbookConsolidation({ ...refused, registry, onApplied: async () => { throw new Error("must not be called"); } });
  assert.equal((await quiet.run({ job: refused.queued[0] })).disposition, "failed");
});

test("the counters are exported as families, and nothing for a path that was not composed", async () => {
  const f = await build();
  try {
    assert.deepEqual(platformHandbookMetricFamilies(f.handbooks.stats()).map((family) => family.name), [
      "open_science_learning_platform_handbooks_total", "open_science_learning_platform_handbooks_rejected_total", "open_science_learning_platform_handbooks_activated_total",
      "open_science_learning_platform_handbooks_reviewer_configured", "open_science_learning_platform_handbooks_harm_checks_total",
      "open_science_learning_platform_handbooks_harm_check_skipped_total", "open_science_learning_platform_handbooks_probation_dispatches_total",
      "open_science_learning_platform_handbooks_probation_share", "open_science_learning_platform_handbooks_per_day"]);
    assert.deepEqual(platformHandbookMetricFamilies(null), []);
  } finally { await f.cleanup(); }
});

/* ---------------------------------------------------- the independent-family harm check (review L14c) */

/** The judge port's answers, as `judgeService.judge` gives them. */
const settled = (/** @type {boolean} */ harmful) => ({ outcome: "settled", code: "judge_settled", value: { harmful } });

test("a lesson the independent judge settles as harmful is not promoted: it is rejected with its reason, counted and written down by entry, and the author's own handbook is untouched", async () => {
  /** @type {any[]} */ const asked = [];
  /** @type {any[]} */ const audited = [];
  const f = await build({ harm: async (input) => { asked.push(input); return settled(true); }, audit: async (event, detail) => { audited.push({ event, ...detail }); } });
  try {
    const handbook = structuredClone({ ...LESSON, files: undefined });
    const before = JSON.stringify(handbook);
    const result = await f.handbooks.consider({ ...lesson("senior-1"), handbook });
    assert.deepEqual([result.state, result.reason], ["rejected", ["harm_flagged"]]);
    assert.equal(JSON.stringify(handbook), before, "the account's handbook, as the platform path was handed it, is not changed");
    // What the judge was shown: the lesson and its capability, nothing of an account, a project or a run.
    assert.equal(asked.length, 1);
    assert.match(asked[0].text, /Keep every denominator tied to the preserved source/);
    assert.deepEqual(Object.keys(asked[0]).sort(), ["capabilityId", "text"]);
    assert.equal(JSON.stringify(asked).includes("senior-1"), false);
    // Not promoted: no corroboration, no re-check, no tool, nothing in the supply.
    const [row] = candidates(f);
    assert.deepEqual([row.payload.status, row.payload.harmChecked.outcome], ["rejected", "flagged"]);
    assert.deepEqual(await f.handbooks.tick(), { judged: 0, rechecked: 0, retired: 0 });
    assert.equal(f.reviewed.length, 0, "a flagged lesson never reaches the re-check");
    assert.equal([...f.rows.values()].some((entry) => entry.payload.recordType === "evolution-tool"), false);
    assert.deepEqual(await f.service.availableTools({ capabilityId: "meta-analysis" }), []);
    // Counted, and in the security ledger by the entry: the account is named by neither.
    assert.deepEqual(f.handbooks.stats().harmChecks, { clear: 0, flagged: 1, uncertain: 0, skipped: 0 });
    assert.equal(f.handbooks.stats().rejectedBy.harm_flagged, 1);
    assert.deepEqual(audited, [{ event: "learning.platform_handbook.harm_flagged", code: "harm_flagged", detail: `capability=meta-analysis entry=${row.id}` }]);
    assert.equal(JSON.stringify(audited).includes("senior-1"), false);
    assert.deepEqual(f.notices, [], "nothing is shown to anyone");
  } finally { await f.cleanup(); }
});

test("a flagged lesson is not a second voice: it does not corroborate another account's lesson of the same class", async () => {
  let harmful = true;
  const f = await build({ harm: async () => settled(harmful) });
  try {
    assert.equal((await f.handbooks.consider(lesson("new-1"))).state, "rejected");
    harmful = false;
    assert.equal((await f.handbooks.consider(lesson("new-2"))).state, "awaiting_corroboration", "the only other voice was refused, so this one waits alone");
    assert.deepEqual(candidates(f).map((row) => row.payload.status).sort(), ["awaiting_corroboration", "rejected"]);
  } finally { await f.cleanup(); }
});

test("a lesson the judge clears goes on exactly as before, and is counted as cleared", async () => {
  const f = await build({ harm: async () => settled(false) });
  try {
    assert.deepEqual(await f.handbooks.consider(lesson("senior-1")), { state: "candidate" });
    assert.deepEqual(await f.handbooks.tick(), { judged: 0, rechecked: 1, retired: 0 });
    const [row] = candidates(f);
    assert.deepEqual([row.payload.status, row.payload.harmChecked.outcome], ["probation", "clear"]);
    assert.deepEqual(f.handbooks.stats().harmChecks, { clear: 1, flagged: 0, uncertain: 0, skipped: 0 });
  } finally { await f.cleanup(); }
});

test("a judge that is not there, not calibrated, off, over budget, broken or unsure flags nothing: promotion goes on as before, and the skipped check is counted by its reason", async () => {
  const cases = [
    ["not composed", null, "skipped", "harm_check_not_composed"],
    ["unconfigured", async () => ({ outcome: "fallback", code: "judge_unconfigured", value: null }), "skipped", "judge_unconfigured"],
    ["uncalibrated", async () => ({ outcome: "fallback", code: "judge_uncalibrated", value: null }), "skipped", "judge_uncalibrated"],
    ["disabled", async () => ({ outcome: "fallback", code: "judge_disabled", value: null }), "skipped", "judge_disabled"],
    ["circuit open", async () => ({ outcome: "fallback", code: "judge_circuit_open", value: null }), "skipped", "judge_circuit_open"],
    ["a fallback with no code", async () => ({ outcome: "fallback", value: null }), "skipped", "harm_check_unanswered"],
    ["a settled answer of the wrong shape", async () => ({ outcome: "settled", value: {} }), "skipped", "harm_check_unanswered"],
    ["over budget", async () => { throw Object.assign(new Error("spent"), { code: "usage_budget_exceeded" }); }, "skipped", "usage_budget_exceeded"],
    ["a failure with no code", async () => { throw new Error("down"); }, "skipped", "harm_check_failed"],
    ["a code that is not a code", async () => { throw Object.assign(new Error("down"), { code: "Not A Code!" }); }, "skipped", "harm_check_failed"],
    ["unsure", async () => ({ outcome: "escalated", code: "judge_uncertain", value: null }), "uncertain", "judge_uncertain"],
  ];
  for (const [label, harm, outcome, code] of cases) {
    const f = await build({ harm });
    try {
      assert.deepEqual(await f.handbooks.consider(lesson("senior-1")), { state: "candidate" }, label);
      const [row] = candidates(f);
      assert.deepEqual([row.payload.status, row.payload.harmChecked.outcome, row.payload.harmChecked.code], ["candidate", outcome, code], label);
      const counts = f.handbooks.stats().harmChecks;
      assert.equal(counts[outcome], 1, label);
      assert.equal(counts.flagged, 0, label);
      if (outcome === "skipped") assert.deepEqual(f.handbooks.stats().harmSkippedBy, { [code]: 1 }, label);
      assert.deepEqual(await f.handbooks.tick(), { judged: 0, rechecked: 1, retired: 0 }, `${label}: the lesson reaches the re-check as it always did`);
    } finally { await f.cleanup(); }
  }
});

test("the harm check is advice about promotion: a ledger that cannot be written, or a judge that throws, does not stop the decision or the loop that told us", async () => {
  const reported = [];
  const f = await build({ harm: async () => settled(true), audit: async () => { throw new Error("ledger full"); }, report: (code) => reported.push(code) });
  try {
    const result = await f.handbooks.consider(lesson("senior-1"));
    assert.deepEqual([result.state, result.reason], ["rejected", ["harm_flagged"]], "the refusal stands without its audit line");
  } finally { await f.cleanup(); }
  const throwing = await build({ harm: async () => { throw new Error("down"); }, report: (code) => reported.push(code) });
  try {
    assert.equal((await throwing.handbooks.consider(lesson("senior-1"))).state, "candidate");
    assert.deepEqual(reported, ["learning_platform_handbook_harm_check_failed"]);
  } finally { await throwing.cleanup(); }
});

test("the harm check counters are exported by outcome and by the reason a check gave no answer", async () => {
  const f = await build({ harm: async () => ({ outcome: "fallback", code: "judge_uncalibrated", value: null }) });
  try {
    await f.handbooks.consider(lesson("senior-1"));
    const families = new Map(platformHandbookMetricFamilies(f.handbooks.stats()).map((family) => [family.name, family]));
    assert.deepEqual(families.get("open_science_learning_platform_handbooks_harm_checks_total")?.series,
      ["clear", "flagged", "uncertain", "skipped"].map((outcome) => ({ value: outcome === "skipped" ? 1 : 0, labels: { outcome } })));
    assert.deepEqual(families.get("open_science_learning_platform_handbooks_harm_check_skipped_total")?.series, [{ value: 1, labels: { reason: "judge_uncalibrated" } }]);
  } finally { await f.cleanup(); }
});

/* ---------------------------------------------------- a lesson on probation is served to a sample of dispatches (review L-6) */

const RUNS = Array.from({ length: 600 }, (_, index) => `run_${index.toString(16).padStart(6, "0")}`);
const dispatch = (/** @type {any} */ f, /** @type {string} */ runId, /** @type {any} */ extra = {}) => f.handbooks.probationFor({ userId: "reader-1", projectId: "reader-project", runId, capabilityId: "meta-analysis", ...extra });

/** A module with `served` recording what it was told, and `count` lessons of one capability brought to probation. @param {number} count @param {Record<string, any>} [over] */
async function onProbation(count, over = {}) {
  /** @type {any[]} */ const exposures = [];
  const f = await build({ served: async (/** @type {any} */ event) => { exposures.push(event); }, ...over });
  for (let index = 0; index < count; index += 1) {
    const author = `senior-${index + 1}`;
    await f.handbooks.consider(lesson(author, { handbook: { contentDigest: `sha256:v${index}`, body: `${LESSON.body}\nLesson variant ${index} of the same kind.` } }));
  }
  await f.handbooks.tick();
  assert.equal(candidates(f).filter((row) => row.payload.status === "probation").length, count);
  return { ...f, exposures };
}

test("a share of the dispatches, chosen by the run id, is handed the entry on probation: the same runs every time, about the share, the exposure recorded for each and for no other", async () => {
  const f = await onProbation(1, { probationShare: 0.1 });
  try {
    const [entry] = candidates(f);
    const handed = [];
    for (const runId of RUNS) if (await dispatch(f, runId)) handed.push(runId);
    assert.ok(Math.abs(handed.length / RUNS.length - 0.1) < 0.04, `${handed.length} of ${RUNS.length}`);
    // A run is in or out for good: asking again about every run gives the same answer.
    const again = [];
    for (const runId of RUNS) if (await dispatch(f, runId)) again.push(runId);
    assert.deepEqual(again, handed);
    // What a served run is handed is the lesson, under the capability it is for, and nothing of an account.
    const first = await dispatch(f, handed[0]);
    assert.deepEqual(first, { entryId: entry.id, version: 1, capabilityId: "meta-analysis", text: entry.payload.text });
    for (const secret of ["senior-1", "p-senior-1", "r-senior-1", "h-senior-1", "reader-1"]) assert.equal(JSON.stringify(first).includes(secret), false, secret);
    // The exposure is recorded for every served dispatch, as a use of the entry's tool by that run, and only for those.
    const toolId = entry.payload.toolId;
    assert.equal(f.exposures.length, handed.length * 2 + 1, "recorded each time it was served");
    assert.deepEqual(f.exposures[0], { userId: "reader-1", projectId: "reader-project", runId: handed[0], toolId, revision: entry.payload.publication.revision, digest: entry.payload.publication.digest, result: { ok: true } });
    assert.deepEqual([...new Set(f.exposures.map((event) => event.runId))].sort(), [...handed].sort());
    // Counted by what came of each dispatch.
    const probation = f.handbooks.stats().probation;
    assert.equal(probation.served, f.exposures.length);
    assert.equal(probation.served + probation.sampledOut, RUNS.length * 2 + 1, "every dispatch asked about is one or the other here");
    assert.deepEqual([probation.noEntry, probation.failed], [0, 0]);
  } finally { await f.cleanup(); }
});

test("a share of one hands it to every dispatch, a share of nothing to none and reads nothing, and without a recorder nothing is handed over", async () => {
  const all = await onProbation(1, { probationShare: 1 });
  try {
    for (const runId of RUNS.slice(0, 50)) assert.ok(await dispatch(all, runId), runId);
    assert.deepEqual(all.handbooks.stats().probation, { served: 50, noEntry: 0, sampledOut: 0, failed: 0 });
  } finally { await all.cleanup(); }
  /** @type {string[]} */ const read = [];
  const none = createPlatformHandbooks({ service: { list: async () => { read.push("list"); return []; }, get: async () => null, save: async () => null }, supply: {}, facts: async () => ({}), judge: async () => ({}),
    established: async () => new Set(), probationShare: 0, served: async () => { read.push("served"); } });
  for (const runId of RUNS.slice(0, 50)) assert.equal(await none.probationFor({ userId: "u", projectId: "p", runId, capabilityId: "meta-analysis" }), null);
  assert.deepEqual(read, [], "a lever at 0 does nothing at all");
  assert.deepEqual(none.stats().probation, { served: 0, noEntry: 0, sampledOut: 0, failed: 0 });
  const unrecorded = await onProbation(1, { probationShare: 1, served: null });
  try {
    assert.equal(await dispatch(unrecorded, RUNS[0]), null, "an exposure nothing could record is not made");
    assert.deepEqual(unrecorded.handbooks.stats().probation, { served: 0, noEntry: 0, sampledOut: 0, failed: 0 });
  } finally { await unrecorded.cleanup(); }
});

test("only an entry on probation for the dispatch's own capability is handed over: not another capability's, not a waiting, rejected, effective or retired one", async () => {
  const f = await onProbation(1, { probationShare: 1 });
  try {
    assert.equal(await dispatch(f, RUNS[0], { capabilityId: "adr-analysis" }), null, "another capability");
    assert.equal(await dispatch(f, RUNS[0], { capabilityId: "" }), null);
    assert.equal(f.handbooks.stats().probation.noEntry, 1);
    // A lesson that is only a candidate, or still waiting, is not on probation yet.
    const waiting = await build({ probationShare: 1, served: async () => {} });
    try {
      await waiting.handbooks.consider(lesson("new-1"));
      await waiting.handbooks.consider(lesson("senior-9", { input: { capabilityId: "adr-analysis" } }));
      assert.deepEqual(candidates(waiting).map((row) => row.payload.status).sort(), ["awaiting_corroboration", "candidate"]);
      assert.equal(await dispatch(waiting, RUNS[0]), null);
      assert.equal(await dispatch(waiting, RUNS[0], { capabilityId: "adr-analysis" }), null);
    } finally { await waiting.cleanup(); }
    // Once it is effective it is the supply's, and a retired one is nobody's.
    const [entry] = candidates(f);
    await f.handbooks.observe({ entryId: entry.id, version: 1, runId: "run-ok", outcome: "useful", evidence: { resultId: "verified-result", attributable: true, independent: true } });
    assert.equal(candidates(f)[0].payload.status, "effective");
    assert.equal(await dispatch(f, RUNS[0]), null, "effective entries are served from the supply, not by this path");
    assert.equal(f.handbooks.stats().probation.noEntry, 2);
    assert.equal(f.exposures.length, 0);
  } finally { await f.cleanup(); }
  const retired = await onProbation(1, { probationShare: 1 });
  try {
    const tool = await retired.service.get(candidates(retired)[0].payload.toolId);
    await retired.service.save("tool", tool.id, { ...tool.payload, status: "retired" }, tool);
    await retired.handbooks.tick();
    assert.equal(candidates(retired)[0].payload.status, "retired");
    assert.equal(await dispatch(retired, RUNS[0]), null);
    assert.equal(retired.exposures.length, 0);
  } finally { await retired.cleanup(); }
});

test("with several entries on probation for a capability the run id picks one: the same one every time, and every entry is reached by some runs", async () => {
  const f = await onProbation(3, { probationShare: 1 });
  try {
    const ids = new Set(candidates(f).map((row) => row.id));
    const picked = new Map();
    for (const runId of RUNS) picked.set(runId, (await dispatch(f, runId)).entryId);
    assert.deepEqual(new Set(picked.values()), ids, "each entry is reached");
    for (const entryId of ids) assert.ok([...picked.values()].filter((id) => id === entryId).length > RUNS.length / 3 - 80, entryId);
    for (const runId of RUNS.slice(0, 100)) assert.equal((await dispatch(f, runId)).entryId, picked.get(runId), `${runId} gets the same entry again`);
    // One entry to a run: each exposure is one run and one tool.
    const byRun = new Map();
    for (const event of f.exposures) byRun.set(event.runId, new Set([...(byRun.get(event.runId) ?? []), event.toolId]));
    assert.ok([...byRun.values()].every((tools) => tools.size === 1));
  } finally { await f.cleanup(); }
});

test("an entry whose text does not fit the room the caller has left is not among those picked from; if none fits, the dispatch is counted as having had no entry", async () => {
  const f = await onProbation(2, { probationShare: 1 });
  try {
    const small = candidates(f).find((row) => row.payload.text.body.includes("variant 0"));
    const fits = (/** @type {{ body: string }} */ text) => text.body.includes("variant 0");
    for (const runId of RUNS.slice(0, 40)) assert.equal((await dispatch(f, runId, { fits })).entryId, small.id, runId);
    assert.equal(await dispatch(f, RUNS[0], { fits: () => false }), null);
    assert.deepEqual(f.handbooks.stats().probation, { served: 40, noEntry: 1, sampledOut: 0, failed: 0 });
    assert.equal(new Set(f.exposures.map((event) => event.toolId)).size, 1, "no exposure was made of the one that did not fit");
  } finally { await f.cleanup(); }
});

test("an exposure that cannot be recorded, or a ledger that cannot be read, hands over nothing, is counted as a failure and is reported - the dispatch is never failed", async () => {
  /** @type {string[]} */ const reported = [];
  const f = await onProbation(1, { probationShare: 1, report: (/** @type {string} */ code) => reported.push(code),
    served: async () => { throw Object.assign(new Error("ledger busy"), { code: "product_revision_conflict" }); } });
  try {
    assert.equal(await dispatch(f, RUNS[0]), null);
    assert.deepEqual(f.handbooks.stats().probation, { served: 0, noEntry: 0, sampledOut: 0, failed: 1 });
    assert.deepEqual(reported.slice(-1), ["learning_platform_handbook_product_revision_conflict"]);
  } finally { await f.cleanup(); }
  const unreadable = createPlatformHandbooks({ service: { list: async () => { throw new Error("down"); } }, supply: {}, facts: async () => ({}), judge: async () => ({}), established: async () => new Set(),
    probationShare: 1, served: async () => {}, report: (code) => reported.push(code) });
  assert.equal(await unreadable.probationFor({ userId: "u", projectId: "p", runId: RUNS[0], capabilityId: "meta-analysis" }), null);
  assert.deepEqual(unreadable.stats().probation, { served: 0, noEntry: 0, sampledOut: 0, failed: 1 });
  assert.deepEqual(reported.slice(-1), ["learning_platform_handbook_probation_failed"]);
});

test("the probation counters and the share are exported as families", async () => {
  const f = await onProbation(1, { probationShare: 0.5 });
  try {
    for (const runId of RUNS.slice(0, 100)) await dispatch(f, runId);
    const families = new Map(platformHandbookMetricFamilies(f.handbooks.stats()).map((family) => [family.name, family]));
    const { served, noEntry, sampledOut, failed } = f.handbooks.stats().probation;
    assert.equal(served + sampledOut, 100);
    assert.ok(served > 20 && sampledOut > 20);
    assert.deepEqual(families.get("open_science_learning_platform_handbooks_probation_dispatches_total")?.series,
      [["served", served], ["no_entry", noEntry], ["sampled_out", sampledOut], ["failed", failed]].map(([result, value]) => ({ value, labels: { result } })));
    assert.deepEqual(families.get("open_science_learning_platform_handbooks_probation_share")?.series, [{ value: 0.5 }]);
  } finally { await f.cleanup(); }
});
