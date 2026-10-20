/**
 * The generated records of a study, handed to the researcher as a file (R10, 2026-10-07).
 *
 * The engine had always generated them — a thousand synthetic people, a table of virtual patients — and put them in the data plane for
 * the next computation to read; no route, page or export gave them to the person who asked for them. A researcher who says 「帮我生成一批
 * 合成数据」 wants a file. This is that file, and what stands between it and a real person.
 *
 * Hidden knowledge:
 *
 * - **Only synthetic rows leave, and the method says so.** A result's table is downloadable when the method that wrote it is one the
 *   control plane files as synthetic (`VCR_DERIVED_SOURCES`: a scenario population, a literature population, a synthpop table, the
 *   virtual patients) and no input it read was a real person's — except the empirical synthesis, whose training data is real by design
 *   and whose output is the thing the quality report is about. A cohort built from real patients answers
 *   `vcr_records_not_synthetic` by name: the rows of a real patient never leave the data plane, whoever asks.
 * - **An empirical synthetic table travels with its leakage check.** A table made from real people is only as safe as the report
 *   that says how close it sits to them (replication, nearest neighbour, membership inference): without that report the file is
 *   refused (`vcr_records_quality_missing`), and with it the report is the sibling `….quality.json` — its own file, named in the
 *   CSV's first lines, so the two travel together.
 * - **The file says what it is, first.** The first lines are comments: that this is synthetic and not a real patient, how it was made,
 *   what it may be used for. Whoever opens it, a year later, from a mail attachment, reads that before a number.
 * - **What is read is what was written.** The file's hash is the one the result recorded when the engine's table was stored; a file that
 *   no longer matches (a restore, a hand edit) is refused rather than handed over under the result's name.
 * - **Every download is audited** — who, which result, which format, how many bytes — in the module's own audit table; a refusal is
 *   a line too, with the reason.
 * - **The page of rows goes through the same doors** (`rows`, `record`, `describe`): the person-level rows of a synthetic table are
 *   what a list shows, and a table that may not be downloaded may not be paged either. The hash is checked once per file (name, size
 *   and modification time), not once per page.
 *
 * @module vcrRecords
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { VCR_SYNTHETIC_USE_LABELS_ZH, vcrLocationIsValid } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VCR_DERIVED_SOURCES } from "./vcrJobs.mjs";
import { assertDataPlaneRoot } from "./vcrDataPlane.mjs";
import { POPULATION_METHOD_WORDS } from "./vcrPopulationProfileView.mjs";
import { qualityReportView } from "./vcrViewsTabs.mjs";
import { loadRowTable, outcomeStatistics, pageOfFile, pageOfTable, patientRecord, profileOfTable } from "./vcrRows.mjs";
import { vcrCalibration } from "./vcrCalibration.mjs";

/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);

/** What each downloadable result is, and the table of it that is kept. */
const DOWNLOADS = Object.freeze(/** @type {Record<string, { tables: readonly string[], title: string, file: string }>} */ ({
  population: { tables: ["population", "synthetic-population"], title: "合成人群", file: "synthetic-population" },
  patient_set: { tables: ["virtual-patients"], title: "虚拟患者", file: "virtual-patients" },
}));

/** The methods whose output is a person-level table of synthetic rows. */
const METHOD_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  ...Object.fromEntries(Object.entries({ "population.scenario": "scenario", "population.literature": "literature", "population.synthpop": "empirical_synthetic" })
    .map(([method, kind]) => [method, POPULATION_METHOD_WORDS[kind]])),
  "patients.continuous": "按研究设定的虚拟患者仿真器生成（连续终点）",
  "patients.binary": "按研究设定的虚拟患者仿真器生成（二分类终点）",
  "patients.longitudinal": "按研究设定的虚拟患者仿真器生成（纵向轨迹，混合效应模型）",
  "patients.time_to_event": "按研究设定的虚拟患者仿真器生成（事件时间终点）",
}));

