/** Immutable analysis pages in the existing GEO input ledger; no current-data fallback. */
import { createHash } from "node:crypto";
import { canonicalJson } from "./geoStore.mjs";
import { geoReadPage } from "./geoReadScope.mjs";
import { HttpError } from "./security.mjs";
const hash = (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const invalid = () =>
  new HttpError(
    409,
    "geo_plan_basis_unavailable",
    "The frozen analysis is incomplete or changed. Reopen the selected analysis.",
  );
const tooLarge = () =>
  new HttpError(
    422,
    "geo_plan_basis_too_large",
    "Narrow the dates, questions or platforms before opening this analysis in conversation.",
  );
export const GEO_FROZEN_ANALYSIS_LIMITS = Object.freeze({
  pageBytes: 150000,
  pages: 128,
  totalBytes: 16 * 1024 * 1024,
  previewRows: 5,
  summaryBytes: 200000,
});
/** @param {any} analysis @param {{parentId:string,project:any,actorId:string}} input */
export function freezeGeoAnalysisPages(
  analysis,
  { parentId, project, actorId },
) {
  if (
    analysis.page.shown !== analysis.page.total ||
    analysis.rows.length !== analysis.page.total
  )
    throw invalid();
  if (bytes(analysis) <= GEO_FROZEN_ANALYSIS_LIMITS.summaryBytes)
    return { analysis, pages: [] };
  const pages = [],
    descriptors = [];
  let rows = [],
    rowBytes = 0,
    start = 0;
  const header = () => ({
    recordType: "geo-analysis-page",
    schemaVersion: 1,
    parentId,
    ownerId: project.userId,
    geoId: project.id,
    actorId,
    analysisDigest: analysis.digest,
    index: pages.length,
    start,
    rows: [],
  });
  const overhead = () => bytes({ ...header(), digest: "0".repeat(64) });
  const flush = () => {
    if (!rows.length) return;
    if (pages.length >= GEO_FROZEN_ANALYSIS_LIMITS.pages) throw tooLarge();
    const content = { ...header(), rows },
      digest = hash(content),
      payload = { ...content, digest };
    if (bytes(payload) > GEO_FROZEN_ANALYSIS_LIMITS.pageBytes) throw tooLarge();
    const id = `gpcpage_${hash([parentId, pages.length, analysis.digest, digest])}`;
    pages.push({
      kind: "geo-plan-context",
      id,
      projectId: project.projectId,
      payload,
    });
    descriptors.push({
      id,
      index: payload.index,
      start,
      count: rows.length,
      digest,
      bytes: bytes(payload),
    });
    start += rows.length;
    rows = [];
    rowBytes = 0;
  };
  for (const row of analysis.rows) {
    const size = bytes(row);
    if (overhead() + size > GEO_FROZEN_ANALYSIS_LIMITS.pageBytes)
      throw tooLarge();
    if (
      rows.length &&
      overhead() + rowBytes + size + rows.length >
        GEO_FROZEN_ANALYSIS_LIMITS.pageBytes
    )
      flush();
    rows.push(row);
    rowBytes += size;
  }
  flush();
  const preview = analysis.rows.slice(
    0,
    GEO_FROZEN_ANALYSIS_LIMITS.previewRows,
  );
  const compact = {
    ...analysis,
    rows: preview,
    page: {
      total: analysis.rows.length,
      shown: preview.length,
      nextOffset: preview.length < analysis.rows.length ? preview.length : null,
    },
    remainder: null,
    frozenPages: {
      schemaVersion: 1,
      parentId,
      analysisDigest: analysis.digest,
      totalRows: analysis.rows.length,
      rowsDigest: hash(analysis.rows),
      pages: descriptors,
    },
  };
  // A very large row need not be repeated in the initial native envelope.
  while (
    bytes(compact) > GEO_FROZEN_ANALYSIS_LIMITS.summaryBytes &&
    compact.rows.length
  ) {
    compact.rows.pop();
    compact.page.shown = compact.rows.length;
    compact.page.nextOffset = compact.rows.length;
  }
  if (
    bytes(compact) > GEO_FROZEN_ANALYSIS_LIMITS.summaryBytes ||
    bytes(pages) > GEO_FROZEN_ANALYSIS_LIMITS.totalBytes
  )
    throw tooLarge();
  return { analysis: compact, pages };
}
/** Validate parent plus only the immutable pages needed for this bounded read.
 * @param {any} documents @param {any} project @param {any} parent @param {any} input */
export async function readFrozenGeoAnalysisPage(
  documents,
  project,
  parent,
  input = {},
) {
  const frozen = parent?.payload?.basis?.analysis,
    { limit, offset } = geoReadPage(input);
  if (
    !frozen ||
    !Array.isArray(frozen.rows) ||
    parent.projectId !== project.projectId ||
    parent.payload.recordType !== "geo-plan-context" ||
    parent.payload.geoId !== project.id ||
    parent.payload.mode !== "analysis" ||
    parent.payload.state !== "bound" ||
    parent.payload.basisDigest !== hash(parent.payload.basis)
  )
    throw invalid();
  const manifest = frozen.frozenPages;
  if (!manifest)
    return {
      ...frozen,
      rows: frozen.rows.slice(offset, offset + limit),
      page: {
        total: frozen.rows.length,
        shown: frozen.rows.slice(offset, offset + limit).length,
        nextOffset: offset + limit < frozen.rows.length ? offset + limit : null,
      },
      readingsKind: "submitted_input",
    };
  if (
    parent.projectId !== project.projectId ||
    parent.payload.recordType !== "geo-plan-context" ||
    parent.payload.geoId !== project.id ||
    parent.payload.mode !== "analysis" ||
    parent.payload.state !== "bound" ||
    parent.payload.basisDigest !== hash(parent.payload.basis) ||
    manifest.schemaVersion !== 1 ||
    manifest.parentId !== parent.id ||
    manifest.analysisDigest !== frozen.digest ||
    !Number.isSafeInteger(manifest.totalRows) ||
    manifest.totalRows < 1 ||
    manifest.totalRows > 20000 ||
    !Array.isArray(manifest.pages) ||
    manifest.pages.length < 1 ||
    manifest.pages.length > GEO_FROZEN_ANALYSIS_LIMITS.pages
  )
    throw invalid();
  let expectedStart = 0,
    totalBytes = 0;
  for (const [index, descriptor] of manifest.pages.entries()) {
    if (
      descriptor.index !== index ||
      descriptor.start !== expectedStart ||
      !Number.isSafeInteger(descriptor.count) ||
      descriptor.count < 1 ||
      !Number.isSafeInteger(descriptor.bytes) ||
      descriptor.bytes > GEO_FROZEN_ANALYSIS_LIMITS.pageBytes ||
      descriptor.bytes < 1 ||
      !/^[a-f0-9]{64}$/.test(descriptor.digest ?? "") ||
      descriptor.id !==
        `gpcpage_${hash([parent.id, index, frozen.digest, descriptor.digest])}`
    )
      throw invalid();
    expectedStart += descriptor.count;
    totalBytes += descriptor.bytes;
  }
  if (
    expectedStart !== manifest.totalRows ||
    totalBytes > GEO_FROZEN_ANALYSIS_LIMITS.totalBytes
  )
    throw invalid();
  const needed = manifest.pages.filter(
    (descriptor) =>
      descriptor.start < offset + limit &&
      descriptor.start + descriptor.count > offset,
  );
  const records = await Promise.all(
    needed.map((descriptor) =>
      documents.get(project.userId, "geo-plan-context", descriptor.id),
    ),
  );
  const rows = [];
  for (const [index, descriptor] of needed.entries()) {
    const record = records[index],
      payload = record?.payload;
    if (
      !record ||
      record.kind !== "geo-plan-context" ||
      record.id !== descriptor.id ||
      record.projectId !== project.projectId ||
      payload?.recordType !== "geo-analysis-page" ||
      payload.schemaVersion !== 1 ||
      payload.ownerId !== project.userId ||
      payload.geoId !== project.id ||
      payload.actorId !== parent.payload.actorId ||
      payload.parentId !== parent.id ||
      payload.analysisDigest !== frozen.digest ||
      payload.index !== descriptor.index ||
      payload.start !== descriptor.start ||
      !Array.isArray(payload.rows) ||
      payload.rows.length !== descriptor.count ||
      payload.digest !== descriptor.digest ||
      bytes(payload) !== descriptor.bytes
    )
      throw invalid();
    const { digest: _digest, ...content } = payload;
    if (hash(content) !== descriptor.digest) throw invalid();
    rows.push(
      ...payload.rows.slice(
        Math.max(0, offset - descriptor.start),
        Math.min(descriptor.count, offset + limit - descriptor.start),
      ),
    );
  }
  return {
    ...frozen,
    rows,
    page: {
      total: manifest.totalRows,
      shown: rows.length,
      nextOffset:
        offset + rows.length < manifest.totalRows ? offset + rows.length : null,
    },
    readingsKind: "submitted_input",
  };
}
/** Atomic parent+page admission uses the same bounded ProductDocuments batch.
 * @param {any} documents @param {any} project @param {string} id @param {any} payload @param {any[]} pages */
export async function persistFrozenGeoAnalysisContext(
  documents,
  project,
  id,
  payload,
  pages,
) {
  const records = [
    { kind: "geo-plan-context", id, projectId: project.projectId, payload },
    ...pages,
  ];
  const encoded = records.map((record) => ({
    kind: record.kind,
    id: record.id,
    payload: record.payload,
    project_id: record.projectId,
  }));
  if (
    bytes(payload) > 262144 ||
    bytes(encoded) > GEO_FROZEN_ANALYSIS_LIMITS.totalBytes
  )
    throw tooLarge();
  const result = await documents.createBatch(project.userId, records);
  return result[0];
}
