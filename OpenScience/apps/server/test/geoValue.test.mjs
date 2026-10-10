import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openScopedFileNoFollow, resolveScopedPath } from "../src/security.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { geoValueContext, geoValueJudged, mergeGeoValue, geoValueImpacts, summarizeGeoValueCoverage } from "@evimed/domain";
import { buildJudgeInput, verifyJudgement, GEO_JUDGE_INSTRUCTIONS } from "../src/geoJudge.mjs";
import { importGeoValue } from "../src/geoValueImport.mjs";
import { geoRuntimeWrite } from "../src/geoWrites.mjs";
import { GeoService } from "../src/geoService.mjs";

test("partial, conflicting and negative findings survive an incremental update without manufactured fields", () => {
  const first = { scope: { population: "Adults", region: "CN" }, findings: [
    { id: "f1", statement: "No established comparative advantage", dimension: "effectiveness", certainty: "uncertain" },
    { id: "f2", statement: "Reporting signal; causality unknown", dimension: "safety", sourceRefs: ["FAERS"] },
    "Out-of-pocket cost is unknown", null,
  ], customContext: { supply: "intermittent" } };
  const updated = mergeGeoValue(first, { scope: { region: null }, findings: [{ id: "f1", limitations: "No head-to-head trial" }], researchResults: [] });
  assert.equal(updated.findings.length, 4);
  assert.equal(updated.findings[0].statement, first.findings[0].statement);
  assert.equal(updated.scope.population, "Adults");
  assert.equal(updated.scope.region, null);
  assert.deepEqual(updated.customContext, first.customContext);
  assert.equal(updated.score, undefined);
  assert.equal(updated.findings[1].incidence, undefined);
  assert.deepEqual(mergeGeoValue(updated, { findings: [] }).findings, updated.findings);
});

test("an empty list in an amendment keeps what the finding had; a list replaces it and null clears it (D-09)", () => {
  // The skill tells the run an empty list preserves prior work. Only the profile's own collections did: a finding's groupIds, a scope's
  // regions or any other list was replaced by the empty one, and the links to the questions were gone.
  const before = { scope: { regions: ["CN"] }, tags: ["a"],
    findings: [{ id: "f1", statement: "x", groupIds: ["g1"], sourceRefs: ["a"], scope: { regions: ["CN"] } }] };
  const kept = mergeGeoValue(before, { findings: [{ id: "f1", groupIds: [], scope: { regions: [] } }], scope: { regions: [] }, tags: [] });
  assert.deepEqual(kept, before, "nothing changed");
  // A list replaces the earlier one, null clears the field, and the other fields of the finding stay.
  const replaced = mergeGeoValue(before, { findings: [{ id: "f1", groupIds: ["g2"] }] });
  assert.deepEqual(replaced.findings[0], { ...before.findings[0], groupIds: ["g2"] });
  assert.equal(mergeGeoValue(before, { findings: [{ id: "f1", groupIds: null }] }).findings[0].groupIds, null);
  // An empty list where there was nothing says nothing: the finding is as it was, and the write is no change.
  const bare = { findings: [{ id: "f2", statement: "y" }] };
  assert.deepEqual(mergeGeoValue(bare, { findings: [{ id: "f2", groupIds: [] }], tags: [] }), bare);
  // The collections keep behaving as before: an empty one is kept, and an item is amended by its id.
  assert.deepEqual(mergeGeoValue({}, { findings: [] }), { findings: [] });
});