/** The refusals of a download, by code, with the sentence the reader gets. */
const REFUSALS = Object.freeze(/** @type {Record<string, [number, string]>} */ ({
  vcr_records_not_found: [404, "这次计算没有可下载的记录：重新生成一次，再下载。"],
  vcr_records_not_synthetic: [403, "这是真实患者的记录，不能下载：真实患者的行不离开数据平面。"],
  vcr_records_quality_missing: [409, "这份经验合成的记录还没有质量报告和泄露检查，不能下载：先生成质量报告。"],
  vcr_records_unavailable: [503, "本部署没有接入数据平面，生成的记录暂时不能下载。"],
  // The rows as a page (2026-10-14): a patient the table does not hold, a column it does not have, a table too long to sort whole.
  vcr_patient_not_found: [404, "这一批记录里没有这位虚拟患者；回到名单重新选。"],
  vcr_rows_query_invalid: [400, "这张表没有这一列，不能按它排序或筛选；换一列再试。"],
  vcr_rows_too_large: [422, "这张表太长，不能整表排序；先用筛选缩小范围，或下载后在本地处理。"],
}));

/** @param {string} code */
const refusal = (code) => new HttpError(REFUSALS[code][0], code, REFUSALS[code][1]);

/**
 * The files whose bytes were checked against the hash their result recorded, by name, size and modification time: a page of rows is
 * a lookup, not a pass over the file with a digest at the start of it. A file that changes in any of the three is read again.
 * @type {Map<string, string>}
 */
const verified = new Map();

/**
 * @param {{ store: any, config?: Record<string, any> }} dependencies `store` is the module's own (results, executions, audit)
 */
