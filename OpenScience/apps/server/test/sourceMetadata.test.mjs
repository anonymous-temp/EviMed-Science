import assert from "node:assert/strict";
import test from "node:test";

import { titleSimilarity, verifySourceMetadata } from "../src/sourceMetadata.mjs";

const PARSED = Object.freeze({
  title: "Rivaroxaban versus Warfarin in Nonvalvular Atrial Fibrillation",
  authors: ["Manesh R. Patel", "Kenneth W. Mahaffey"],
  abstract: "A long abstract the record does not keep twice.",
  doi: "10.1056/NEJMoa1009638",
});

/** A Crossref that answers one DOI the way the REST API does. */
function crossref(status, message) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ status: "ok", "message-type": "work", message }), { status });
  };
  return { fetchImpl, calls };
}

test("titles are compared as titles: case, width, markup and punctuation do not count", () => {
  assert.equal(titleSimilarity("Rivaroxaban versus Warfarin", "<i>Rivaroxaban</i> Versus Warfarin."), 1);
  assert.ok(titleSimilarity(PARSED.title, "Rivaroxaban versus warfarin in nonvalvular atrial fibrillation: the ROCKET AF trial") >= 0.75);
  assert.ok(titleSimilarity(PARSED.title, "Apixaban versus Warfarin in Patients with Atrial Fibrillation") < 0.75);
  assert.equal(titleSimilarity("", "x"), 0);
});

test("a DOI Crossref registers under this title is kept and marked verified", async () => {
  const { fetchImpl, calls } = crossref(200, { title: ["Rivaroxaban versus Warfarin in Nonvalvular Atrial Fibrillation"] });
  const metadata = await verifySourceMetadata(PARSED, { fetchImpl });
  assert.equal(metadata.doi, PARSED.doi);
  assert.equal(metadata.doiCheck.status, "verified");
  assert.equal("abstract" in metadata, false, "the abstract lives in the parse summary, not twice");
  assert.equal(calls[0].url, "https://api.crossref.org/works/10.1056%2FNEJMoa1009638");
  assert.equal(calls[0].init.redirect, "error");
});

test("a DOI Crossref registers under another work is dropped, with the note that says why", async () => {
  const { fetchImpl } = crossref(200, { title: ["Apixaban versus Warfarin in Patients with Atrial Fibrillation"] });
  const metadata = await verifySourceMetadata(PARSED, { fetchImpl });
  assert.equal("doi" in metadata, false);
  assert.equal(metadata.doiCheck.status, "mismatch");
  assert.equal(metadata.doiCheck.droppedDoi, PARSED.doi);
  assert.match(metadata.doiCheck.crossrefTitle, /Apixaban/);
  assert.equal(metadata.title, PARSED.title, "only the DOI is dropped");
});

test("what cannot be decided stays, labelled unconfirmed rather than dropped", async () => {
  // Not registered with Crossref — common for DOIs Chinese journals register elsewhere.
  const missing = await verifySourceMetadata(PARSED, { fetchImpl: crossref(404, {}).fetchImpl });
  assert.deepEqual([missing.doi, missing.doiCheck.status, missing.doiCheck.reason], [PARSED.doi, "unconfirmed", "not_registered_with_crossref"]);
  // A Chinese PDF of a journal that registers its English title.
  const chinese = await verifySourceMetadata({ ...PARSED, title: "利伐沙班与华法林在非瓣膜性房颤中的比较" },
    { fetchImpl: crossref(200, { title: ["Rivaroxaban versus Warfarin in Nonvalvular Atrial Fibrillation"] }).fetchImpl });
  assert.deepEqual([chinese.doi, chinese.doiCheck.status, chinese.doiCheck.reason], [PARSED.doi, "unconfirmed", "title_in_another_script"]);
  // A Chinese original title registered beside the English one is comparable.
  const bilingual = await verifySourceMetadata({ ...PARSED, title: "利伐沙班与华法林在非瓣膜性房颤中的比较" },
    { fetchImpl: crossref(200, { title: ["Rivaroxaban versus Warfarin"], "original-title": ["利伐沙班与华法林在非瓣膜性房颤中的比较"] }).fetchImpl });
  assert.equal(bilingual.doiCheck.status, "verified");
  // No network at all.
  const offline = await verifySourceMetadata(PARSED, { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.deepEqual([offline.doi, offline.doiCheck.status, offline.doiCheck.reason], [PARSED.doi, "unconfirmed", "crossref_unreachable"]);
  // Nothing of our own to compare with.
  const untitled = await verifySourceMetadata({ doi: PARSED.doi }, { fetchImpl: crossref(200, { title: ["Anything"] }).fetchImpl });
  assert.deepEqual([untitled.doiCheck.status, untitled.doiCheck.reason], ["unconfirmed", "document_has_no_title"]);
});

test("metadata without a DOI makes no request, and none at all is null", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return new Response("{}"); };
  assert.deepEqual(await verifySourceMetadata({ title: "A title", abstract: "x" }, { fetchImpl }), { title: "A title" });
  assert.equal(await verifySourceMetadata(null, { fetchImpl }), null);
  assert.equal(await verifySourceMetadata({ abstract: "only an abstract" }, { fetchImpl }), null);
  assert.equal(called, false);
});