test("a finding written with a key and no id is known by its key as its id, and the judge, the impacts and an amendment find it (D-10)", () => {
  const first = mergeGeoValue({}, { findings: [{ key: "eff-adults", statement: "keyed only" }, { id: "f2", key: "other", statement: "both" }, { statement: "neither" }] });
  assert.deepEqual(first.findings.slice(0, 2).map((finding) => [finding.id, finding.key]), [["eff-adults", "eff-adults"], ["f2", "other"]], "a given id is not replaced");
  assert.equal(first.findings[2].id, undefined, "an item with neither stays as written: the server names it by its content");
  assert.deepEqual(geoValueJudged(first).findings.map((finding) => finding.id), ["eff-adults", "f2"], "the judge is shown it");
  const impacts = geoValueImpacts({ ...first, sourceChanges: [{ id: "c", findingIds: ["eff-adults"] }] });
  assert.deepEqual(impacts[0].findingIds, ["eff-adults"], "a source change that names it by its id reaches it");
  // An amendment by key lands on the same finding, and by id as well.
  const amended = mergeGeoValue(first, { findings: [{ key: "eff-adults", limitations: "adults only" }] });
  assert.equal(amended.findings.length, 3);
  assert.deepEqual(amended.findings[0], { key: "eff-adults", id: "eff-adults", statement: "keyed only", limitations: "adults only" });
  assert.equal(mergeGeoValue(first, { findings: [{ id: "eff-adults", certainty: "low" }] }).findings.length, 3);
  // A finding stored before, with a key and no id, gets its id when it is next amended.
  const legacy = { findings: [{ key: "old", statement: "s" }] };
  assert.deepEqual(mergeGeoValue(legacy, { findings: [{ key: "old", limitations: "l" }] }).findings, [{ key: "old", statement: "s", limitations: "l", id: "old" }]);
});

test("an audience written as a list is matched by any member of it (D-10)", () => {
  const profile = { findings: [{ id: "f", statement: "s", audience: ["caregiver", "pharmacist"] }, { id: "g", statement: "t", audience: "physician" }, { id: "h", statement: "u" }] };
  const ids = (/** @type {string} */ audience) => geoValueContext(profile, { audience }).findings.map((finding) => finding.id);
  assert.deepEqual(ids("caregiver"), ["f", "h"]);
  assert.deepEqual(ids("pharmacist"), ["f", "h"]);
  assert.deepEqual(ids("physician"), ["g", "h"]);
  assert.deepEqual(ids("patient"), ["h"], "a finding for no audience is for all of them");
});

test("source impact follows exact links and tolerates malformed optional observations", () => {
  const impacts = geoValueImpacts({ sourceChanges: [null, "A notice", { id: "change", sourceId: "src-old" }],
    findings: [null, { id: "linked", sources: [{ sourceId: "src-old" }], groupIds: ["g1"] }, { id: "unrelated", sourceRefs: ["other"] }] },
  [{ id: "a1", groupId: "g1" }, { id: "a2", valueContext: { findingIds: ["unrelated"] } }]);
  assert.equal(impacts.length, 1);
  assert.deepEqual(impacts[0].findingIds, ["linked"]);
  assert.deepEqual(impacts[0].articleIds, ["a1"]);
});

test("semantic coverage preserves unknowns and reasonable non-recommendation outside the denominator", () => {
  assert.equal(summarizeGeoValueCoverage([{ status: "uncertain" }, { status: "not_applicable" }]).value, null);
  const summary = summarizeGeoValueCoverage([{ status: "represented" }, { status: "partial" }, { status: "not_applicable" }, {}]);
  assert.equal(summary.assessed, 2);
  assert.equal(summary.value, 50);
});

test("answer interpretation retains clinical conditions, drops fabricated quotations only, and leaves absent observations unknown", () => {
  const input = { owner: { userId: "u", projectId: "p" }, product: {}, competitors: [], careFlags: [],
    claims: [{ id: "c1", statement: "Adults only", quote: "Only adults were enrolled", population: "adults", elements: { comparator: "placebo" } }],
    value: { version: 2, data: { findings: [{ id: "f1", statement: "Benefit uncertain" }, { id: "f2", statement: "Safety signal" }] } },
    question: { text: "Is it appropriate for me?" }, answer: "The benefit remains uncertain; the study enrolled adults." };
  const built = buildJudgeInput(input);
  assert.match(built.prefix, /"population":"adults"/);
  assert.match(built.prefix, /placebo/);
  const judged = verifyJudgement({ statements: [], valueCoverage: [
    { findingId: "f1", status: "represented", quote: "The benefit remains uncertain", conditionsPreserved: true },
    { findingId: "f2", status: "represented", quote: "This medicine is always safe" },
    { findingId: "foreign", status: "not_addressed" },
  ] }, built, input);
  assert.equal(judged.valueBasisVersion, 2);
  assert.equal(judged.valueCoverage.length, 1);
  assert.equal(judged.valueCoverage[0].findingId, "f1");
  assert.deepEqual(verifyJudgement({}, built, input).valueCoverage, []);
});

