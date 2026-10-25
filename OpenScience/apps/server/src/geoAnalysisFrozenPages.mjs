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
  chartBytes: 16 * 1024,
});
/** Only the server-validated V21 strategy supplement may share the frozen analysis reader. */
export function hasGeoFrozenAnalysisContext(payload) {
  if(payload?.mode==="analysis") return true;
  const basis=payload?.basis,focus=basis?.analysisFocus,analysis=basis?.analysis;
  return payload?.mode==="strategy" && focus?.viewId==="V21" && analysis?.view?.viewId==="V21" && focus.analysisDigest===analysis.digest
    && focus.parentSelectionRef===analysis.selection?.reference && focus.childSelectionRef===basis.selection?.reference
    && basis.groups?.length===1 && basis.groups[0].id===focus.groupId && basis.groups[0].setVersion===focus.setVersion;
}
/** @param {any} analysis @param {{parentId:string,project:any,actorId:string}} input */
export function freezeGeoAnalysisPages(
  analysis,
  { parentId, project, actorId },
) {
  if (!analysis?.page || analysis.rowContext === "member_details" || !Array.isArray(analysis.rows) || analysis.page.shown !== analysis.page.total || analysis.rows.length !== analysis.page.total) throw invalid();
  const objectPages = [], contexts = [];
  const projectedRows = analysis.rows.map((row, rowIndex) => {
    if (bytes(row) + 4096 <= GEO_FROZEN_ANALYSIS_LIMITS.pageBytes || !Array.isArray(row.dimensions?.objects)) return row;
    const source = row.dimensions.objects, descriptors = [], objectsDigest = hash(source);
    let objects = [], size = 0, start = 0;
    const header = () => ({ recordType: "geo-analysis-object-page", schemaVersion: 1, parentId, ownerId: project.userId,
      geoId: project.id, actorId, analysisDigest: analysis.digest, rowKey: row.key, columnKey: "objects", objectsDigest,
      index: descriptors.length, start, objects: [], digest: "0".repeat(64) });
    const flush = () => {
      if (!objects.length) return;
      const { digest: _digest, ...content } = { ...header(), objects };
      const payload = { ...content, digest: hash(content) };
      if (bytes(payload) > GEO_FROZEN_ANALYSIS_LIMITS.pageBytes || objectPages.length >= GEO_FROZEN_ANALYSIS_LIMITS.pages) throw tooLarge();
      const id = objectPageId(parentId, row.key, payload.index, analysis.digest, payload.digest);
      objectPages.push({ kind: "geo-plan-context", id, projectId: project.projectId, payload });
      descriptors.push({ id, index: payload.index, start, count: objects.length, digest: payload.digest, bytes: bytes(payload) });
      start += objects.length; objects = []; size = 0;
    };
    for (const object of source) {
      const itemBytes = bytes(object);
      if (bytes(header()) + itemBytes > GEO_FROZEN_ANALYSIS_LIMITS.pageBytes) throw tooLarge();
      if (objects.length && bytes(header()) + size + itemBytes + objects.length > GEO_FROZEN_ANALYSIS_LIMITS.pageBytes) flush();
      objects.push(object); size += itemBytes;
    }
    flush();
    if (!descriptors.length || source.length > 20000) throw tooLarge();
    contexts.push({ rowKey: row.key, rowIndex, columnKey: "objects", total: source.length, digest: objectsDigest, pages: descriptors });
    const { objects: _objects, ...dimensions } = row.dimensions;
    return { ...row, dimensions: { ...dimensions, objectsContext: { schemaVersion: 1, total: source.length,
      digest: objectsDigest, pageRefs: descriptors.map(page => page.id) } } };
  });
  if (!contexts.length) return freezeRows(analysis, { parentId, project, actorId });
  const pack = freezeRows({ ...analysis, rows: projectedRows }, { parentId, project, actorId }, true);
  pack.analysis.frozenPages = { ...pack.analysis.frozenPages, schemaVersion: 2, rowsDigest: hash(analysis.rows),
    projectedRowsDigest: hash(projectedRows), objects: contexts };
  pack.analysis.nativeProjection = { ...pack.analysis.nativeProjection,
    objectsSource: "frozen_object_pages",
    objectInstruction: "A row with dimensions.objectsContext keeps its exact aggregate values. Read every object page with the same planContextRef, rowKey, columnKey 'objects', offset and limit; advance by nextOffset. These are the frozen observations, never current replacements." };
  pack.pages.push(...objectPages);
  if (pack.pages.length > GEO_FROZEN_ANALYSIS_LIMITS.pages || bytes(pack.analysis) > GEO_FROZEN_ANALYSIS_LIMITS.summaryBytes
    || pack.pages.reduce((sum, page) => sum + bytes(page.payload), 0) > GEO_FROZEN_ANALYSIS_LIMITS.totalBytes) throw tooLarge();
  return pack;
}
const objectPageId = (parentId, rowKey, index, analysisDigest, digest) => `gpcobject_${hash([parentId, rowKey, index, analysisDigest, digest])}`;