export function createVcrRecords({ store, config = {} }) {
  /**
   * Everything that decides whether a result's records may leave, and what travels with them.
   * @param {{ id: string, name?: string }} study @param {string} resultId
   */
  async function locate(study, resultId) {
    const result = await store.result(study.id, resultId);
    const download = result ? DOWNLOADS[result.kind] : null;
    if (!result || !download) throw refusal("vcr_records_not_found");
    const execution = result.executionId
      ? await store.one(`SELECT method, inputs, finished_at FROM ${VCR_SCHEMA}.executions WHERE id = $1 AND study_id = $2`, [result.executionId, study.id]) : null;
    const method = String(execution?.method ?? "");
    // The rows of a real patient never leave: the method must be one that writes synthetic ones, and what it read must not be real.
    const synthetic = /** @type {Record<string, string>} */ (VCR_DERIVED_SOURCES)[method] === "synthetic";
    const read = list(execution?.inputs).map(object);
    const realInput = method !== "population.synthpop" && read.some((input) => input.kind === "snapshot" || (input.valueSource && input.valueSource !== "synthetic"));
    if (!synthetic || realInput) throw refusal("vcr_records_not_synthetic");
    const table = list(result.tables).map(object).find((entry) => download.tables.includes(String(entry.name)) && String(entry.location ?? "").startsWith("derived/"));
    if (!table || !/^[a-f0-9]{64}$/.test(String(table.sha256 ?? "")) || !vcrLocationIsValid(String(table.location))) throw refusal("vcr_records_not_found");
    const quality = method === "population.synthpop" ? qualityReportView(object(result.diagnostics).quality) : null;
    // A table made from real people is released with the check of how close it sits to them, or not at all.
    if (method === "population.synthpop" && !quality?.groups.some((/** @type {any} */ group) => group.key === "leakage" && group.rows.length)) throw refusal("vcr_records_quality_missing");
    const population = result.kind === "population"
      ? await store.one(`SELECT allowed_uses FROM ${VCR_SCHEMA}.populations WHERE study_id = $1 AND (result_id = $2 OR id = $3)`, [study.id, result.id, result.subjectId ?? ""]) : null;
    const uses = list(population?.allowed_uses).map(String).map((use) => /** @type {Record<string, string>} */ (VCR_SYNTHETIC_USE_LABELS_ZH)[use] ?? use);
    return { result, download, method, table, quality, uses, finishedAt: execution?.finished_at ? new Date(execution.finished_at).toISOString() : null };
  }

  /** The file the result's table is, read from the data plane and held to the hash the result recorded. @param {Record<string, any>} table */
  async function open(table) {
    const dir = String(config.vcrDataPlaneDir ?? "").trim();
    if (!dir) throw refusal("vcr_records_unavailable");
    const root = assertDataPlaneRoot(dir);
    const file = path.resolve(root, String(table.location));
    if (!file.startsWith(`${root}${path.sep}`)) throw refusal("vcr_records_not_found");
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw refusal("vcr_records_not_found");
    const key = `${file}\u0000${stat.size}\u0000${stat.mtimeMs}`;
    if (verified.get(key) !== String(table.sha256)) {
      const hash = createHash("sha256");
      await new Promise((resolve, reject) => { createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject); });
      if (hash.digest("hex") !== String(table.sha256)) throw refusal("vcr_records_not_found");
      verified.set(key, String(table.sha256));
      if (verified.size > 64) verified.delete(/** @type {string} */ (verified.keys().next().value));
    }
    return { file, bytes: stat.size };
  }

  /**
   * A result's table, through every door the download goes through (`locate`, `open`): the rows of a synthetic table, whole or — when
   * it is longer than memory holds — as the file to be streamed. Nothing about a real person's table is readable here.
   * @param {{ id: string, name?: string }} study @param {string} resultId @param {string | null} [kind] the result kind the caller reads
   */
  async function readable(study, resultId, kind = null) {
    const found = await locate(study, resultId);
    // A list of patients is a patient set's table, a list of the population a population's: another kind is not the table asked for.
    if (kind && found.result.kind !== kind) throw refusal("vcr_records_not_found");
    const opened = await open(found.table);
    return { ...found, file: opened.file, bytes: opened.bytes };
  }

  return {
    /**
     * The CSV of a result's generated records: the comment lines, then the table as the engine wrote it.
     * @param {{ id: string }} study @param {string} resultId
     * @returns {Promise<{ filename: string, header: string, file: string, bytes: number, method: string, qualityFile: string | null }>}
     */
    async csv(study, resultId) {
      const found = await locate(study, resultId);
      const opened = await open(found.table);
      const lines = [
        "# 合成数据，不是真实患者。",
        `# 生成方法：${METHOD_WORDS[found.method] ?? "引擎生成"}。`,
        ...(found.uses.length ? [`# 允许用途：${found.uses.join("、")}。合成的记录不进真实外部对照。`] : ["# 合成的记录不进真实外部对照。"]),
        ...(found.quality ? ["# 这份记录由真实数据经验合成而来：质量与泄露检查在同名的 .quality.json 里，一起使用。"] : []),
        "# 以 # 开头的行是说明，读入表格时跳过它们。",
      ];
      return { filename: found.download.file, header: `${lines.join("\n")}\n`, file: opened.file, bytes: opened.bytes, method: found.method,
        qualityFile: found.quality ? `${found.download.file}.quality.json` : null };
    },

    /**
     * One page of the rows of a result's table: filtered, sorted and cut by the server (`vcrRows.pageOfTable`). The same refusals as
     * the download; a table too long to sort answers `vcr_rows_too_large` and pages unsorted.
     * @param {{ id: string }} study @param {string} resultId @param {import("./vcrRows.mjs").VcrRowsQuery & { kind?: string | null }} query
     */
    async rows(study, resultId, query) {
      const found = await readable(study, resultId, query.kind ?? null);
      const table = await loadRowTable(found.file);
      const page = table.complete ? pageOfTable(table, query) : await pageOfFile(found.file, query);
      if ("issue" in page) {
        if (page.issue.error === "too_large") throw refusal("vcr_rows_too_large");
        throw refusal("vcr_rows_query_invalid");
      }
      const { ok: _ok, ...rest } = page;
      return { result: found.result.id, kind: found.result.kind, ...rest };
    },

    /**
     * One patient's record from a patient set's table.
     * @param {{ id: string }} study @param {string} resultId @param {string} patientId @param {string | null} [kind]
     */
    async record(study, resultId, patientId, kind = null) {
      const found = await readable(study, resultId, kind);
      const table = await loadRowTable(found.file);
      const record = table.complete ? patientRecord(table, patientId) : null;
      if (!record) throw refusal("vcr_patient_not_found");
      return { result: found.result.id, ...record };
    },

    /**
     * What a generated table is, from the table: the number of rows, the distribution of every variable (in the engine's own profile
     * shape) and, for a two-arm outcome table, the numbers the page sets beside what the study declared. `null` for a table that
     * cannot be read (not synthetic, not kept, no plane): the page then says what it holds without the rows.
     * @param {{ id: string }} study @param {string} resultId
     * @param {{ cards?: readonly Record<string, any>[], unitWord?: ((card: Record<string, any> | null) => string | null) | null,
     *   labels?: Record<string, string>, structuredErrors?: boolean }} [context] `labels`: what the study calls a variable, by column (the population's own profile)
     */
    async describe(study, resultId, { cards = [], unitWord = null, labels = {}, structuredErrors = false } = {}) {
      /** @type {Awaited<ReturnType<typeof readable>>} */
      let found;
      try { found = await readable(study, resultId); } catch (error) {
        if (error instanceof HttpError) return structuredErrors ? { available: false, state: "unavailable", code: error.code, message: error.message } : null;
        if (structuredErrors) return { available: false, state: "error", code: "vcr_records_unavailable", message: "记录读取失败；已保留汇总结果。" };
        throw error;
      }
      let table;
      try { table = await loadRowTable(found.file); } catch {
        if (structuredErrors) return { available: false, state: "error", code: "vcr_records_unavailable", message: "记录读取失败；已保留汇总结果。" };
        throw refusal("vcr_records_unavailable");
      }
      const statistics = table.complete ? outcomeStatistics(table) : null;
      const executionJob = found.result.executionId
        ? await store.one(`SELECT j.scenario FROM ${VCR_SCHEMA}.executions e JOIN ${VCR_SCHEMA}.jobs j ON j.id = e.job_id
            WHERE e.id = $1 AND e.study_id = $2`, [found.result.executionId, study.id]).catch(() => null) : null;
      return {
        result: found.result.id,
        rows: table.rows.length,
        complete: table.complete,
        profile: profileOfTable(table, { labels }),
        calibration: vcrCalibration({ statistics, scenario: executionJob?.scenario ?? null, cards, unitWord }),
      };
    },

    /**
     * The quality and leakage report of an empirical synthetic table, as the file that travels beside it.
     * @param {{ id: string }} study @param {string} resultId
     * @returns {Promise<{ filename: string, body: string }>}
     */
    async quality(study, resultId) {
      const found = await locate(study, resultId);
      if (!found.quality) throw refusal("vcr_records_not_found");
      const body = JSON.stringify({
        说明: "这份合成记录的质量与泄露检查：数值，不是结论。合成数据，不是真实患者。",
        生成方法: METHOD_WORDS[found.method] ?? null,
        允许用途: found.uses,
        质量报告: found.quality,
      }, null, 2);
      return { filename: `${found.download.file}.quality.json`, body: `${body}\n` };
    },

    /** The one line of the audit table a download leaves. @param {{ id: string }} study @param {string} userId @param {Record<string, any>} entry */
    async audit(study, userId, entry) {
      await store.audit({ studyId: study.id, userId, action: entry.format === "page" ? "vcr.records.page" : "vcr.records.download", object: String(entry.resultId ?? ""),
        outcome: entry.outcome === "ok" ? "ok" : "refused", reason: String(entry.reason ?? ""), detail: { format: entry.format, bytes: entry.bytes ?? null, method: entry.method ?? null } });
    },
  };
}