test("failed specialist runs keep usable reports, optional value JSON is not required", async () => {
  const writes = [];
  await importGeoValue({ store: { writeValue: async (...args) => writes.push(args) }, project: { userId: "u", workspaceDir: "/work" },
    geoProject: { id: "g" }, run: { id: "r1", status: "failed", deliverables: [{ id: "safety-review", capability: "adr-analysis" }] },
    readFile: async (_root, path) => {
      if (path.endsWith("safety-report.md")) return Buffer.from("Reporting signal, not incidence or proof of causality. The requested subgroup could not be calculated.");
      throw new Error("Not produced");
    }, report: () => {} });
  assert.equal(writes.length, 1);
  const result = writes[0][2].researchResults[0];
  assert.equal(result.runStatus, "failed");
  assert.equal(result.verification, "unverified");
  assert.equal(result.materials.length, 1);
  assert.match(result.materials[0].excerpt, /not incidence/);
});

test("a GEO capability's own deliverables are never imported as research; its geo-value.json still is (D-02)", async () => {
  // Four imported programme runs used to put 42 findings and 76 KB of excerpts into every judge prompt.
  for (const capability of ["geo-insight", "geo-strategy", "geo-content", "geo-proposal"]) {
    const writes = [], reads = [];
    await importGeoValue({ store: { writeValue: async (...args) => writes.push(args) }, project: { userId: "u", workspaceDir: "/work" },
      geoProject: { id: "g" }, run: { id: `run-${capability}`, status: "completed", deliverables: [{ id: "pack", capability }] },
      capabilityOutputs: async () => ["claims.json", "question-map.json", "revision-notes.md", "strategy.json"],
      readFile: async (_root, path) => {
        reads.push(path);
        if (path.endsWith("geo-value.json")) return Buffer.from(JSON.stringify({ findings: [{ id: "f1", statement: "Benefit is uncertain in adults" }] }));
        return Buffer.from("An excerpt of the programme's own deliverable. ".repeat(200));
      }, report: () => {} });
    assert.deepEqual(reads, ["deliverables/pack/geo-value.json"], `${capability}: only the value file is read`);
    assert.equal(writes.length, 1, capability);
    assert.deepEqual(Object.keys(writes[0][2]), ["findings"], `${capability}: no researchResults`);
  }
  // Nothing written when the GEO run left no value file.
  const none = [];
  await importGeoValue({ store: { writeValue: async (...args) => none.push(args) }, project: { userId: "u", workspaceDir: "/work" }, geoProject: { id: "g" },
    run: { id: "run-quiet", status: "completed", deliverables: [{ id: "pack", capability: "geo-content" }] },
    readFile: async (_root, path) => { if (path.endsWith("geo-value.json")) throw new Error("Not produced"); return Buffer.from("article text"); }, report: () => {} });
  assert.deepEqual(none, []);
  // A specialist's report, on the other hand, is the research the next turn reuses.
  const research = [];
  await importGeoValue({ store: { writeValue: async (...args) => research.push(args) }, project: { userId: "u", workspaceDir: "/work" }, geoProject: { id: "g" },
    run: { id: "run-research", status: "completed", deliverables: [{ id: "review", capability: "comprehensive-drug-evaluation" }] },
    readFile: async (_root, path) => { if (path.endsWith("report.md")) return Buffer.from("A usable synthesis."); throw new Error("Not produced"); }, report: () => {} });
  assert.equal(research[0][2].researchResults[0].capabilityId, "comprehensive-drug-evaluation");
});

