/** Conversation adapter over the existing protected upload, mapping and snapshot pipeline.
 * Only a current, owned source-service upload supplies original bytes. A runtime path is never an input. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalJson, sourceOriginOf, VCR_FIELD_ROLES, VCR_RECORDS_IMPORT_INPUTS, VCR_TIME_KINDS, VCR_MISSING_REASONS, VCR_REAL_PATIENT_SOURCES } from '@evimed/domain';
import { HttpError, openScopedFileNoFollow, readStableFileHandle, resolveScopedPath } from './security.mjs';
import { normalizeFieldMap, VCR_FIELD_MAP_ENTRY_KEYS, VCR_DECLARED_TYPES } from './vcrDataPlane.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code = 'vcr_intake_source_invalid') => new HttpError(400, code, 'Select a current owned upload with its returned generation and SHA-256; runtime files are not original patient sources.');
const ACTION_FIELDS = Object.freeze({
  import: ['action', 'sourceId', 'generation', 'sha256', 'name'],
  import_documents: ['action', 'sourceId', 'generation', 'sha256', 'sources', 'name', 'subjectColumn', 'textColumn', 'dateColumn', 'fileColumn'],
  import_standard: ['action', 'sourceId', 'generation', 'sha256', 'name', 'format'],
  propose_map: ['action', 'sourceId', 'columns'],
  confirm_map: ['action', 'sourceId', 'hash'],
  freeze: ['action', 'sourceId', 'hash', 'asOf'],
});
/**
 * Whether a data_intake payload has the shape of one typed action: a known action and only that action's fields. Nothing is read or
 * created to decide it, so the gateway asks it before it opens a scope for the call (a refused shape creates no hidden task).
 * @param {unknown} input @returns {boolean}
 */
export function dataIntakeShapeValid(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const action = /** @type {Record<string, unknown>} */ (input).action;
  return typeof action === 'string' && Object.hasOwn(ACTION_FIELDS, action)
    && Object.keys(input).every(key => /** @type {readonly string[]} */ (ACTION_FIELDS[/** @type {keyof typeof ACTION_FIELDS} */ (action)]).includes(key));
}
export const VCR_DATA_INTAKE_CONTRACT = Object.freeze({
  actions: ACTION_FIELDS,
  import: { required: ['action', 'sourceId', 'generation', 'sha256'], formats: ['csv', 'tsv', 'json', 'xlsx'], maxBytes: 32 * 1024 * 1024,
    sourceId: 'source-service upload id, not a workspace path or a data-plane source id', generation: 'positive integer returned by data_intake read', sha256: 'current original bytes digest returned by data_intake read' },
  import_documents: { required: ['action', 'sourceId or sources'], formats: ['csv', 'tsv', 'xlsx', 'zip', 'txt', 'md', 'pdf', 'docx', 'png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp'],
    runs: 'as a job: a table with a note column, a roster file with a folder or zip of notes, or a zip alone; several documents per person; a file that cannot be read is listed and the others go on. The answer has jobId; a person is told when it ends.',
    sources: 'array of {sourceId,generation,sha256} from noteUploads and uploads, for a roster with its notes or a folder of files', sourceId: 'one original, from uploads or noteUploads',
    subjectColumn: 'optional: the column naming the person. Left out, the platform reads a sample and proposes which column is the person, the note and the date', textColumn: 'optional: the note column, or a list of them; no model-written replacement text', dateColumn: 'optional', fileColumn: 'optional: in a roster, the column naming each person\'s file' },
  import_standard: { required: ['action', 'sourceId', 'generation', 'sha256', 'format'], format: ['fhir', 'omop', 'adam'], runs: 'as a job: converted, mapped and frozen, with coverage in the result; conditions, labs and medications then reach matching' },
  propose_map: { required: ['action', 'sourceId', 'columns'], sourceId: 'data-plane source id returned by import',
    columns: { type: 'array', minItems: 1, maxItems: 500, item: { fields: VCR_FIELD_MAP_ENTRY_KEYS, required: ['column'],
      role: VCR_FIELD_ROLES, timeKind: VCR_TIME_KINDS, missingReason: VCR_MISSING_REASONS, type: VCR_DECLARED_TYPES, valueSource: VCR_REAL_PATIENT_SOURCES,
      table: 'exact returned source filename, e.g. source.csv', column: 'exact source header', unit: 'literal source unit, never infer from dataset title',
      identifier: 'boolean', parameter: 'optional endpoint/measurement token', alias: 'optional analysis column token',
      range: '[finite lower, finite upper]', codes: { event: '1-10 original codes', censored: '1-10 original codes', treated: '1-10 original codes', control: '1-10 original codes' } } } },
  confirm_map: { required: ['action', 'sourceId', 'hash'], hash: 'exact current proposed map hash; cannot change the map' },
  freeze: { required: ['action', 'sourceId', 'hash'], hash: 'exact confirmed map hash', asOf: 'optional explicit clinical visibility cutoff; never inferred from dataset year' },
  mutability: 'Confirmed field maps can be revised. A frozen snapshot is immutable and retains the exact map it froze; a revised map needs a new snapshot.',
  discovery: { kind: ['uploads', 'sources'], pagination: 'Follow nextRead.filter.cursor exactly; automatic native discovery is current-root plus project uploads, while explicit owned sourceId may be reused within the same project.' },
  permissions: 'No action grants cloud consent, expands allowed fields or makes automated messages human. Patient documents use the usual current grant and cloud projection checks.',
  sequence: ['read data_intake for owned source handles (patient notes: import_documents; FHIR, OMOP or ADaM: import_standard, both jobs that need no further step)', 'import', 'read snapshot_profile with returned sourceId', 'propose_map', 'confirm_map with returned hash', 'freeze with that hash', 'write population kind=real snapshotId=<returned snapshotId> and definition; build_cohort with returned population id'],
});

