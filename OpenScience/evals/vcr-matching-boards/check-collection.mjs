/**
 * Open a prepared trial collection with the platform's own frozen-corpus reader and read one record
 * plus one search, so a format drift between prepare.py and the reader shows up before a paid run.
 *
 *   node check-collection.mjs <collection.json> <NCT id> "<condition>"
 *
 * Prints one JSON line (counts and titles only) and exits non-zero when the reader refuses the index.
 */
import { createVcrTrialCorpus } from "../../apps/server/src/vcrTrialCorpus.mjs";
import { candidateRequest } from "../../apps/server/src/vcrCandidateSearch.mjs";

const [manifest, registryId, condition] = process.argv.slice(2);
if (!manifest || !registryId || !condition) {
  process.stderr.write('usage: node check-collection.mjs <collection.json> <NCT id> "<condition>"\n');
  process.exit(2);
}

const corpus = createVcrTrialCorpus(manifest);
try {
  const record = await corpus.record(registryId);
  if (!record) throw Object.assign(new Error("record_not_found"), { code: "record_not_found" });
  const request = candidateRequest({ condition, status: "any" }, { frozen: true });
  if (!request.ok) throw Object.assign(new Error(request.message), { code: "request_refused" });
  const page = await corpus.search(request.request, null);
  process.stdout.write(`${JSON.stringify({
    collection: corpus.id,
    record: { registryId, title: record.precedent.title, eligibilityChars: String(record.precedent.eligibilityText ?? "").length },
    search: { status: page.status, found: page.found, retrieved: page.retrieval.fusionPool, firstIds: page.candidates.slice(0, 3).map((c) => c.registryId) },
  })}\n`);
} catch (error) {
  process.stderr.write(`${error?.code ?? "failed"}: ${error?.message ?? error}\n`);
  process.exitCode = 1;
} finally {
  await corpus.close();
}
