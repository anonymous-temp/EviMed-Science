// Retraction and correction notices beside each cited source in the reader:
// one batched Crossref lookup, cached, bounded, and never a verdict.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCommandRegistry } from "../src/commands.mjs";
import { attachSourceUpdates, createSourceUpdateLookup, sourceUpdateMetricFamilies } from "../src/sourceUpdates.mjs";

// The Crossref answers recorded 2026-09-19 (see the domain's fixture).
const recorded = JSON.parse(await readFile(new URL("../../../packages/domain/test/fixtures/crossref/updates.json", import.meta.url), "utf8"));

/** A Crossref stand-in that answers `works?filter=doi:…` from a table of works. */
function crossref(works, { fail = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    if (fail) return new Response("upstream down", { status: 503 });
    const wanted = new URL(String(url)).searchParams.get("filter").split(",").map((part) => part.replace(/^doi:/, ""));
    const items = works.filter((work) => wanted.includes(String(work.DOI).toLowerCase()));
    return Response.json({ status: "ok", message: { items } });
  };
  return { fetchImpl, requests };
}

test("cited DOIs are looked up together, answered from the cache after, and unknown ones remembered", async () => {
  let clock = 0;
  const { fetchImpl, requests } = crossref(recorded.batch);
  const sources = createSourceUpdateLookup({ fetchImpl, userAgent: "EviMedBot/1.0 (+test)", now: () => clock });
  const first = await sources.lookup([
    "10.1016/S0140-6736(97)11096-0", "https://doi.org/10.1056/NEJMoa2204233", "10.9999/datacite.unknown", "not-a-doi", "10.1234/a,b",
  ]);
  assert.equal(requests.length, 1);
  const asked = requests[0].url;
  assert.equal(asked.origin + asked.pathname, "https://api.crossref.org/works");
  assert.equal(asked.searchParams.get("filter"), "doi:10.1016/s0140-6736(97)11096-0,doi:10.1056/nejmoa2204233,doi:10.9999/datacite.unknown");
  assert.equal(asked.searchParams.get("select"), "DOI,updated-by");
  assert.equal(requests[0].init.headers["user-agent"], "EviMedBot/1.0 (+test)");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(first.get("10.1016/s0140-6736(97)11096-0")[0].kind, "retraction");
  assert.deepEqual(first.get("10.1056/nejmoa2204233"), []);
  assert.equal(first.has("10.9999/datacite.unknown"), false, "Crossref did not answer for it, so nothing is said about it");

  const again = await sources.lookup(["10.1016/s0140-6736(97)11096-0", "10.9999/datacite.unknown"]);
  assert.equal(requests.length, 1, "a DOI answered or unknown within the day is not asked again");
  assert.equal(again.get("10.1016/s0140-6736(97)11096-0")[0].kind, "retraction");
  clock += 13 * 60 * 60 * 1000;
  await sources.lookup(["10.1016/s0140-6736(97)11096-0"]);
  assert.equal(requests.length, 2, "half a day later it is fresh news again");
  assert.deepEqual(sources.stats(), { checked: 3, cached: 2, unknown: 1, failed: 0, cachedDois: 3 });
});

test("a failing Crossref says nothing, is not remembered, and is counted", async () => {
  const { fetchImpl, requests } = crossref([], { fail: true });
  const sources = createSourceUpdateLookup({ fetchImpl, userAgent: "EviMedBot/1.0 (+test)" });
  assert.equal((await sources.lookup(["10.1016/s0140-6736(97)11096-0"])).size, 0);
  await sources.lookup(["10.1016/s0140-6736(97)11096-0"]);
  assert.equal(requests.length, 2);
  const [family] = sourceUpdateMetricFamilies(sources.stats());
  assert.equal(family.series.find((item) => item.labels.outcome === "failed").value, 2);

  const hanging = createSourceUpdateLookup({
    userAgent: "x", timeoutMs: 50,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
  });
  const started = Date.now();
  assert.equal((await hanging.lookup(["10.1016/s0140-6736(97)11096-0"])).size, 0);
  assert.ok(Date.now() - started < 2_000, "a slow Crossref does not hold the reader");
});

