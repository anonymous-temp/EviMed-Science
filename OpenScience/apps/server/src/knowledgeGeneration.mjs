import { createHash } from "node:crypto";
import { canonicalJson, isKnowledgeMirrorPath, normalizeSourcePageMap } from "@evimed/domain";
import { isCompiledPage, sourceRendition } from "./openVikingSourceSync.mjs";
import { isResearchDatabaseSource, sourceParserRevision, sourceReadable } from "./sourceService.mjs";
import { projectResourcesRoot } from "./openVikingLayout.mjs";
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
 * @param {{sources:any,ownerId:string,projectId:string,sourceId:string,documents?:any,generatedIds?:Set<string>,allowGenerated?:boolean}} request */
export async function readKnowledgeSourceInput({ sources, ownerId, projectId, sourceId, documents = null, generatedIds = null, allowGenerated = false }) {
  if (!SOURCE_ID.test(sourceId)) return null;
  const source = await currentSource(sources, ownerId, sourceId);
  const payload = source?.payload;
  if (!source || source.id !== sourceId || source.kind !== "source" || source.projectId !== projectId || source.deletedAt != null
    || !sourceReadable(payload) || payload.analysis?.generation !== payload.generation) return null;
  // A table imported from the researcher's own database is not an input of any compile (`isResearchDatabaseSource`).
  if (isResearchDatabaseSource(source)) return null;
  if (!allowGenerated && (isCompiledPage(source) || isCompiledPage({ payload: { paths: [payload.outputs?.artifactPath] } })
    || (generatedIds ?? (documents ? await readKnowledgeGeneratedIds({ documents, ownerId, projectId }) : new Set())).has(sourceId))) return null;
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
  return { source, receipt: Object.freeze(receipt), text, captureText: input.text };
}

/** Enumerate the whole canonical source set before freezing a compile. Readable
 * partial captures are included; the page's ready-state filter is not this set.
 * Bounds fail explicitly rather than certify a prefix as complete.
 * @param {{sources:any,ownerId:string,projectId:string,maxSources?:number,documents?:any}} request */
