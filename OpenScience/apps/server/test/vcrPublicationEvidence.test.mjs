// A number a paper reports, bound to the paper by its PMID or DOI (2026-11-01: a median OS read from a PubMed abstract had nowhere to go but
// an "assumed" expert card). The quotation is held against the text the platform itself read of the paper, a capture a literature tool
// preserved in the project's workspace; a paper it has not read, or a sentence not in what it read, is a number kept and marked unchecked.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";
import { VcrEvidenceStore } from "../src/vcrEvidenceStore.mjs";
import { createVcrPublicationSources, doiSlug, vcrPublicationId } from "../src/vcrPublicationSources.mjs";
import { verifyLiteratureBaseline } from "../src/vcrEvidenceSources.mjs";

const sha = (/** @type {string | Buffer} */ bytes) => createHash("sha256").update(bytes).digest("hex");
const ABSTRACT = [
  "# FDA Approval Summary: Tremelimumab in Combination with Durvalumab", "", "- PMID: 37676259", "- DOI: 10.1158/1078-0432.ccr-23-2124", "",
  "## Abstract", "", "The median OS was 16.4 months (95% CI, 14.2–19.6) with tremelimumab in combination with durvalumab and 13.8 months (95% CI, 12.3–16.1) with sorafenib.", "",
].join("\n");
const QUOTE = "13.8 months (95% CI, 12.3–16.1) with sorafenib";

/** Preserve one artifact the way `immutable_capture.preserve` does: a directory named for the digest of its manifest, the manifest last. */
async function preserve(/** @type {string} */ workspace, /** @type {string} */ root, /** @type {string} */ name, /** @type {string} */ text) {
  const hashes = { [name]: sha(text) };
  const version = sha(JSON.stringify(hashes));
  const directory = path.join(workspace, root, version);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, name), text);
  await fs.writeFile(path.join(directory, "capture.json"), JSON.stringify({ version, artifacts: hashes }));
  return { version, directory };
}

async function workspaceWith(/** @type {Array<[string, string, string]>} */ captures) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-pub-"));
  for (const [root, name, text] of captures) await preserve(workspace, root, name, text);
  return workspace;
}

const item = (/** @type {Record<string, any>} */ more = {}) => ({
  publication: { kind: "pmid", id: "37676259" }, parameter: "control_median_os", arm: "sorafenib", armRole: "control", value: 13.8, unit: "months", ciLow: 12.3, ciHigh: 16.1,
  valueSource: "extracted", quote: QUOTE, endpointKey: "os", evidenceKind: "outcome", ...more,
});

function pipelineOver(/** @type {string} */ workspace) {
  /** @type {any[]} */ const saved = [];
  const pipeline = createVcrEvidencePipeline({ store: { async appendEvidenceItems(/** @type {any} */ input) { saved.push(...input.items); return { ids: input.items.map((/** @type {any} */ _, /** @type {number} */ at) => `evd_${saved.length - input.items.length + at + 1}`) }; } } });
  pipeline.attachPublications(createVcrPublicationSources({ resolveProject: async () => ({ workspaceDir: workspace }) }));
  return { pipeline, saved, add: (/** @type {Record<string, any>} */ more) => pipeline.addEvidenceItem({ userId: "u1", studyId: "std_1", projectId: "default", item: item(more) }) };
}

test("a PMID or a DOI is read from the forms a model writes, and nothing else is an identifier", () => {
  assert.deepEqual(vcrPublicationId("37676259"), { kind: "pmid", id: "37676259" });
  assert.deepEqual(vcrPublicationId("PMID: 37676259"), { kind: "pmid", id: "37676259" });
  assert.deepEqual(vcrPublicationId({ pmid: 37676259 }), { kind: "pmid", id: "37676259" });
  assert.deepEqual(vcrPublicationId("10.1056/NEJMoa1915745"), { kind: "doi", id: "10.1056/nejmoa1915745" });
  assert.deepEqual(vcrPublicationId("https://doi.org/10.1056/NEJMoa1915745"), { kind: "doi", id: "10.1056/nejmoa1915745" });
  assert.deepEqual(vcrPublicationId({ doi: "doi:10.1056/NEJMoa1915745." }), { kind: "doi", id: "10.1056/nejmoa1915745" });
  for (const bad of ["", "HIMALAYA", "NCT03434379", "1234567890", "10.1056", null, undefined, 3.5, [], {}]) assert.equal(vcrPublicationId(bad), null, String(bad));
  assert.equal(doiSlug("10.1056/nejmoa1915745"), "10.1056-nejmoa1915745");
});