test("the judge is shown the scope, the summary and the findings of a profile, not its research reports or the rest (D-02)", () => {
  const excerpt = "EXCERPT-OF-A-LONG-REPORT ".repeat(240);
  const data = { scope: { population: "adults" }, summary: "Benefit uncertain", findings: [{ id: "f1", statement: "Benefit uncertain" }, { statement: "no id" }],
    researchResults: [{ id: "run:1:a", materials: [{ path: "a/report.md", excerpt }] }, { id: "run:2:a", materials: [{ path: "b/report.md", excerpt }] }],
    landscape: [{ id: "l1", statement: "Three alternatives" }], decisions: [{ id: "d1" }], lessons: [{ id: "n1", text: "LESSON" }], sourceChanges: [{ id: "c1" }] };
  const input = { owner: { userId: "u", projectId: "p" }, product: {}, competitors: [], careFlags: [], claims: [], value: { version: 3, data },
    question: { text: "Is it appropriate for me?" }, answer: "The benefit remains uncertain." };
  const built = buildJudgeInput(input);
  const project = JSON.parse(built.prefix.slice(built.prefix.indexOf("{")));
  assert.deepEqual(Object.keys(project.value), ["scope", "summary", "findings"]);
  assert.deepEqual(project.value.findings, [{ id: "f1", statement: "Benefit uncertain" }], "only a finding the judge can answer for by id");
  assert.equal(built.prefix.includes("EXCERPT-OF-A-LONG-REPORT") || built.prefix.includes("LESSON"), false);
  assert.ok(built.prefix.length < 2_000, `the prefix does not grow with the research reports (${built.prefix.length})`);
  assert.deepEqual(built.valueFindings.map((entry) => entry.id), ["f1"]);
  // At most sixty findings, as before.
  const many = buildJudgeInput({ ...input, value: { version: 3, data: { findings: Array.from({ length: 80 }, (_, index) => ({ id: `f${index}`, statement: "x" })) } } });
  assert.equal(many.valueFindings.length, 60);
});

test("declared specialist artifacts are reusable while unsafe paths remain outside the import", async () => {
  const writes = [], reads = [];
  await importGeoValue({ store: { writeValue: async (...args) => writes.push(args) },
    project: { userId: "u", workspaceDir: "/work" }, geoProject: { id: "g" },
    run: { id: "r2", status: "failed", effectiveAgentId: "meta-analysis", deliverables: [{ id: "meta", capability: "" }] },
    capabilityOutputs: async (id) => {
      assert.equal(id, "meta-analysis");
      return ["meta-analysis-report.md", "meta-analysis-run.json", "../secret.txt", "/outside.md", "plot.png"];
    },
    readFile: async (_root, path) => {
      reads.push(path);
      if (path.endsWith("meta-analysis-report.md")) return Buffer.from("Usable synthesis; subgroup unavailable.");
      if (path.endsWith("meta-analysis-run.json")) return Buffer.from('{"status":"partial"}');
      throw new Error("Not produced");
    }, report: () => {} });
  assert.equal(writes[0][2].researchResults[0].materials.length, 2);
  assert.ok(reads.every(path => !path.includes("secret") && !path.includes("outside") && !path.includes("plot")));
});

/**
 * A store double whose coverage read answers as the SQL does (D-08): the observation counts by (value basis, status), and the first
 * observations of each basis. The SQL itself is exercised against a real database in geoValue.integration.test.mjs.
 * @param {Array<{ basis: number, entries: Array<Record<string, any>>, engine?: string, roundId?: string }>} facts @param {{ filter?: any }} [received]
 */
