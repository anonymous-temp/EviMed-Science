import { HttpError } from './security.mjs';
import { VCR_IMPORT_FORMATS, VCR_TABLE_LIMITS } from './vcrIntakeLayout.mjs';
import { runPlaneImport } from './vcrIntakeStage.mjs';

/**
 * A source held in a standard format — FHIR resources, OMOP CDM tables, CDISC ADaM
 * transport files — turned into the module's own tables, a field map and a
 * dictionary.
 *
 * The conversion runs inside this deployment, in the intake container
 * (`vcrIntakeController.mjs`, operation `convert`: no network, no model, no
 * workspace, and of the data plane nothing but one read-only file and one empty
 * directory of its own scratch area). It is NOT sent to the external
 * document-parsing service and no research runtime ever sees it, by design and
 * by test: `test/vcrImport.test.mjs` walks the import graph as
 * `vcrRecordExtract.test.mjs` does.
 *
 * Hidden knowledge:
 *
 * - **The container measures and reports; this module decides.** The script
 *   (`vcr_import_convert.py`) writes tables and a `result.json`. Nothing in the
 *   result is believed because the script said it: every table is checked to be
 *   the file and the size and the SHA-256 the result names, held to the plane's
 *   own ceilings again, every name is held to its alphabet, and the coverage is
 *   rebuilt from a closed shape before it travels. The field map is not decided
 *   here either — the plane passes each entry through its own validation, the one
 *   a person's map goes through.
 * - **A file that is not what it claims to be is refused by name.** `fhir`,
 *   `omop` and `adam` are the claim; a file that is not JSON resources, not a zip
 *   of CSV tables, not a SAS transport file is `vcr_import_not_this_format`, with
 *   the container's own reason in the detail, and nothing is stored.
 * - **A skipped row is counted, never silent.** The coverage names what was read,
 *   imported and skipped and why, per resource type, table or dataset; what the
 *   container could not carry (a table past the plane's limit, an unsupported
 *   resource) is in it. Coverage never carries a patient value: its examples are
 *   vocabulary codes.
 * - **Values keep their source.** Each column of each table states whether its
 *   values are `observed` (a fact the source system recorded), `calculated` (what
 *   the converter computed from other columns) or `imputed`; the field map carries
 *   it per column, which is what the engine labels a result with.
 */

/** What the counters count, in the order the metrics list them. */
export const VCR_IMPORT_COUNTER_KEYS = Object.freeze(['importConverted', 'importRefused', 'importFailed']);

const RESULT_LIMIT = 4 * 1024 * 1024;
const MAX_TABLES = 64;
const TABLE_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CODE_WORD = /^[A-Za-z0-9_.:|/-]{1,120}$/;
const SOURCES = Object.freeze(['observed', 'extracted', 'calculated', 'imputed']);
const FIELD_MAP_ENTRIES = 500;
const DICTIONARY_ENTRIES = 500;
const COVERAGE_ITEMS = 200;

/** The reader-facing refusals: status, code, sentence, counter. */
const REFUSALS = Object.freeze({
  not_this_format: [422, 'vcr_import_not_this_format', 'The file is not what it was declared to be.', 'importRefused'],
  nothing: [422, 'vcr_import_nothing_to_import', 'The file holds nothing this import reads.', 'importRefused'],
  unreadable: [422, 'vcr_import_unreadable', 'The file could not be opened: it is damaged or protected.', 'importRefused'],
  version: [422, 'vcr_import_version_unsupported', 'This version of the format is not read.', 'importRefused'],
  too_large: [413, 'vcr_data_file_too_large', 'The file is larger than this deployment imports.', 'importRefused'],
  timeout: [504, 'vcr_intake_timeout', 'The conversion took too long and was stopped.', 'importFailed'],
  unavailable: [503, 'vcr_import_converter_unavailable', 'This deployment cannot convert this format.', 'importFailed'],
  changed: [409, 'vcr_intake_input_invalid', 'The staged file is not the file that was uploaded; upload it again.', 'importFailed'],
  failed: [502, 'vcr_intake_failed', 'The conversion did not finish.', 'importFailed'],
});