test("each source's DOI comes from its identifier, its address, or the capture it quotes", async () => {
  const verdict = { claims: [
    { claimId: "CLM-001", claimType: "direct", sources: [{ artifactPath: null, status: "no_quote" }] },
    { claimId: "CLM-002", claimType: "synthesized", sources: [
      { artifactPath: ".evimed-sources/10.1056-nejmoa2204233/v/fulltext.md", status: "verified" },
      { artifactPath: ".evimed-sources/web-pages/x/v/page.md", status: "verified" },
    ] },
  ] };
  const matrix = { claims: [
    { claimId: "CLM-001", identifier: "DOI:10.1016/S0140-6736(97)11096-0" },
    { claimId: "CLM-002", supportingSources: [{ identifier: "PMID:12345" }, { sourceUrl: "https://www.nice.org.uk/guidance/ng136" }] },
  ] };
  const sourceArtifacts = {
    ".evimed-sources/10.1056-nejmoa2204233/v/fulltext.md": "# Open-access article\n\n- DOI: 10.1056/nejmoa2204233\n- Read by the document parser\n\nText.",
  };
  const asked = [];
  const lookup = async (dois) => {
    asked.push(...dois);
    return new Map([
      ["10.1016/s0140-6736(97)11096-0", [{ kind: "retraction", noticeDoi: "10.1016/s0140-6736(10)60175-4", date: "2010-02-06", source: "retraction-watch" }]],
      ["10.1056/nejmoa2204233", []],
    ]);
  };
  await attachSourceUpdates(verdict, { matrix, sourceArtifacts, lookup });
  assert.deepEqual(asked, ["10.1016/s0140-6736(97)11096-0", "10.1056/nejmoa2204233"]);
  assert.equal(verdict.claims[0].sources[0].updates[0].kind, "retraction");
  assert.equal(verdict.claims[0].sources[0].doi, "10.1016/s0140-6736(97)11096-0");
  assert.deepEqual(verdict.claims[1].sources[0].updates, []);
  assert.equal("updates" in verdict.claims[1].sources[1], false, "a page with no DOI carries no notice field at all");

  const untouched = structuredClone(verdict);
  await attachSourceUpdates(untouched, { matrix, sourceArtifacts, lookup: async () => { throw new Error("down"); } });
  assert.deepEqual(untouched, verdict);
});

test("the reader's verification carries the notices and keeps its verdicts; off, it carries none", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-source-updates-"));
  const workspaceDir = path.join(root, "workspace");
  const project = { id: "p1", userId: "u1", rootDir: root, workspaceDir, baseDir: workspaceDir };
  const config = { maxFileBytes: 2_000_000 };
  const QUOTE = "Ileal-lymphoid-nodular hyperplasia was found in children.";
  try {
    const capture = path.join(workspaceDir, ".evimed-sources", "10.1016-s0140-6736-97-11096-0", "v1");
    await mkdir(capture, { recursive: true });
    await mkdir(path.join(workspaceDir, "deliverables", "review"), { recursive: true });
    await writeFile(path.join(capture, "fulltext.md"), `# Article\n\n- DOI: 10.1016/s0140-6736(97)11096-0\n\n${QUOTE}\n`, "utf8");
    const matrix = { claims: [{
      claimId: "CLM-001", claim: "a", claimType: "direct", sourceTitle: "Wakefield 1998", identifier: "DOI:10.1016/S0140-6736(97)11096-0",
      accessLevel: "full_text", artifactPath: ".evimed-sources/10.1016-s0140-6736-97-11096-0/v1/fulltext.md", supportQuote: QUOTE,
    }] };
    const matrixPath = "deliverables/review/clinical-evidence-matrix.json";
    await writeFile(path.join(workspaceDir, matrixPath), JSON.stringify(matrix), "utf8");
    const { fetchImpl } = crossref([recorded.retracted]);
    const sourceUpdates = createSourceUpdateLookup({ fetchImpl, userAgent: "x" });
    const verdict = await createCommandRegistry({ config, runtimeManager: {}, sourceUpdates })
      .invoke("claim_verification", { path: matrixPath }, { config, project });
    assert.equal(verdict.claims[0].status, "verified", "a retracted source's quotation is still found; the notice is beside it, not instead of it");
    assert.deepEqual(verdict.claims[0].sources[0].updates.map((update) => update.kind), ["retraction", "correction"]);

    const off = await createCommandRegistry({ config, runtimeManager: {} }).invoke("claim_verification", { path: matrixPath }, { config, project });
    assert.equal("updates" in off.claims[0].sources[0], false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