const coverageRead = (facts, received = {}) => async (/** @type {string} */ _id, /** @type {any} */ filter) => {
  received.filter = filter;
  /** @type {Map<string, { basisVersion: number, status: string, n: number }>} */
  const counts = new Map();
  const sample = [];
  for (const fact of facts) {
    for (const entry of fact.entries) {
      const key = `${fact.basis}:${entry.status}`;
      counts.set(key, { basisVersion: fact.basis, status: entry.status, n: (counts.get(key)?.n ?? 0) + 1 });
      sample.push({ ...entry, engine: fact.engine ?? "deepseek", roundId: fact.roundId ?? null, basisVersion: fact.basis, rubricVersion: null, askedAt: null });
    }
  }
  return { counts: [...counts.values()], sample };
};

test("coverage never combines different value bases and passes audience/group/engine scope to the measurement read", async () => {
  const received = {};
  const store = { latestValue: async () => ({ version: 2, data: { findings: [] } }), researchRequests: async () => [], listArticles: async () => [],
    valueCoverage: coverageRead([1, 2].map(version => ({ basis: version, entries: [{ findingId: "f1", status: "represented" }] })), received) };
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const value = await service.valueOf({ id: "g" }, { groupId: "group", audience: "caregiver", engine: "deepseek" });
  assert.equal(value.coverage.assessed, 1);
  assert.equal(value.coverage.basisVersion, 2);
  assert.ok(value.observations.every(observation => observation.basisVersion === 2));
  assert.deepEqual(received.filter, { engine: "deepseek", groupId: "group", audience: "caregiver" });
});

test("a profile written after the round keeps that round's coverage, read against the basis it was judged on", async () => {
  // The round froze value version 2; a research import then wrote version 3. Before the fix the page
  // filtered on the latest version and showed nothing until the next round.
  const store = { latestValue: async (_id, version) => ({ version: version ?? 3, data: { findings: [] } }), researchRequests: async () => [], listArticles: async () => [],
    valueCoverage: coverageRead([{ basis: 2, engine: "kimi", roundId: "r1", entries: [{ findingId: "f1", status: "represented" }, { findingId: "f2", status: "partial" }] }]) };
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const current = await service.valueOf({ id: "g" });
  assert.equal(current.version, 3);
  assert.equal(current.coverage.basisVersion, 2, "the coverage says which profile version it measured");
  assert.equal(current.coverage.assessed, 2);
  assert.equal(current.observations.length, 2);
  const asked = await service.valueOf({ id: "g" }, { version: 3 });
  assert.equal(asked.coverage.assessed, 0, "a version asked for is read only against itself");
  assert.equal(asked.coverage.basisVersion, 3);
});

test("the reply carries a bounded sample of the observations and their total; the counts are over all of them (D-08)", async () => {
  const entries = [...Array.from({ length: 300 }, (_, index) => ({ findingId: `f${index % 20}`, status: index % 3 === 0 ? "not_applicable" : "represented" })),
    ...Array.from({ length: 40 }, (_, index) => ({ findingId: `f${index % 20}`, status: "partial" }))];
  const store = { latestValue: async () => ({ version: 1, data: { findings: [] } }), researchRequests: async () => [], listArticles: async () => [],
    valueCoverage: coverageRead([{ basis: 1, entries }]) };
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const value = await service.valueOf({ id: "g" });
  assert.equal(value.observationsTotal, 340, "the total is every observation on the basis");
  assert.equal(value.observations.length, 20, "and the reply carries twenty of them");
  assert.deepEqual([value.coverage.assessed, value.coverage.represented, value.coverage.partial, value.coverage.notApplicable], [240, 200, 40, 100],
    "the counts are over every observation, not the twenty");
  const empty = await new GeoService({ store: { ...store, latestValue: async () => ({ version: 0, data: {} }) }, config: { geoEnabled: true, geoAudience: "all" } }).valueOf({ id: "g" });
  assert.deepEqual([empty.observations, empty.observationsTotal, empty.coverage.basisVersion], [[], 0, null], "no profile, no coverage");
});