/** Which refusal a container's reason is. Every reason the script names is here; an unknown one is `failed`. */
const REASON_VERDICT = Object.freeze({
  not_fhir: 'not_this_format', not_json: 'not_this_format', not_zip: 'not_this_format', not_xpt: 'not_this_format',
  not_omop: 'not_this_format', not_adam: 'not_this_format',
  nothing_to_import: 'nothing', no_supported_resource: 'nothing', no_supported_table: 'nothing', no_supported_dataset: 'nothing',
  corrupt: 'unreadable', encrypted: 'unreadable', text_encoding: 'unreadable',
  xpt_version_unsupported: 'version',
  too_large: 'too_large',
  deadline: 'timeout', memory: 'timeout',
  converter_missing: 'unavailable',
  request_invalid: 'changed',
});

/** @param {unknown} value @param {number} max */
const word = (value, max) => [...String(value ?? '')].map(character => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character)).join('').trim().slice(0, max);
/** @param {unknown} value */
const count = value => (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : null);

/**
 * The refusal, as the error a route answers: a status, a registered code, the
 * sentence, and the container's own reason in the detail.
 * @param {keyof typeof REFUSALS} verdict @param {string} [reason]
 */
function refusalError(verdict, reason = '') {
  const [status, code, message] = REFUSALS[verdict];
  const error = new HttpError(Number(status), String(code), String(message));
  /** @type {any} */ (error).vcrDetail = { reason: word(reason, 60) };
  return error;
}

/**
 * The coverage as it travels: a closed shape rebuilt from what the container
 * said, with every string clipped and every number a count. Pure.
 * @param {any} raw
 */
export function normalizeCoverage(raw) {
  const inputs = (Array.isArray(raw?.inputs) ? raw.inputs : []).slice(0, COVERAGE_ITEMS).map((/** @type {any} */ item) => ({
    kind: word(item?.kind, 80), records: count(item?.records), imported: count(item?.imported) ?? 0,
    status: item?.status === 'imported' ? 'imported' : 'skipped', reason: word(item?.reason, 60) || null,
    // A table folded into another (OMOP's death into the person table) says which.
    ...(TABLE_NAME.test(String(item?.into ?? '')) ? { into: String(item.into) } : {}),
    skipped: Object.fromEntries(Object.entries(item?.skipped && typeof item.skipped === 'object' ? item.skipped : {})
      .filter(([reason, n]) => CODE_WORD.test(reason) && count(n) !== null).slice(0, 20)),
  })).filter((/** @type {{ kind: string }} */ item) => item.kind);
  const skippedTables = (Array.isArray(raw?.skippedTables) ? raw.skippedTables : []).slice(0, COVERAGE_ITEMS)
    .map((/** @type {any} */ item) => ({ table: word(item?.table, 60), reason: word(item?.reason, 60) })).filter((/** @type {{ table: string }} */ item) => item.table);
  const notices = (Array.isArray(raw?.notices) ? raw.notices : []).slice(0, COVERAGE_ITEMS).map((/** @type {any} */ item) => ({
    code: word(item?.code, 80), count: count(item?.count) ?? 0,
    ...(Array.isArray(item?.examples) ? { examples: item.examples.slice(0, 5).map((/** @type {unknown} */ example) => word(example, 120)).filter(Boolean) } : {}),
  })).filter((/** @type {{ code: string }} */ item) => CODE_WORD.test(item.code));
  return { inputs, skippedTables, notices };
}

/**
 * What a finished container's answer means. Pure: the result file's content in,
 * a verdict out, so the rule is testable without a container.
 * @param {{ format: string, result: any, limits: { maxTableBytes: number, maxRows?: number, maxColumns?: number } }} input
 * @returns {{ ok: true, standard: Record<string, string>, converter: Record<string, any>,
 *   tables: { name: string, file: string, rows: number, bytes: number, sha256: string, skipped: Record<string, number>,
 *     columns: { name: string, valueSource: string, label: string, unit: string, codingSystem: string }[] }[],
 *   fieldMap: Record<string, any>[], dictionary: { column: string, label: string, unit: string }[], coverage: ReturnType<typeof normalizeCoverage> }
 *   | { ok: false, verdict: keyof typeof REFUSALS, reason: string }}
 */