/** Keep the original inline/schema-1 representation when object paging is unnecessary. */
function freezeRows(analysis, { parentId, project, actorId }, forcePages = false) {
  if (
    analysis.page.shown !== analysis.page.total ||
    analysis.rows.length !== analysis.page.total
  )
    throw invalid();
  if (!forcePages && bytes(analysis) <= GEO_FROZEN_ANALYSIS_LIMITS.summaryBytes)
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
  // Small charts can contain independently computed unions (for example the
  // overlapping source-type remainder). Keep those exact counts and member
  // references; they are not recoverable by summing canonical row values.
  // Source charts have at most topN (<=50) plus one union remainder. If their
  // actual text exceeds the summary bound, refuse breadth rather than discard
  // an independently computed aggregate. Other small charts are retained too.
  const retainChart = analysis.chart && (['sources', 'source_facets'].includes(analysis.chart.kind)
    || bytes(analysis.chart) <= GEO_FROZEN_ANALYSIS_LIMITS.chartBytes);
  const compact = {
    ...analysis,
    // Charts and comparison summaries duplicate the canonical row values. Native
    // readers page those rows; copying every chart cell here defeated paging.
    chart: retainChart ? analysis.chart : analysis.chart ? { kind: analysis.chart.kind ?? null, labels: [], series: [], cells: [], source: "frozen_rows" } : analysis.chart,
    comparison: analysis.comparison ? { ...analysis.comparison, cells: [], cellsSource: "frozen_rows" } : analysis.comparison,
    nativeProjection: { chartDigest: analysis.chart ? hash(analysis.chart) : null,
      comparisonCellsDigest: analysis.comparison?.cells ? hash(analysis.comparison.cells) : null,
      instruction: retainChart ? "The bounded chart retains exact aggregate values and member references. Read every frozen row page for full table values and comparison evidence."
        : "Read every frozen row page for full values and comparison evidence; chart arrays are not repeated in this native projection." },
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
    !hasGeoFrozenAnalysisContext(parent.payload) ||
    parent.payload.state !== "bound" ||
    parent.payload.basisDigest !== hash(parent.payload.basis)
  )
    throw invalid();
  if (input.rowKey != null || input.columnKey != null) return readObjectPage(documents, project, parent, input);
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
    !hasGeoFrozenAnalysisContext(parent.payload) ||
    parent.payload.state !== "bound" ||
    parent.payload.basisDigest !== hash(parent.payload.basis) ||
    ![1, 2].includes(manifest.schemaVersion) ||
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
  let totalPages = manifest.pages.length;
  if (manifest.schemaVersion === 2) {
    if (!/^[a-f0-9]{64}$/.test(manifest.rowsDigest ?? "") || !/^[a-f0-9]{64}$/.test(manifest.projectedRowsDigest ?? "")
      || !Array.isArray(manifest.objects) || !manifest.objects.length || manifest.objects.length > GEO_FROZEN_ANALYSIS_LIMITS.pages) throw invalid();
    const keys = new Set(), indexes = new Set(), ids = new Set(manifest.pages.map(page => page.id));
    for (const context of manifest.objects) {
      if (typeof context.rowKey !== "string" || !context.rowKey || context.rowKey.length > 160 || keys.has(context.rowKey)
        || !Number.isSafeInteger(context.rowIndex) || context.rowIndex < 0 || context.rowIndex >= manifest.totalRows || indexes.has(context.rowIndex)
        || context.columnKey !== "objects" || !Number.isSafeInteger(context.total) || context.total < 1 || context.total > 20000
        || !/^[a-f0-9]{64}$/.test(context.digest ?? "") || !Array.isArray(context.pages) || !context.pages.length) throw invalid();
      keys.add(context.rowKey); indexes.add(context.rowIndex);
      let start = 0;
      for (const [index, page] of context.pages.entries()) {
        if (page.index !== index || page.start !== start || !Number.isSafeInteger(page.count) || page.count < 1
          || !Number.isSafeInteger(page.bytes) || page.bytes < 1 || page.bytes > GEO_FROZEN_ANALYSIS_LIMITS.pageBytes
          || !/^[a-f0-9]{64}$/.test(page.digest ?? "") || ids.has(page.id)
          || page.id !== objectPageId(parent.id, context.rowKey, index, frozen.digest, page.digest)) throw invalid();
        start += page.count; totalBytes += page.bytes; totalPages += 1; ids.add(page.id);
      }
      if (start !== context.total) throw invalid();
    }
  } else if (manifest.objects != null || manifest.projectedRowsDigest != null) throw invalid();
  if (
    expectedStart !== manifest.totalRows ||
    totalBytes > GEO_FROZEN_ANALYSIS_LIMITS.totalBytes || totalPages > GEO_FROZEN_ANALYSIS_LIMITS.pages
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

/** Return at most one verified storage page, even when limit would cross it. */
async function readObjectPage(documents, project, parent, input) {
  if (typeof input.rowKey !== "string" || !input.rowKey || input.rowKey.length > 160 || input.columnKey !== "objects") throw invalid();
  const frozen = parent.payload.basis.analysis, { limit, offset } = geoReadPage(input);
  const context = frozen.frozenPages?.schemaVersion === 2 ? frozen.frozenPages.objects?.find(item => item.rowKey === input.rowKey) : null;
  // The normal reader checks the entire manifest before any object page is read.
  let row = null;
  if (context) {
    const page = await readFrozenGeoAnalysisPage(documents, project, parent, { offset: context.rowIndex, limit: 1 });
    row = page.rows[0];
  } else {
    const total = frozen.frozenPages?.totalRows ?? frozen.rows.length;
    for (let at = 0; at < total && !row; at += 50) {
      const page = await readFrozenGeoAnalysisPage(documents, project, parent, { offset: at, limit: 50 });
      row = page.rows.find(item => item.key === input.rowKey) ?? null;
    }
  }
  if (!row || row.key !== input.rowKey) throw invalid();
  const response = (items, total, objectsDigest) => ({ rowKey: row.key, columnKey: "objects", unit: "context_objects", items, total,
    nextOffset: offset + items.length < total ? offset + items.length : null, digest: frozen.digest, objectsDigest, readingsKind: "submitted_input" });
  if (!context) {
    if (!Array.isArray(row.dimensions?.objects) || row.dimensions.objectsContext != null) throw invalid();
    return response(row.dimensions.objects.slice(offset, offset + limit), row.dimensions.objects.length, hash(row.dimensions.objects));
  }
  const expected = { schemaVersion: 1, total: context.total, digest: context.digest, pageRefs: context.pages.map(page => page.id) };
  if (row.dimensions.objects != null || canonicalJson(row.dimensions.objectsContext) !== canonicalJson(expected)) throw invalid();
  if (offset >= context.total) return response([], context.total, context.digest);
  const descriptor = context.pages.find(page => page.start <= offset && offset < page.start + page.count);
  if (!descriptor) throw invalid();
  const record = await documents.get(project.userId, "geo-plan-context", descriptor.id), payload = record?.payload;
  if (!record || record.id !== descriptor.id || record.kind !== "geo-plan-context" || record.projectId !== project.projectId
    || payload?.recordType !== "geo-analysis-object-page" || payload.schemaVersion !== 1 || payload.ownerId !== project.userId
    || payload.geoId !== project.id || payload.actorId !== parent.payload.actorId || payload.parentId !== parent.id
    || payload.analysisDigest !== frozen.digest || payload.rowKey !== row.key || payload.columnKey !== "objects"
    || payload.objectsDigest !== context.digest || payload.index !== descriptor.index || payload.start !== descriptor.start
    || !Array.isArray(payload.objects) || payload.objects.length !== descriptor.count || payload.digest !== descriptor.digest
    || bytes(payload) !== descriptor.bytes) throw invalid();
  const { digest: _digest, ...content } = payload;
  if (hash(content) !== descriptor.digest) throw invalid();
  const start = offset - descriptor.start;
  return response(payload.objects.slice(start, start + limit), context.total, context.digest);
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