test("judge output contract requests semantic assessments and refusals cannot become measured omissions", () => {
  const schema = JSON.parse(GEO_JUDGE_INSTRUCTIONS.split("\n").at(-1));
  assert.ok(Array.isArray(schema.valueCoverage));
  const input = { owner: { userId: "u", projectId: "p" }, product: {}, competitors: [], careFlags: [], claims: [],
    value: { version: 3, data: { findings: [{ id: "benefit", statement: "Adult evidence is uncertain" }] } },
    question: { text: "What is known?" }, answer: "I cannot provide medical advice." };
  const built = buildJudgeInput(input);
  const result = verifyJudgement({ refusal: true, valueCoverage: [{ findingId: "benefit", status: "not_addressed" }] }, built, input);
  assert.equal(result.valueCoverage[0].status, "uncertain");
  assert.equal(summarizeGeoValueCoverage(result.valueCoverage).value, null);
  assert.deepEqual(verifyJudgement({ refusal: true }, built, input).valueCoverage, []);
});


test("explicitly lost clinical conditions cannot count as fully represented value", () => {
  const input = { owner: { userId: "u", projectId: "p" }, product: {}, competitors: [], careFlags: [], claims: [],
    value: { version: 2, data: { findings: [{ id: "benefit", statement: "Low certainty benefit in adults" }] } },
    question: { text: "Who benefits?" }, answer: "It may help." };
  const judged = verifyJudgement({ valueCoverage: [{ findingId: "benefit", status: "represented", quote: "It may help.", conditionsPreserved: false }] }, buildJudgeInput(input), input);
  assert.equal(judged.valueCoverage[0].status, "partial");
  assert.equal(summarizeGeoValueCoverage(judged.valueCoverage).value, 0);
});


test("article registration rejects only nonexistent files and keeps available partial drafts", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "geo-article-existing-"));
  await fs.mkdir(path.join(workspace, "deliverables/d/articles"), { recursive: true });
  await fs.writeFile(path.join(workspace, "deliverables/d/articles/present.md"), "Partial supported draft");
  await fs.writeFile(path.join(workspace, "deliverables/d/articles/empty.md"), "");
  await fs.symlink("present.md", path.join(workspace, "deliverables/d/articles/symlink.md"));
  const registered = [];
  const store = { claimIds: async () => [], query: async () => ({ rows: [] }),
    registerArticles: async (_user, _project, articles) => { registered.push(...articles); return articles.map((_, i) => String(i)); } };
  const result = await geoRuntimeWrite({ store, project: { id: "g", userId: "u" }, what: "articles",
    body: { items: ["absent", "present", "empty", "symlink"].map(name => ({ path: `deliverables/d/articles/${name}.md`, layer: "correction", safety: "clear", contentSha256: "a".repeat(64) })) },
    articleExists: async (_project, relative) => {
      let opened;
      try { opened = await openScopedFileNoFollow(workspace, resolveScopedPath(workspace, relative)); const stat = await opened.handle.stat(); return stat.isFile() && stat.size > 0; }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
      finally { await opened?.handle.close(); }
    } });
  assert.equal(result.ok, true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].path, "deliverables/d/articles/present.md");
  assert.equal(registered[0].gate, "unverified");
  assert.ok(result.issues.filter(issue => issue.code === "not_found").length >= 2);
  assert.ok(result.issues.some(issue => issue.code === "unavailable"));
  await fs.rm(workspace, { recursive: true, force: true });
});

/** The shared drug-value method, as a GEO run reads it. */
const drugValueSkill = async () => (await import("node:fs/promises")).readFile(new URL("../../../capability-skills/geo-drug-value/SKILL.md", import.meta.url), "utf8");

test("the drug-value skill tells a run to list the knowledge-base file a finding rests on by its src_ id (D-19)", async () => {
  // A replaced file reaches a finding only through that id (geoValueImpacts); the skill used to say nothing of it.
  const skill = await drugValueSkill();
  assert.match(skill, /`src_\.\.\.`/);
  assert.match(skill, /`sourceRefs`/);
});