const uploadIsOwned = (source, origin) => source && !source.deletedAt && source.userId === origin.userId && source.projectId === origin.projectId
  && source.payload?.publication?.current !== false && source.payload?.connector?.type === 'upload'
  && source.payload?.paths?.length === 1 && sourceOriginOf({ connectorType: 'upload', path: source.payload.paths[0] }) === 'upload'
  && Number.isSafeInteger(source.payload.generation) && /^[a-f0-9]{64}$/.test(source.payload.fingerprint?.sha256 ?? '');

/** The account/project are resolved by the control plane, never accepted from a tool request. */
export function createVcrDataIntake({ store, dataStore, dataPlane, sources, resolveProject, sourceScope = async (_origin) => null, recordsImport = null }) {
  const permitted = async (origin, sourceId) => {
    const scope = await sourceScope(origin);
    const source = await sources.get(origin.userId, sourceId);
    if (source?.payload?.recordType !== 'vcr-upload-original' && scope != null && (!Array.isArray(scope) || !scope.includes(sourceId))) throw fail();
    if (!uploadIsOwned(source, origin)) throw fail();
    return source;
  };
  const intake = async (study, input, origin) => {
    if (!origin || !study || origin.userId !== study.userId || origin.projectId !== study.projectId
      || !dataIntakeShapeValid(input)) throw fail('vcr_intake_payload_invalid');
    if (['import_documents', 'import_standard'].includes(input.action)) {
      // A job: the handles are checked against this conversation when it starts, and what they hold is read there. Nothing is read here.
      if (!recordsImport) throw new HttpError(503, 'vcr_gateway_unavailable', 'Batch import is not available in this deployment.');
      const named = Array.isArray(input.sources) ? input.sources : [{ sourceId: input.sourceId, generation: input.generation, sha256: input.sha256 }];
      if (!named.length || named.length > VCR_RECORDS_IMPORT_INPUTS || named.some(item => typeof item?.sourceId !== 'string' || !item.sourceId)) throw fail();
      if (input.action === 'import_standard' && (named.length !== 1 || !['fhir', 'omop', 'adam'].includes(input.format))) throw fail('vcr_intake_payload_invalid');
      const given = input.subjectColumn ? { subjectColumn: input.subjectColumn, ...(input.textColumn ? { textColumn: input.textColumn } : {}), ...(input.dateColumn ? { dateColumn: input.dateColumn } : {}), ...(input.fileColumn ? { fileColumn: input.fileColumn } : {}) } : null;
      return recordsImport.start(study, { mode: input.action === 'import_standard' ? 'standard' : 'notes', inputs: named, columns: given, format: input.format ?? null, name: input.name ?? null }, origin);
    }
    if (typeof input.sourceId !== 'string' || !input.sourceId) throw fail();
    if (input.action === 'import') {
      const source = await permitted(origin, input.sourceId);
      const fingerprint = source.payload.fingerprint;
      if (input.generation !== source.payload.generation || input.sha256 !== fingerprint.sha256) throw fail('vcr_intake_source_changed');
      const project = await resolveProject(origin);
      if (project.id !== origin.projectId || project.userId !== origin.userId) throw fail();
      const relative = source.payload.paths[0];
      const extension = path.posix.extname(relative).slice(1).toLowerCase();
      if (!['csv', 'tsv', 'json', 'xlsx'].includes(extension)) throw fail('vcr_intake_format_invalid');
      // Read the exact descriptor no-follow under the owned project root, then verify its immutable source identity.
      const opened = await openScopedFileNoFollow(project.baseDir, resolveScopedPath(project.baseDir, relative));
      let bytes;
      try {
        const stat = await opened.handle.stat();
        if (!stat.isFile() || stat.size !== fingerprint.size || stat.size > 32 * 1024 * 1024) throw fail();
        bytes = await readStableFileHandle(opened.handle, stat);
      } finally { await opened.handle.close(); }
      if (hash(bytes) !== fingerprint.sha256) throw fail('vcr_intake_source_changed');
      // A deletion/republication during I/O invalidates admission rather than authorizing a stale original.
      const current = await permitted(origin, source.id);
      if (current.payload.generation !== input.generation || current.payload.fingerprint.sha256 !== input.sha256) throw fail('vcr_intake_source_changed');
      const provenance = { kind: 'owned_upload', sourceId: source.id, generation: input.generation, sha256: input.sha256 };
      const identity = hash(canonicalJson(provenance));
      return store.transaction(async client => store.database.withTransactionClient(client, async () => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`vcr-data-intake:${study.id}:${identity}`]);
        const prior = (await dataStore.listSourceFilesForStudy(study.id)).find(file => canonicalJson(file.detail?.import ?? null) === canonicalJson(provenance));
        const original = prior ? await dataStore.sourceInStudy(study.id, prior.sourceId) : null;
        if (original?.status === 'withdrawn') throw fail();
        const owned = original ?? await dataPlane.registerSource({ userId: origin.userId, studyId: study.id, name: input.name ?? 'Conversation upload',
          allowedUses: ['vcr', 'matching'], valueSource: 'observed', actor: origin.userId });
        if (!prior) {
          await dataPlane.storeUpload({ actor: origin.userId, studyId: study.id, sourceId: owned.id, name: `source.${extension}`, role: 'data',
            importedFrom: provenance, stream: (async function* () { yield bytes; })() });
        }
        return { ok: true, ids: [owned.id], issues: [], sourceId: owned.id, state: 'uploaded', profileRead: { what: 'snapshot_profile', filter: { sourceId: owned.id } } };
      }));
    }
    const source = await dataStore.sourceInStudy(study.id, input.sourceId);
    if (!source || source.userId !== origin.userId || source.status === 'withdrawn') throw fail();
    const base = { actor: origin.userId, userId: origin.userId, studyId: study.id, sourceId: source.id };
    if (input.action === 'propose_map') {
      const normalized = normalizeFieldMap(input.columns);
      if (!Array.isArray(input.columns) || !input.columns.length || normalized.issues.length) throw fail('vcr_intake_payload_invalid');
      const done = await dataPlane.proposeFieldMap({ ...base, columns: input.columns, by: 'run' });
      return { ok: !done.mapIssues.length && !done.entryIssues.length, ids: [source.id], issues: [...done.entryIssues, ...done.mapIssues],
        sourceId: source.id, hash: done.hash, state: 'map_proposed' };
    }
    if (typeof input.hash !== 'string' || input.hash !== source.fieldMapHash) throw fail('vcr_intake_map_changed');
    if (input.action === 'confirm_map') {
      await dataPlane.confirmFieldMap({ ...base, hash: input.hash, by: `run:${origin.runId}` });
      return { ok: true, ids: [source.id], issues: [], sourceId: source.id, hash: input.hash, state: 'map_confirmed', mapMutable: true, mutability: VCR_DATA_INTAKE_CONTRACT.mutability };
    }
    if (input.asOf != null && (typeof input.asOf !== 'string' || !Number.isFinite(Date.parse(input.asOf)))) throw fail('vcr_intake_payload_invalid');
    const done = await dataPlane.freezeSnapshot({ ...base, asOf: input.asOf, expectedFieldMapHash: input.hash });
    // No raw profile, data-plane address, row or unfiltered small-cell count leaves this adapter.
    return { ok: true, ids: [done.snapshot.id], issues: [], sourceId: source.id, snapshotId: done.snapshot.id, version: done.snapshot.version,
      state: 'snapshot_frozen', snapshotImmutable: true, mapMutable: true, mutability: VCR_DATA_INTAKE_CONTRACT.mutability, analysisTables: { registered: (done.tables?.registered ?? []).map(row => row.shape), refused: (done.tables?.refused ?? []).map(row => row.shape), failed: done.tables?.failed ?? null }, profileRead: { what: 'snapshot_profile', filter: { snapshotId: done.snapshot.id } } };
  };
  intake.read = async (study, filter, origin) => {
    if (!origin) throw fail();
    // What an import could not read, by name, for the conversation of the person who owns the study.
    if (filter.id != null && study?.id && study.userId === origin.userId) return { importReport: { jobId: String(filter.id), rows: await dataPlane.readJobReport(study.id, String(filter.id)) } };
    if (filter.offset != null || filter.kind != null && !['uploads', 'sources'].includes(filter.kind)) {
      throw new HttpError(400, 'vcr_read_filter_invalid', 'Use data_intake kind=uploads or sources and its exact returned cursor, not an offset.');
    }
    const scope = await sourceScope(origin);
    const page = filter.sourceId ? { items: [await permitted(origin, filter.sourceId)], nextCursor: null }
      : await sources.list(origin.userId, { projectId: origin.projectId, sessionId: origin.rootSessionId, kind: filter.kind, limit: filter.limit ?? 20, cursor: filter.cursor });
    const notes = await sources.noteCandidates?.(origin, { limit: filter.limit ?? 20, cursor: filter.noteCursor ?? null }).catch(() => null);
    const uploads = page.items.filter(source => uploadIsOwned(source, origin) && (source.payload.recordType === 'vcr-upload-original' || scope == null || Array.isArray(scope) && scope.includes(source.id)))
      .map(source => ({ sourceId: source.id, generation: source.payload.generation, sha256: source.payload.fingerprint.sha256,
        format: path.posix.extname(source.payload.paths[0]).slice(1).toLowerCase() }));
    const held = study.id ? await dataStore.listSourcesForStudy(study.id) : [];
    const snapshots = study.id ? await dataStore.listSnapshots({ studyId: study.id, limit: 50 }) : [];
    const tables = study.id ? await dataStore.listAnalysisTables({ studyId: study.id }) : [];
    return { uploads, more: Boolean(page.nextCursor), nextCursor: page.nextCursor ?? null, ...(notes?.uploads.length ? { noteUploads: notes.uploads } : {}),
      ...(page.nextCursor ? { nextRead: { what: 'data_intake', filter: { kind: filter.kind ?? 'uploads', limit: filter.limit ?? 20, cursor: page.nextCursor } } } : {}),
      ...(filter.kind !== 'sources' ? { sourceRead: { what: 'data_intake', filter: { kind: 'sources' } } } : {}), dataSources: held.filter(source => source.userId === origin.userId && source.status !== 'withdrawn').map(source => ({
      sourceId: source.id, mapState: source.fieldMapState, hash: source.fieldMapHash,
      missingPrerequisites: source.fieldMapState === 'none' ? ['field_map'] : source.fieldMapState !== 'confirmed' ? ['confirmed_map']
        : !snapshots.some(snapshot => snapshot.sourceId === source.id && snapshot.fieldMapHash === source.fieldMapHash) ? ['frozen_snapshot'] : [],
      snapshots: snapshots.filter(snapshot => snapshot.sourceId === source.id).map(snapshot => ({ snapshotId: snapshot.id, version: snapshot.version, currentMap: snapshot.fieldMapHash === source.fieldMapHash,
        analysisTables: tables.filter(table => table.snapshotId === snapshot.id).map(table => table.shape) })),
    })), ...(study.id ? { inputs: await dataPlane.taskInputAvailability(study, { id: origin.userId }) } : {}),
      contractRead: { what: 'contracts', filter: { kind: 'data_intake' } } };
  };
  return intake;
}
