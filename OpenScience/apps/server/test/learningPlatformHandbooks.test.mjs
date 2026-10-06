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
      "open_science_learning_platform_handbooks_reviewer_configured", "open_science_learning_platform_handbooks_per_day"]);
    assert.deepEqual(platformHandbookMetricFamilies(null), []);
  } finally { await f.cleanup(); }
});
