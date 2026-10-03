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

  // A hung request holds its socket, and the socket holds the event loop; the
  // stand-in holds it the same way until it is aborted. Without that, the only
  // thing pending is the lookup's own deadline — an `AbortSignal.timeout`,
  // whose timer Node never refs — and Node 22's test runner (CI's, and
  // production's Node) cancels the file there; Node 24's waits.
  const hanging = createSourceUpdateLookup({
    userAgent: "x", timeoutMs: 50,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      const socket = setInterval(() => {}, 60_000);
      init.signal.addEventListener("abort", () => {
        clearInterval(socket);
        reject(init.signal.reason);
      }, { once: true });
    }),
  });
  const started = Date.now();
  assert.equal((await hanging.lookup(["10.1016/s0140-6736(97)11096-0"])).size, 0);
  assert.ok(Date.now() - started < 2_000, "a slow Crossref does not hold the reader");
});

test("the lookup asks Crossref's polite pool with the deployment's contact, and waits six seconds by default", async () => {
  // Audit I1-11: at three seconds a quarter of the lookups timed out.
  const { fetchImpl, requests } = crossref(recorded.batch);
  const polite = createSourceUpdateLookup({ fetchImpl, userAgent: "x", mailto: "research-ops@example.org" });
  await polite.lookup(["10.1016/S0140-6736(97)11096-0"]);
  assert.equal(requests[0].url.searchParams.get("mailto"), "research-ops@example.org");
  // No address, or something that is not one, and the request stays anonymous.
  for (const mailto of [null, "", "not-an-address", "a@b.org&rows=1000"]) {
    const { fetchImpl: plain, requests: asked } = crossref(recorded.batch);
    await createSourceUpdateLookup({ fetchImpl: plain, userAgent: "x", mailto }).lookup(["10.1016/S0140-6736(97)11096-0"]);
    assert.equal(asked[0].url.searchParams.has("mailto"), false, String(mailto));
  }
  const { SOURCE_UPDATES_DEFAULT_TIMEOUT_MS } = await import("../src/sourceUpdates.mjs");
  const { loadConfig } = await import("../src/config.mjs");
  assert.equal(SOURCE_UPDATES_DEFAULT_TIMEOUT_MS, 6_000);
  const saved = process.env.OPEN_SCIENCE_SOURCE_UPDATES_TIMEOUT_MS;
  delete process.env.OPEN_SCIENCE_SOURCE_UPDATES_TIMEOUT_MS;
  try {
    assert.equal(loadConfig({}).sourceUpdatesTimeoutMs, SOURCE_UPDATES_DEFAULT_TIMEOUT_MS);
  } finally {
    if (saved !== undefined) process.env.OPEN_SCIENCE_SOURCE_UPDATES_TIMEOUT_MS = saved;
  }
  // The deployment files carry the same default, or they would pin the old one.
  const compose = await readFile(new URL("../../../deploy/web/docker-compose.yml", import.meta.url), "utf8");
  const example = await readFile(new URL("../../../deploy/web/.env.example", import.meta.url), "utf8");
  assert.match(compose, /OPEN_SCIENCE_SOURCE_UPDATES_TIMEOUT_MS: \$\{OPEN_SCIENCE_SOURCE_UPDATES_TIMEOUT_MS:-6000\}/);
  assert.match(example, /^OPEN_SCIENCE_SOURCE_UPDATES_TIMEOUT_MS=6000$/m);
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
  assert.equal(untouched.claims[0].sources[0].status, verdict.claims[0].sources[0].status);
  assert.equal(untouched.claims[0].sources[0].updateStatus.state, "unavailable");
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


test("lookup status distinguishes no update, a notice, unknown and an unavailable check with its actual timestamp", async () => {
  const { fetchImpl } = crossref(recorded.batch);
  const clock = Date.parse("2026-10-02T09:00:00Z");
  const lookup = createSourceUpdateLookup({ fetchImpl, userAgent: "x", now: () => clock });
  const statuses = await lookup.lookupStatuses(["10.1016/s0140-6736(97)11096-0", "10.1056/nejmoa2204233", "10.9999/unknown"]);
  assert.equal(statuses.get("10.1016/s0140-6736(97)11096-0").state, "changed");
  assert.equal(statuses.get("10.1056/nejmoa2204233").state, "no_update");
  assert.equal(statuses.get("10.9999/unknown").state, "unknown");
  assert.equal(statuses.get("10.9999/unknown").checkedAt, "2026-10-02T09:00:00.000Z");
  assert.equal(statuses.get("10.9999/unknown").reason, "not_in_crossref");
  const failed = createSourceUpdateLookup({ fetchImpl: crossref([], { fail: true }).fetchImpl, userAgent: "x", now: () => clock });
  const compat = await failed.lookup(["10.9999/unknown"]);
  assert.equal(compat.size, 0);
  assert.equal(compat.statuses.get("10.9999/unknown").state, "unavailable");
  assert.equal(compat.statuses.get("10.9999/unknown").reason, "http_503");
});

test("one deadline bounds all Crossref batches and a hanging streamed body", async () => {
  let asked = 0;
  let canceled = 0;
  const lookup = createSourceUpdateLookup({ userAgent: "x", timeoutMs: 55, fetchImpl: async () => {
    asked += 1;
    if (asked === 1) { await new Promise(resolve => setTimeout(resolve, 30)); return Response.json({ message: { items: [] } }); }
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"message":')); }, cancel() { canceled += 1; } }));
  } });
  const started = Date.now();
  const statuses = await lookup.lookupStatuses(Array.from({ length: 48 }, (_, index) => `10.9999/source-${index}`));
  assert.ok(Date.now() - started < 150);
  assert.equal(asked, 2, "the remaining batch is marked unavailable without a new request after the deadline");
  assert.equal(canceled, 1, "the blocked body is canceled");
  assert.equal(statuses.get("10.9999/source-47").reason, "timeout");
});

test("read-only retry respects Retry-After inside the deadline and caller cancellation names the gap", async () => {
  let requests = 0;
  const lookup = createSourceUpdateLookup({ userAgent: "x", maxAttempts: 2, timeoutMs: 40, fetchImpl: async () => {
    requests += 1;
    return new Response("busy", { status: 429, headers: { "retry-after": "30" } });
  } });
  const statuses = await lookup.lookupStatuses(["10.9999/a"]);
  assert.equal(requests, 1, "no retry starts once Retry-After consumes the remaining allowance");
  assert.equal(statuses.get("10.9999/a").reason, "timeout");
  const controller = new AbortController();
  controller.abort();
  const canceled = await lookup.lookupStatuses(["10.9999/a"], { signal: controller.signal });
  assert.equal(canceled.get("10.9999/a").reason, "canceled");
  assert.equal(requests, 1);
  const retried = createSourceUpdateLookup({ userAgent: "x", maxAttempts: 2, fetchImpl: async () => ++requests === 2
    ? new Response("busy", { status: 503 }) : Response.json({ message: { items: [{ DOI: "10.9999/a" }] } }) });
  assert.equal((await retried.lookupStatuses(["10.9999/a"])).get("10.9999/a").state, "no_update");
  assert.equal(requests, 3);
});

test("a response without a works list is unavailable, while a wrong DOI does not certify the requested source", async () => {
  for (const [response, state] of [[{ message: {} }, "unavailable"], [{ message: { items: [{ DOI: "10.9999/wrong" }] } }, "unknown"]]) {
    const lookup = createSourceUpdateLookup({ userAgent: "x", fetchImpl: async () => Response.json(response) });
    assert.equal((await lookup.lookupStatuses(["10.9999/requested"])).get("10.9999/requested").state, state);
  }
});

test("uploaded sources and abstract-only quotes retain access truth while mismatched DOI captures remain unknown", async () => {
  const verdict = { claims: [
    { claimId: "abstract", claimType: "direct", sources: [{ artifactPath: "abstract.md", status: "no_quote" }] },
    { claimId: "upload", claimType: "direct", sources: [{ artifactPath: "uploaded.md", status: "verified" }] },
    { claimId: "mismatch", claimType: "direct", sources: [{ artifactPath: "other.md", status: "verified" }] },
  ] };
  const matrix = { claims: [{ claimId: "abstract", identifier: "10.9999/abstract", accessLevel: "abstract_only" },
    { claimId: "upload", artifactPath: "uploaded.md", accessLevel: "full_text" },
    { claimId: "mismatch", identifier: "10.9999/requested" }] };
  let asked;
  await attachSourceUpdates(verdict, { matrix, sourceArtifacts: { "other.md": "- DOI: 10.9999/other" }, lookup: async dois => {
    asked = dois; return new Map([["10.9999/abstract", []]]);
  } });
  assert.deepEqual(asked, ["10.9999/abstract"]);
  assert.equal(verdict.claims[0].sources[0].status, "no_quote", "metadata update lookup does not turn an abstract into preserved full text");
  assert.equal(verdict.claims[0].sources[0].updateStatus.state, "no_update");
  assert.equal(verdict.claims[1].sources[0].updateStatus.reason, "not_identified");
  assert.equal(verdict.claims[2].sources[0].updateStatus.reason, "identifier_mismatch");
});