export function decideImport({ format, result, limits }) {
  if (!result || typeof result !== 'object' || result.protocol !== 1 || typeof result.outcome !== 'string') return { ok: false, verdict: 'failed', reason: 'result_unreadable' };
  if (result.outcome === 'refused') {
    const reason = word(result.reason, 60);
    return { ok: false, verdict: /** @type {keyof typeof REFUSALS} */ (Object.hasOwn(REASON_VERDICT, reason) ? /** @type {any} */ (REASON_VERDICT)[reason] : 'failed'), reason };
  }
  if (result.outcome !== 'converted' || result.format !== format) return { ok: false, verdict: 'failed', reason: 'result_unreadable' };
  const maxRows = limits.maxRows ?? VCR_TABLE_LIMITS.rows;
  const maxColumns = limits.maxColumns ?? VCR_TABLE_LIMITS.columns;
  const listed = Array.isArray(result.tables) ? result.tables : [];
  if (!listed.length || listed.length > MAX_TABLES) return { ok: false, verdict: 'failed', reason: 'tables_unreadable' };
  const seen = new Set();
  /** @type {any[]} */
  const tables = [];
  for (const table of listed) {
    const name = String(table?.name ?? '');
    const rows = count(table?.rows);
    const bytes = count(table?.bytes);
    const columns = Array.isArray(table?.columns) ? table.columns : [];
    if (!TABLE_NAME.test(name) || !name.startsWith(`${format}_`) || seen.has(name) || table?.file !== `${name}.csv`
      || rows === null || rows > maxRows || bytes === null || bytes < 1 || bytes > limits.maxTableBytes
      || !SHA256.test(String(table?.sha256 ?? '')) || !columns.length || columns.length > maxColumns) {
      return { ok: false, verdict: 'failed', reason: 'table_unreadable' };
    }
    seen.add(name);
    tables.push({
      name, file: `${name}.csv`, rows, bytes, sha256: String(table.sha256),
      skipped: Object.fromEntries(Object.entries(table.skipped && typeof table.skipped === 'object' ? table.skipped : {}).filter(([reason, n]) => CODE_WORD.test(reason) && count(n) !== null)),
      columns: columns.map((/** @type {any} */ column) => ({
        name: word(column?.name, 128), valueSource: SOURCES.includes(String(column?.valueSource)) ? String(column.valueSource) : 'observed',
        label: word(column?.label, 200), unit: word(column?.unit, 32), codingSystem: word(column?.codingSystem, 40),
      })),
    });
  }
  const files = new Set(tables.map(table => table.file));
  const fieldMap = (Array.isArray(result.fieldMap) ? result.fieldMap : []).slice(0, FIELD_MAP_ENTRIES)
    .filter((/** @type {any} */ entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && files.has(String(entry.table)));
  const dictionary = (Array.isArray(result.dictionary) ? result.dictionary : []).slice(0, DICTIONARY_ENTRIES).map((/** @type {any} */ entry) => ({
    column: word(entry?.column, 120), label: word(entry?.label, 120), unit: word(entry?.unit, 32),
  })).filter((/** @type {{ column: string }} */ entry) => entry.column);
  const extractor = result.converter && typeof result.converter === 'object' ? result.converter : {};
  const standard = result.standard && typeof result.standard === 'object' ? result.standard : {};
  return {
    ok: true,
    standard: Object.fromEntries(Object.entries(standard).slice(0, 6).map(([key, value]) => [word(key, 30), word(value, 60)])),
    converter: {
      name: word(extractor.name, 60), version: word(extractor.version, 20),
      libraries: Object.fromEntries(Object.entries(extractor.libraries ?? {}).slice(0, 8).map(([key, value]) => [word(key, 30), word(value, 20)])),
    },
    tables, fieldMap, dictionary, coverage: normalizeCoverage(result.coverage),
  };
}

/**
 * @param {{ config: any, controller?: { runVcrIntake?: Function } | null, counters?: Record<string, number>, report?: (code: string) => void }} deps
 */
export function createVcrImporter({ config, controller = null, counters = {}, report = () => {} }) {
  for (const key of VCR_IMPORT_COUNTER_KEYS) counters[key] ??= 0;
  /** @param {keyof typeof REFUSALS} verdict @param {string} [reason] */
  const refuse = (verdict, reason = '') => {
    const counter = String(REFUSALS[verdict][3]);
    counters[counter] = (counters[counter] ?? 0) + 1;
    return Object.assign(refusalError(verdict, reason), { vcrCounted: true });
  };
  const limits = () => ({
    maxTableBytes: Math.max(1024 * 1024, Number(config.vcrDataMaxBytes) || 50 * 1024 * 1024),
    maxRows: VCR_TABLE_LIMITS.rows, maxColumns: VCR_TABLE_LIMITS.columns,
  });
  const inputCap = () => Math.max(10 * 1024 * 1024, Number(config.vcrIntakeMaxBytes) || 25 * 1024 * 1024);

  return {
    counters,
    /** Whether a conversion can be attempted at all: a controller is composed. */
    get available() { return typeof controller?.runVcrIntake === 'function'; },
    /** What the intake page tells a person about this converter. */
    describe() {
      return {
        available: this.available,
        formats: Object.entries(VCR_IMPORT_FORMATS).map(([value, extensions]) => ({ value, extensions: [...extensions] })),
        maxBytes: inputCap(), maxTableBytes: limits().maxTableBytes, maxRows: limits().maxRows, maxColumns: limits().maxColumns,
      };
    },
    /**
     * Convert one upload. The bytes are streamed into the plane's scratch area
     * for the study, converted in the container, and `consume` receives the
     * verdict with an opener for each table while the attempt still exists; the
     * attempt is gone when this returns or throws. Every table is verified to be
     * the file the result names before `consume` is handed it.
     * @template T
     * @param {{ root: string, studyId: string, format: string, extension: string, stream: AsyncIterable<Buffer | Uint8Array>, signal?: AbortSignal }} input
     * @param {(done: Extract<ReturnType<typeof decideImport>, { ok: true }> & {
     *   table: (name: string) => Promise<{ stream: () => AsyncIterable<Buffer>, bytes: number, close: () => Promise<unknown> }>,
     *   input: { sha256: string, bytes: number } }) => Promise<T>} consume
     * @returns {Promise<T>}
     */
    async run({ root, studyId, format, extension, stream, signal }, consume) {
      if (!Object.hasOwn(VCR_IMPORT_FORMATS, format)) throw new HttpError(400, 'vcr_payload_invalid', 'format is one of: fhir, omop, adam.');
      if (!/** @type {readonly string[]} */ (VCR_IMPORT_FORMATS[/** @type {keyof typeof VCR_IMPORT_FORMATS} */ (format)]).includes(extension)) {
        throw new HttpError(415, 'vcr_data_format_unsupported', `A ${format} import is one of: ${VCR_IMPORT_FORMATS[/** @type {keyof typeof VCR_IMPORT_FORMATS} */ (format)].join(', ')}.`);
      }
      if (!this.available) throw refuse('unavailable', 'no_controller');
      try {
        return await runPlaneImport({
          root, studyId, controller: /** @type {any} */ (controller), format, extension, stream, cap: inputCap(), signal,
        }, async attempt => {
          const resultFile = await attempt.read('result.json', RESULT_LIMIT);
          let result = null;
          try { result = resultFile ? JSON.parse(resultFile.toString('utf8')) : null; } catch { result = null; }
          const decided = decideImport({ format, result, limits: limits() });
          if (decided.ok === false) throw refuse(decided.verdict, decided.reason);
          counters.importConverted += 1;
          return consume({
            ...decided,
            input: { sha256: attempt.fileSha256, bytes: attempt.bytes },
            /** One table, verified to be the file the result names: the size it was told, and the SHA-256 it was told. */
            table: async name => {
              const table = decided.tables.find(entry => entry.name === name);
              if (!table) throw refuse('failed', 'table_unknown');
              const opened = await attempt.openTable(table.file, table.bytes);
              try {
                if (await opened.sha256() !== table.sha256) throw refuse('failed', 'table_changed');
              } catch (error) {
                await opened.close();
                throw error;
              }
              return opened;
            },
          });
        });
      } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        if (error instanceof HttpError && typeof code === 'string' && code.startsWith('runtime_controller_')) {
          report(code);
          throw refuse('unavailable', 'controller');
        }
        // A refusal this module made is already counted; what the controller or the stage threw is counted here.
        if (error instanceof HttpError && !(/** @type {any} */ (error).vcrCounted) && ['vcr_intake_timeout', 'vcr_intake_failed', 'vcr_intake_busy'].includes(code)) counters.importFailed += 1;
        throw error;
      }
    },
  };
}