test("the reader finds the preserved abstract by PMID and the full text or the abstract's DOI line by DOI, and finds nothing for a paper the platform has not read", async () => {
  const workspace = await workspaceWith([
    [".evimed-sources/pubmed/PMID37676259", "abstract.md", ABSTRACT],
    [".evimed-sources/10.1056-nejmoa1915745", "fulltext.md", "Full text. Median OS 19.2 months."],
  ]);
  const reader = createVcrPublicationSources({ resolveProject: async () => ({ workspaceDir: workspace }) });
  const pmid = await reader.read({ userId: "u1", projectId: "default", publication: { kind: "pmid", id: "37676259" } });
  assert.equal(pmid.found, true);
  assert.equal(pmid.contentLevel, "abstract");
  assert.equal(pmid.text, ABSTRACT);
  assert.equal(pmid.sourceRef, "https://pubmed.ncbi.nlm.nih.gov/37676259/");
  assert.equal((await reader.read({ userId: "u1", projectId: "default", publication: { kind: "doi", id: "10.1056/nejmoa1915745" } })).contentLevel, "full_text");
  const byLine = await reader.read({ userId: "u1", projectId: "default", publication: { kind: "doi", id: "10.1158/1078-0432.ccr-23-2124" } });
  assert.equal(byLine.found, true, "the DOI is on the abstract's header line");
  assert.equal(byLine.contentLevel, "abstract");
  assert.deepEqual(await reader.read({ userId: "u1", projectId: "default", publication: { kind: "pmid", id: "1" } }), { found: false });
  assert.deepEqual(await reader.read({ userId: "u1", projectId: "default", publication: { kind: "doi", id: "10.9999/none" } }), { found: false });
  // a capture edited after it was preserved is not a source
  const edited = await workspaceWith([[".evimed-sources/pubmed/PMID5", "abstract.md", "an abstract"]]);
  const [version] = await fs.readdir(path.join(edited, ".evimed-sources/pubmed/PMID5"));
  await fs.writeFile(path.join(edited, ".evimed-sources/pubmed/PMID5", version, "abstract.md"), "an abstract that says something else");
  assert.deepEqual(await createVcrPublicationSources({ resolveProject: async () => ({ workspaceDir: edited }) }).read({ userId: "u1", projectId: "default", publication: { kind: "pmid", id: "5" } }), { found: false });
  // no workspace at all
  assert.deepEqual(await createVcrPublicationSources({ resolveProject: async () => null }).read({ userId: "u1", projectId: "default", publication: { kind: "pmid", id: "1" } }), { found: false });
  await Promise.all([workspace, edited].map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

test("a sentence found in the text the platform read is a verified value of the paper; one it cannot find, a paper it never read, or a computed value is kept as reported and unchecked", async () => {
  const workspace = await workspaceWith([[".evimed-sources/pubmed/PMID37676259", "abstract.md", ABSTRACT]]);
  const { saved, add } = pipelineOver(workspace);

  const verified = await add({});
  assert.equal(verified.state, "verified");
  assert.deepEqual(verified.publication, { kind: "pmid", id: "37676259", read: true, contentRead: "abstract" });
  assert.equal(saved[0].value, 13.8);
  assert.equal(saved[0].locator.kind, "publication_text");
  assert.equal(saved[0].locator.verification, "verified");
  assert.equal(saved[0].locator.contentLevel, "abstract");
  assert.equal(saved[0].detail.sourceStanding, "article_reported");
  assert.equal(saved[0].detail.trialIdentity, null, "a paper's number is never pooled: it names no trial");
  assert.equal(saved[0].sourceRef, "https://pubmed.ncbi.nlm.nih.gov/37676259/", "the place the number was read is an address a reader can open");
  assert.match(saved[0].locator.sourceHash, /^[0-9a-f]{64}$/, "and the capture it was held against is on the locator");

  // a sentence that is not in what was read (the number is in the full text, say): kept, marked, never verified
  const absent = await add({ quote: "the median OS was 13.8 months in the control arm of the full report" });
  assert.equal(absent.state, "reported_unverified");
  assert.equal(absent.because, "quote_not_found");
  const second = saved[1];
  assert.equal(second.value, 13.8, "the number is kept");
  assert.equal(second.ciLow, 12.3);
  assert.equal(second.locator.verification, "reported_unverified");
  assert.equal(second.locator.verificationDetail, "quote_not_found");
  assert.equal(second.detail.sourceStanding, "article_reported_unverified");

  // a number the quotation does not carry: the sentence is in the text and the number is not in the sentence. The source contradicts it, so
  // it is refused as a registry's would be (stored with no number), not kept as a paper's number
  const wrongNumber = await add({ value: 14.9 });
  assert.equal(wrongNumber.state, "quote_missing_number");
  assert.equal(saved[2].value, null);
  assert.equal(saved[2].locator.verification, "quote_not_found");

  // a paper the platform has not read
  const unread = await add({ publication: { kind: "pmid", id: "99999999" } });
  assert.equal(unread.state, "reported_unverified");
  assert.equal(unread.because, "publication_not_read");
  assert.deepEqual(unread.publication, { kind: "pmid", id: "99999999", read: false });
  assert.equal(saved[3].locator.path, undefined);
  assert.equal(saved[3].sourceRef, "https://pubmed.ncbi.nlm.nih.gov/99999999/");

  // a value computed from a paper's numbers is never called verified
  const computed = await add({ valueSource: "calculated", locator: { inputs: [QUOTE] } });
  assert.equal(computed.state, "reported_unverified");
  assert.equal(computed.because, "calculated_from_publication");

  // a paper that does not report the parameter: an answer of its own, no number
  const none = await add({ notReported: true, value: undefined, ciLow: undefined, ciHigh: undefined, unit: undefined, quote: "Table 2 reports no medians." });
  assert.equal(none.state, "not_reported");
  assert.equal(saved[5].locator.verification, "not_reported");
  assert.equal(saved[5].locator.kind, "publication_text");
  await fs.rm(workspace, { recursive: true, force: true });
});

test("no reader of verified evidence reads a number that was not checked; the one reader of citable evidence reads it, and only that", async () => {
  // the store's own predicates, over a stub that applies the SQL's filter in code
  const rows = [
    { id: "a", value: 1, locator: { verification: "verified" } }, { id: "b", value: 2, locator: { verification: "reported_unverified" } },
    { id: "c", value: null, locator: { verification: "quote_not_found" } }, { id: "d", value: 3, locator: { verification: "not_reported" } },
  ];
  const store = Object.create(VcrEvidenceStore.prototype);
  /** @type {string[]} */ const asked = [];
  store.rows = async (/** @type {string} */ sql) => { asked.push(sql); return rows; };
  await store.citableEvidenceIds({ userId: "u", studyId: "s", parameter: "p" });
  await store.verifiedEvidenceIds({ userId: "u", studyId: "s", parameter: "p" });
  assert.match(asked[0], /IN \('verified', 'reported_unverified'\)/);
  assert.match(asked[1], /= 'verified'/);
  assert.doesNotMatch(asked[1], /reported_unverified/);
  // pooling takes `verified` only
  const { poolEligibility } = await import("../src/vcrEvidence.mjs");
  const verdict = poolEligibility({ items: [{ id: "b", value: 2, locator: { verification: "reported_unverified" }, historical_baseline: true, endpoint_key: "os", arm_role: "control" }], endpointKey: "os", armRole: "control" });
  assert.deepEqual(verdict.refused[0].reasons.slice(0, 1), ["quote_not_verified"]);
  // and a baseline statistic is not bound to a publication's number, verified or not
  const baseline = await verifyLiteratureBaseline({ store: { verifiedItemsById: async () => [{ id: "e", parameter: "age.mean", value: 62, unit: "year", value_source: "extracted", enrollment_kind: null,
    detail: { evidenceKind: "baseline" }, locator: { kind: "publication_text", verification: "verified" } }] }, userId: "u", studyId: "s",
  baselineTable: [{ variable: "age", mean: 62 }], bindings: [{ variable: "age", field: "mean", evidenceId: "e", unit: "year" }] });
  assert.equal(baseline.ok, false);
  assert.ok(baseline.issues.some((/** @type {any} */ issue) => issue.code === "baseline_source_unit_unverified"));
});