export async function readKnowledgeSourceInputs({ sources, ownerId, projectId, maxSources = SOURCE_SCAN_LIMIT, documents = null }) {
  if (!positive(maxSources) || maxSources > SOURCE_SCAN_LIMIT) throw incomplete();
  const generatedIds = documents ? await readKnowledgeGeneratedIds({ documents, ownerId, projectId }) : new Set();
  const inputs = [], seen = new Set(), cursors = new Set();
  let cursor = null;
  do {
    const page = await sources.list(ownerId, { projectId, limit: 100, cursor });
    if (!Array.isArray(page?.items) || page.items.length > 100) throw incomplete();
    for (const row of page.items) {
      if (!SOURCE_ID.test(row?.id) || seen.has(row.id) || seen.size >= maxSources) throw incomplete();
      seen.add(row.id);
      const input = await readKnowledgeSourceInput({ sources, ownerId, projectId, sourceId: row.id, generatedIds });
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


/** Historical page identities and source origins remain derived even when a
 * current source path or page record was replaced. Query only this project,
 * including tombstones and revision origins; no engine/filesystem scan.
 * @param {{documents:any,ownerId:string,projectId:string}} input */
export async function readKnowledgeGeneratedIds({ documents, ownerId, projectId }) {
  if (documents.database) {
    const reply = await documents.database.query(`SELECT DISTINCT source_id FROM (
      SELECT payload->>'pageSourceId' AS source_id FROM evimed_product.documents
        WHERE user_id=$1 AND kind='knowledge' AND project_id=$2 AND payload->>'recordType'='wiki-page'
      UNION SELECT r.payload->>'pageSourceId' FROM evimed_product.revisions r
        JOIN evimed_product.documents d USING(user_id,kind,id)
        WHERE d.user_id=$1 AND d.kind='knowledge' AND d.project_id=$2 AND r.payload->>'recordType'='wiki-page'
      UNION SELECT d.id FROM evimed_product.documents d JOIN evimed_product.revisions r USING(user_id,kind,id)
        WHERE d.user_id=$1 AND d.kind='source' AND d.project_id=$2 AND (
          EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.payload->'paths')='array' THEN r.payload->'paths' ELSE '[]'::jsonb END) p
            WHERE p ~ '^knowledge-base/(wiki|kg)/') OR r.payload#>>'{outputs,artifactPath}' ~ '^knowledge-base/(wiki|kg)/')
      ) origins WHERE source_id IS NOT NULL LIMIT 5001`, [ownerId, projectId]);
    if (reply.rows.length > SOURCE_SCAN_LIMIT) throw incomplete();
    return new Set(reply.rows.map(row => row.source_id));
  }
  const ids = new Set();
  for (const deleted of [false, true]) {
    let cursor = null; const seen = new Set();
    do {
      const page = await documents.list(ownerId, "knowledge", { projectId, filter: { recordType: "wiki-page" }, deleted, cursor, limit: 100 });
      for (const row of page.items) {
        if (seen.has(row.id) || seen.size >= SOURCE_SCAN_LIMIT) throw incomplete();
        seen.add(row.id); if (row.payload.pageSourceId) ids.add(row.payload.pageSourceId);
        if (typeof documents.history !== "function") throw incomplete();
        let beforeRevision = null, count = 0;
        for (;;) {
          const history = await documents.history(ownerId, "knowledge", row.id, { beforeRevision, limit: 100 });
          for (const revision of history) { if (++count > SOURCE_SCAN_LIMIT) throw incomplete(); if (revision.payload?.pageSourceId) ids.add(revision.payload.pageSourceId); }
          if (history.length < 100) break;
          const next = history.at(-1).revision;
          if (beforeRevision !== null && next >= beforeRevision) throw incomplete();
          beforeRevision = next;
        }
      }
      cursor = page.nextCursor;
      if (cursor && !page.items.length) throw incomplete();
    } while (cursor);
  }
  return ids;
}

/** Canonical policy identity. No actor, session or browser field participates. */
export function knowledgePolicyStamp(policy) {
  if (policy?.kind !== "geo-project" || !policy.referenceId || !positive(policy.revision)
    || !policy.ownerId || !policy.controlProjectId || !policy.ownerCreatedAt || !policy.projectCreatedAt || !policy.namespace?.id) {
    throw new HttpError(403, "knowledge_scope_denied", "The project knowledge policy is unavailable.");
  }
  const value = { version: 1, referenceId: policy.referenceId, revision: policy.revision,
    ownerId: policy.ownerId, ownerCreatedAt: policy.ownerCreatedAt, controlProjectId: policy.controlProjectId,
    projectCreatedAt: policy.projectCreatedAt, namespaceId: policy.namespace.id };
  return Object.freeze({ ...value, digest: knowledgeDigest(value) });
}

/** Resource URIs and local mirror paths must identify the same literal path.
 * Percent escapes/query/fragment delimiters are not filenames at this seam. */
export function knowledgeOutputPath(path) { return isKnowledgeMirrorPath(path) && !/[?#%]/.test(path); }

/** Fresh project resource targets, never an existing incremental tree. */
export function knowledgeGenerationRoots(resources, ownerId, projectId, generationId, attempt = 0) {
  if (!/^kg_[a-f0-9]{32}$/.test(generationId) || !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 1) {
    throw new HttpError(409, "knowledge_generation_invalid", "The knowledge generation identity is invalid.");
  }
  const root = `${resources.roots(ownerId, projectId).project}/generations/${generationId}`;
  return { sources: `${root}/sources`, wiki: `${root}/wiki-${attempt}`, kg: `${root}/kg` };
}

/** Complete bounded ledger scans. Authorization filters precede pagination. */
export async function readKnowledgeRecords(documents, ownerId, projectId, filter) {
  const rows = [], seen = new Set(); let cursor = null;
  do {
    const page = await documents.list(ownerId, "knowledge", { projectId, filter, limit: 100, cursor });
    for (const row of page.items) { if (seen.has(row.id) || rows.length >= 10000) throw incomplete(); seen.add(row.id); rows.push(row); }
    cursor = page.nextCursor;
    if (cursor && !page.items.length) throw incomplete();
  } while (cursor);
  return rows;
}

/** Receipts live in bounded immutable product records, not an oversized state
 * row. Each reference binds the exact record revision and canonical digest. */
export async function writeKnowledgeManifest(documents, ownerId, projectId, generationId, name, values) {
  const shards = [];
  for (let start = 0; start < values.length; start += 50) {
    const payload = { recordType: "knowledge-generation-manifest", generationId, name, entries: values.slice(start, start + 50) };
    if (Buffer.byteLength(JSON.stringify(payload)) > 200000) throw incomplete();
    const id = `${generationId}:${name}:${start / 50}`;
    const existing = await documents.get(ownerId, "knowledge", id);
    if (existing && knowledgeDigest(existing.payload) !== knowledgeDigest(payload)) throw incomplete();
    const row = existing ?? await documents.put(ownerId, "knowledge", id, payload, { projectId, expectedRevision: 0 });
    shards.push({ id, revision: row.revision, digest: knowledgeDigest(payload), count: payload.entries.length });
  }
  return { count: values.length, shards, digest: knowledgeDigest(shards) };
}

export async function readKnowledgeManifest(documents, ownerId, projectId, reference) {
  if (!reference || !Array.isArray(reference.shards) || reference.shards.length > 200 || knowledgeDigest(reference.shards) !== reference.digest) return null;
  const entries = [], ids = new Set();
  for (const shard of reference.shards) {
    if (ids.has(shard.id)) return null; ids.add(shard.id);
    const row = await documents.get(ownerId, "knowledge", shard.id);
    if (!row || row.projectId !== projectId || row.revision !== shard.revision || knowledgeDigest(row.payload) !== shard.digest
      || !Array.isArray(row.payload.entries) || row.payload.entries.length !== shard.count) return null;
    entries.push(...row.payload.entries);
  }
  return entries.length === reference.count ? entries : null;
}

/** Deployment evidence is server-owned and optional. Readiness/capability
 * probes cannot manufacture an effective direct/noexec execution receipt. */
export function validKnowledgeExecution(binding, request) {
  return binding?.version === 1 && binding.mode === "openviking-resource-pipeline-direct-noexec"
    && binding.targetContextType === "resource" && binding.backend === "direct" && binding.allowCompileExec === false
    && typeof binding.engineVersion === "string" && /^sha256:[a-f0-9]{64}$/.test(binding.imageDigest)
    && /^[a-f0-9]{40}$/.test(binding.upstreamCommit) && SHA256.test(binding.skillSha256)
    && SHA256.test(binding.configDigest) && SHA256.test(binding.qualificationDigest)
    && typeof binding.skillUri === "string" && binding.skillUri.endsWith(`/${request.skill}`);
}

/** A reference is issued by the global server-owned execution authority,
 * never reconstructed from a stored request's claim about itself. */
export function validKnowledgeQualificationRef(reference, request) {
  return reference && Object.keys(reference).length === 3 && Number.isSafeInteger(reference.environmentEpoch) && reference.environmentEpoch >= 1
    && Number.isSafeInteger(reference.skillEpoch) && reference.skillEpoch >= 1 && SHA256.test(reference.bindingDigest)
    && reference.bindingDigest === knowledgeDigest(request.execution);
}

/** One selector for every derived projection. A selected pointer is a receipt,
 * not authority by itself: sources, execution qualification, pages and current
 * mirror captures must still match. Engine availability is independent.
 * @param {{documents:any,sources:any,project:any,policy:any,currentInputs:any[],compileExecutionFor:any,transactionClient?:any}} input */
export async function readSelectedKnowledgeGeneration({ documents, sources, project, policy, currentInputs, compileExecutionFor, transactionClient = null }) {
  const ownerId = project.userId, projectId = project.id;
  const state = await documents.get(ownerId, "knowledge", `wiki:state:${projectId}`);
  const pointer = state?.payload?.selectedGeneration;
  if (!pointer || !compileExecutionFor) return null;
  const row = await documents.get(ownerId, "knowledge", pointer.id);
  const receipt = row?.payload;
  if (!receipt || row.revision !== pointer.revision || knowledgeDigest(receipt) !== pointer.digest || row.projectId !== projectId
    || receipt.recordType !== "knowledge-generation" || receipt.status !== "completed"
    || receipt.policy.digest !== policy.digest || receipt.sourceSetDigest !== knowledgeSourceSetDigest(policy, currentInputs)) return null;
  const canonicalRoots = knowledgeGenerationRoots({ roots: () => ({ project: projectResourcesRoot(ownerId, projectId) }) }, ownerId, projectId, receipt.generationId, receipt.attempt ?? 0);
  if (receipt.tasks?.kg?.disabled === true) canonicalRoots.kg = null;
  if (knowledgeDigest(canonicalRoots) !== knowledgeDigest(receipt.roots)) return null;
  const inputs = await readKnowledgeManifest(documents, ownerId, projectId, receipt.inputs);
  if (!inputs || knowledgeDigest(inputs) !== knowledgeDigest(currentInputs.map(input => input.receipt))) return null;
  const qualifiedTrees = receipt.tasks?.kg?.disabled === true ? ["wiki"] : ["wiki", "kg"];
  if (!receipt.qualificationRefs || typeof receipt.qualificationRefs !== "object"
    || Object.keys(receipt.qualificationRefs).length !== qualifiedTrees.length || qualifiedTrees.some(tree => !Object.hasOwn(receipt.qualificationRefs, tree))) return null;
  for (const tree of ["wiki", "kg"]) {
    const held = receipt.tasks[tree];
    if (tree === "kg" && held?.disabled === true) continue;
    if (!held?.request || held.request.to !== receipt.roots[tree] || knowledgeDigest(held.request.from) !== knowledgeDigest([receipt.roots.sources])
      || held.request.generationId !== receipt.generationId || held.request.tree !== tree || held.request.skill !== (tree === "wiki" ? "llm-wiki" : "knowledge-graph")) return null;
    if (held?.task?.status !== "completed" || !held.task.terminal || held.task.taskId !== held.taskId
      || held.requestDigest !== knowledgeDigest(held.request) || held.taskDigest !== knowledgeDigest(held.task)) return null;
    const authorityRef = receipt.qualificationRefs?.[tree];
    if (!validKnowledgeQualificationRef(authorityRef, held.request)) return null;
    const execution = await compileExecutionFor(policy, held.request, { mode: "completed-read", authorityRef, transactionClient });
    if (!validKnowledgeExecution(execution, held.request) || knowledgeDigest(execution) !== knowledgeDigest(held.request.execution)) return null;
  }
  const outputs = await readKnowledgeManifest(documents, ownerId, projectId, receipt.outputs);
  if (!outputs || knowledgeDigest(outputs) !== receipt.outputDigest) return null;
  const pages = [];
  for (const output of outputs) {
    if (!knowledgeOutputPath(output.path) || !["wiki", "kg"].includes(output.tree)
      || output.uri !== `${receipt.roots[output.tree]}/${output.path}` || output.mirrorRel !== `generations/${receipt.generationId}/${output.path}`) return null;
    const page = await documents.get(ownerId, "knowledge", output.recordId);
    if (!page || page.projectId !== projectId || page.revision !== output.recordRevision || knowledgeDigest(page.payload) !== output.recordDigest
      || page.payload.generationId !== receipt.generationId || page.payload.pageSourceId !== output.source.sourceId) return null;
    const input = await readKnowledgeOutputSource({ sources, ownerId, projectId, sourceId: output.source.sourceId });
    if (!input || knowledgeDigest(input.receipt) !== knowledgeDigest(output.source)
      || !input.source.payload.paths?.includes(`knowledge-base/${output.tree}/${output.mirrorRel}`)
      || input.receipt.fileSha256 !== output.displayedBytesSha256) return null;
    if (page.payload.editReceipt) {
      const reference = page.payload.editReceipt;
      const edit = await documents.get(ownerId, "knowledge", reference.id);
      if (!edit || edit.projectId !== projectId || edit.revision !== reference.revision || knowledgeDigest(edit.payload) !== reference.digest
        || edit.payload.policy.digest !== policy.digest || edit.payload.sourceSetDigest !== receipt.sourceSetDigest
        || edit.payload.actor.userId !== ownerId || edit.payload.textSha256 !== output.displayedBytesSha256
        || knowledgeDigest(edit.payload.userEdits) !== knowledgeDigest(page.payload.userEdits)) return null;
    }
    if (page.payload.carriedEditReceipt) {
      const reference = page.payload.carriedEditReceipt;
      const edit = await documents.get(ownerId, "knowledge", reference.id);
      if (!edit || edit.projectId !== projectId || edit.revision !== reference.revision || knowledgeDigest(edit.payload) !== reference.digest
        || edit.payload.policy.digest !== policy.digest || edit.payload.sourceSetDigest !== receipt.sourceSetDigest
        || knowledgeDigest(edit.payload.userEdits) !== knowledgeDigest(page.payload.userEdits)
        || !receipt.tasks.wiki.request.editReceipts?.some(saved => saved.id === reference.id && saved.revision === reference.revision && saved.digest === reference.digest && saved.path === output.path)) return null;
    }
    pages.push(page);
  }
  return { receipt, pages, outputs,
    permitsPage: page => pages.some(heldPage => heldPage.id === page.id && heldPage.revision === page.revision),
    permitsSource: source => outputs.some(output => output.source.searchable !== false && output.source.sourceId === source.id && output.source.sourceRevision === source.revision) };
}

/** Empty/non-text output files are intentionally preserved by normal intake as
 * originals. They have no searchable capture to wait for. Bind that explicit
 * current intake outcome plus exact file bytes; never admit it to kb_search. */
export async function readKnowledgeOutputSource({ sources, ownerId, projectId, sourceId }) {
  const source = await currentSource(sources, ownerId, sourceId);
  if (!source || source.deletedAt != null || source.projectId !== projectId) return null;
  if (source.payload?.original?.generation === source.payload.generation && source.payload.status === "complete") {
    const payload = source.payload;
    if (!positive(source.revision) || !SHA256.test(payload.fingerprint?.sha256)) return null;
    return { source, receipt: { sourceId, sourceRevision: source.revision, sourceGeneration: payload.generation, sourceVersion: payload.version,
      fileSha256: payload.fingerprint.sha256, originalDigest: knowledgeDigest(payload.original), metadataDigest: knowledgeDigest(payload.metadata ?? null), searchable: false } };
  }
  return readKnowledgeSourceInput({ sources, ownerId, projectId, sourceId, allowGenerated: true });
}
