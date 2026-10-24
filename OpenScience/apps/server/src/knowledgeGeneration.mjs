import { createHash } from "node:crypto";
import { normalizeSourcePageMap } from "@evimed/domain";
import { canonicalJson } from "./geoStore.mjs";
import { isCompiledPage, sourceRendition } from "./openVikingSourceSync.mjs";
import { sourceParserRevision, sourceReadable } from "./sourceService.mjs";
import { HttpError } from "./security.mjs";

const SOURCE_ID = /^src_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_SCAN_LIMIT = 5000;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const positive = value => Number.isSafeInteger(value) && value > 0;
const invalidCapture = () => new HttpError(409, "knowledge_source_capture_invalid", "The source's current capture cannot be verified.");
const incomplete = () => new HttpError(422, "knowledge_source_scan_incomplete", "The complete source set exceeds this generation scan or changed during pagination.");

/** Stable JSON identity for a receipt, independent of object insertion order. */
export function knowledgeDigest(value) { return sha256(canonicalJson(value)); }

async function currentSource(sources, ownerId, sourceId) {
  try { return await sources.get(ownerId, sourceId); }
  catch (error) { if (error?.status === 404 || error?.code === "source_not_found") return null; throw error; }
}

/** Canonical original inputs only. Generated-page admission is a separate
 * selected-generation check, never a source ID, a title or a resource prefix.
 * The caller has already resolved the real owner/control project policy.
 * @param {{sources:any,ownerId:string,projectId:string,sourceId:string}} request */
export async function readKnowledgeSourceInput({ sources, ownerId, projectId, sourceId }) {
  if (!SOURCE_ID.test(sourceId)) return null;
  const source = await currentSource(sources, ownerId, sourceId);
  const payload = source?.payload;
  if (!source || source.id !== sourceId || source.kind !== "source" || source.projectId !== projectId || source.deletedAt != null
    || !sourceReadable(payload) || payload.analysis?.generation !== payload.generation || isCompiledPage(source)) return null;
  if (!positive(source.revision) || !positive(payload.generation) || !positive(payload.version)
    || !SHA256.test(payload.fingerprint?.sha256) || !SHA256.test(payload.analysis.textSha256)) throw invalidCapture();
  const capture = await sources.loadCapture(ownerId, source);
  const input = capture?.input, units = input?.units;
  if (!input || input.sourceId !== sourceId || input.generation !== payload.generation || typeof input.text !== "string"
    || !Array.isArray(units) || units.length !== payload.analysis.unitCount
    || units.some((unit, index) => !unit || typeof unit.text !== "string" || !Number.isSafeInteger(unit.start) || !Number.isSafeInteger(unit.end)
      || unit.start !== (units[index - 1]?.end ?? 0)
      || unit.end - unit.start !== unit.text.length || unit.id !== `${sourceId}:g${payload.generation}:u${index + 1}`)
    || units.map(unit => unit.text).join("") !== input.text || sha256(input.text) !== payload.analysis.textSha256
    || knowledgeDigest(capture.metadata ?? null) !== knowledgeDigest(payload.metadata ?? null)
    || knowledgeDigest(capture.extractor ?? null) !== knowledgeDigest(payload.analysis.extractor ?? null)
    || payload.analysis.pageCount != null && (!positive(payload.analysis.pageCount) || !Array.isArray(capture.pageMap)
      || capture.pageMap.length !== payload.analysis.pageCount)
    || capture.pageMap != null && knowledgeDigest(normalizeSourcePageMap(input.text, capture.pageMap)) !== knowledgeDigest(capture.pageMap)) throw invalidCapture();
  const text = sourceRendition(source, capture);
  const receipt = {
    sourceId, sourceRevision: source.revision, sourceGeneration: payload.generation, sourceVersion: payload.version,
    familyId: typeof payload.familyId === "string" ? payload.familyId : null,
    fileSha256: payload.fingerprint.sha256, textSha256: payload.analysis.textSha256, parserRevision: sourceParserRevision(payload.analysis),
    captureDigest: knowledgeDigest({ sourceId, generation: input.generation, units }),
    parserDigest: knowledgeDigest({ extractor: capture.extractor ?? null, coverage: capture.parserCoverage ?? null }),
    metadataDigest: knowledgeDigest(capture.metadata ?? null), pageMapDigest: knowledgeDigest(capture.pageMap ?? null), renditionSha256: sha256(text),
  };
  // Capture reads await the ledger. A source replacement, withdrawal or metadata
  // update during that await belongs in a new manifest, not this receipt.
  const after = await currentSource(sources, ownerId, sourceId);
  if (!after || after.deletedAt != null || after.projectId !== projectId || after.revision !== source.revision
    || knowledgeDigest(after.payload) !== knowledgeDigest(payload)) {
    throw new HttpError(409, "knowledge_source_changed", "The source changed while its generation input was being prepared.");
  }
  return { source, receipt: Object.freeze(receipt), text };
}

/** Enumerate the whole canonical source set before freezing a compile. Readable
 * partial captures are included; the page's ready-state filter is not this set.
 * Bounds fail explicitly rather than certify a prefix as complete.
 * @param {{sources:any,ownerId:string,projectId:string,maxSources?:number}} request */
export async function readKnowledgeSourceInputs({ sources, ownerId, projectId, maxSources = SOURCE_SCAN_LIMIT }) {
  if (!positive(maxSources) || maxSources > SOURCE_SCAN_LIMIT) throw incomplete();
  const inputs = [], seen = new Set(), cursors = new Set();
  let cursor = null;
  do {
    const page = await sources.list(ownerId, { projectId, limit: 100, cursor });
    if (!Array.isArray(page?.items) || page.items.length > 100) throw incomplete();
    for (const row of page.items) {
      if (!SOURCE_ID.test(row?.id) || seen.has(row.id) || seen.size >= maxSources) throw incomplete();
      seen.add(row.id);
      const input = await readKnowledgeSourceInput({ sources, ownerId, projectId, sourceId: row.id });
      if (input) inputs.push(input);
    }
    cursor = page.nextCursor ?? null;
    if (cursor !== null && (typeof cursor !== "string" || !cursor || cursors.has(cursor) || seen.size >= maxSources)) throw incomplete();
    if (cursor !== null) cursors.add(cursor);
  } while (cursor !== null);
  return inputs.sort((left, right) => left.receipt.sourceId.localeCompare(right.receipt.sourceId));
}

/** The bound policy and every exact source receipt define a generation input.
 * The durable generation writer retains the receipts, not just this digest. */
export function knowledgeSourceSetDigest(policy, inputs) {
  const seen = new Set();
  for (const input of inputs) {
    if (!SOURCE_ID.test(input?.receipt?.sourceId) || seen.has(input.receipt.sourceId)
      || typeof input.text !== "string" || sha256(input.text) !== input.receipt.renditionSha256) throw invalidCapture();
    seen.add(input.receipt.sourceId);
  }
  const receipts = inputs.map(input => input.receipt).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return knowledgeDigest({ version: 1, policy, sources: receipts });
}
