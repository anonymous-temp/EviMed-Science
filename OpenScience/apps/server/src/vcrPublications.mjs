/**
 * The public 「模拟研究」 column: a study lead may publish one of the study's reports (`simulation_report`,
 * `model_analysis_report`) where anybody can read it (flywheel plan §5.6, 2026-10-06, ruling 10).
 *
 * Hidden knowledge:
 *
 * - **The column carries aggregates and nothing else, and the guarantee is built into the order of the work.** The report model of
 *   the export is passed through `service.forModel` — the one boundary every read of a model passes, plane addresses stripped and
 *   every cell under the minimum people count suppressed — *before* the report's template is rendered against it. A small count
 *   therefore reaches the page as 「未计算」, exactly as it reaches a run, and no later step has a number to leak: suppressing the
 *   finished text would be too late, the digits are already prose. The words of the report are the run's and a run can type
 *   anything, so the one fact about a person this module can still check by exact match is checked: a pseudonymous subject key of
 *   this study in the title, the summary or a section is refused by name (`vcr_publication_patient_data`).
 * - **Every number carries the word for where it came from.** A value bound in the template is published with the nine-label
 *   value source (`observed … synthetic`) of the measure, assumption or count it was read from — the label the study's own page
 *   prints. A number whose source nothing names is labelled the way the page labels it, conservatively (`predicted`), never
 *   `observed`.
 * - **A simulated number is not evidence, and the column is built so it cannot become one.** The rows live in their own table and
 *   are read only by this reader; nothing here writes an evidence card, a zone, a frontier item or a growth-content batch, and the
 *   card contract refuses a value labelled predicted, assumed or synthetic by name (`evidenceValueSourceIssues`) whatever carries
 *   it. The reader hands the public page the fixed sentence saying so with every publication.
 * - **A publication is a frozen copy.** The numbers, the limitations and the receipts are the form the lead saw when they
 *   published; a result recomputed afterwards does not move a public number. Withdrawing hides the row from the reader and keeps
 *   it as the record of what was once public. One live publication per export: asking again returns the live one.
 * - **Off is invisible.** With `OPEN_SCIENCE_VCR_PUBLIC_SIMULATIONS_ENABLED` off the module composes neither the service nor the
 *   reader, the routes answer 404 `vcr_publications_not_enabled`, and no table is read.
 *
 * @module vcrPublications
 */

import {
  VCR_COUNT_LABELS_ZH, VCR_INTENDED_USE_LABELS_ZH, VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH, VCR_VALUE_SOURCES, VCR_VALUE_SOURCE_LABELS_ZH,
  readNumberPath,
} from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { renderVcrNumbers, vcrExportHoldsDocument } from "./vcrRender.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { vcrId } from "./vcrStoreBase.mjs";
import { defaultSourceOf, measureLabel } from "./vcrViewsKit.mjs";

/** The two reports a lead may publish: the simulation report and the model analysis report (ICH M15). */
export const VCR_PUBLICATION_KINDS = Object.freeze(["simulation_report", "model_analysis_report"]);

/** What every publication says about itself, in the reader's own words: the fixed sentence of ruling 10. */
export const VCR_SIMULATION_NOT_EVIDENCE = "模拟研究的结果是模型按假设算出来的，不是证据：不能当作临床结论，也不能当作循证依据引用。";

/** The longest title and summary a lead may write, in characters. */
export const VCR_PUBLICATION_LIMITS = Object.freeze({ title: 120, summary: 600 });

/** Publications a public list answers at most in one page. */
export const VCR_PUBLICATION_PAGE_MAX = 100;

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value */
const iso = (value) => (value ? new Date(/** @type {any} */ (value)).toISOString() : null);

/**
 * The label a value is published under, and the word for where it came from. The nearest object on the way to the number that
 * names a source says it (a measure's `source`, an assumption card's `valueSource`); otherwise the kind of result the path lives
 * in does, through the same default the study's page uses.
 * @param {Record<string, any>} model the (suppressed) report model @param {string} path the reference's path
 * @returns {{ label: string, valueSource: string }}
 */
export function publishedValueOf(model, path) {
  const segments = String(path).split(".");
  /** The objects the path passed through, innermost first. */
  const holders = [];
  for (let end = segments.length - 1; end >= 1; end -= 1) holders.push(readNumberPath(model, segments.slice(0, end).join(".")));
  const objects = holders.map((holder) => object(holder));
  const named = objects.find((holder) => VCR_VALUE_SOURCES.includes(holder.source) || VCR_VALUE_SOURCES.includes(holder.valueSource));
  const card = objects.find((holder) => typeof holder.key === "string" && typeof holder.name === "string" && "valueSource" in holder);
  const measure = objects.find((holder) => typeof holder.name === "string" && "value" in holder && !("key" in holder));
  const last = segments.at(-1) ?? "";
  const label = card ? String(card.name) : measure ? measureLabel(String(measure.name))
    : (/** @type {Record<string, string>} */ (VCR_COUNT_LABELS_ZH))[last] ?? last;
  if (named) {
    const source = VCR_VALUE_SOURCES.includes(named.source) ? named.source : named.valueSource;
    return { label, valueSource: source };
  }
  // No object on the way names its source: the kind of result the number sits in decides, conservatively.
  const top = segments[0] ?? "";
  const resultKind = top === "scenarioResults" ? "trial_scenario"
    : top === "results" ? String(segments[1] ?? "")
      : Object.keys(object(model.results)).includes("trial_scenario") ? "trial_scenario" : Object.keys(object(model.results))[0] ?? "";
  return { label, valueSource: resultKind ? defaultSourceOf(resultKind, measure ?? {}, { populationKind: model.populationKind ?? null }) : "predicted" };
}

/**
 * The heading of one report section: the model documents name their sections in the platform's words, the simulation report
 * writes a single `main`.
 * @param {string} kind @param {string} section @param {string} title
 */
function headingOf(kind, section, title) {
  if (section === "main") return title;
  return (/** @type {Record<string, string>} */ (VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH))[section] ?? section;
}

/**
 * What the public reads of one export: the sections with their bound numbers, the limitations the cover states, the intended use
 * and the engine receipts the results stand on.
 *
 * @param {{ model: Record<string, any>, reports: readonly any[], kind: string, title: string, results?: readonly any[] }} input
 *   `model` is the report model after the runtime's boundary (`service.forModel`), never before it.
 */
export function publicationContent({ model, reports, kind, title }) {
  const sections = reports.map((report) => {
    const rendered = renderVcrNumbers(String(report?.template ?? ""), model);
    /** @type {Array<{ label: string, value: number, unit: string | null, valueSource: string, valueSourceLabel: string, text: string }>} */
    const values = [];
    for (const binding of rendered.bindings) {
      if (!binding.ok || typeof binding.value !== "number" || !Number.isFinite(binding.value)) continue;
      const { label, valueSource } = publishedValueOf(model, binding.path);
      values.push({
        label, value: binding.value, unit: binding.unit ?? null, valueSource,
        valueSourceLabel: (/** @type {Record<string, string>} */ (VCR_VALUE_SOURCE_LABELS_ZH))[valueSource] ?? valueSource, text: binding.rendered,
      });
    }
    return { heading: headingOf(kind, String(report?.section ?? "main"), title), text: rendered.text, values };
  });
  const use = String(model.intendedUse ?? model.study?.intendedUse ?? "exploratory");
  const records = list(object(model.review).records);
  const current = records.filter((record) => object(record).current !== false && object(record).status !== "failed").length;
  const stale = list(model.stale).length;
  const seal = object(model.seal);
  const limitations = [
    current ? `已有 ${current} 项复核；复核是签注，不是证据。` : "尚未完成复核。",
    ...(stale ? [`有 ${stale} 项结果在上游变更后尚未重算。`] : []),
    ...(seal.required && typeof seal.note === "string" && seal.note ? [seal.note] : []),
    VCR_SIMULATION_NOT_EVIDENCE,
  ];
  return {
    sections, limitations,
    intendedUse: (/** @type {Record<string, string>} */ (VCR_INTENDED_USE_LABELS_ZH))[use] ?? use,
    intendedUseKey: use,
  };
}

/**
 * The text a reader will see, joined, for the one exact-match check this module makes about a person.
 * @param {string} title @param {string} summary @param {readonly { heading: string, text: string }[]} sections
 */
function publicText(title, summary, sections) {
  return [title, summary, ...sections.flatMap((section) => [section.heading, section.text])].join("\n");
}

/**
 * The subject keys of this study that appear as whole words in some text. A subject key is the pseudonym the platform gave a
 * person in a study's matching data; a published page has no business naming one. Exact match over a closed list the database
 * holds — not a reading of the language.
 * @param {string} text @param {readonly string[]} keys
 */
export function subjectKeysIn(text, keys) {
  const found = [];
  for (const key of new Set(keys.map((entry) => String(entry)).filter((entry) => entry.length >= 3))) {
    const escaped = key.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    if (new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(text)) found.push(key);
  }
  return found;
}

/** @param {any} row */
function rowOf(row) {
  return {
    id: String(row.id), studyId: String(row.study_id), exportId: String(row.export_id), exportKind: String(row.export_kind),
    title: String(row.title), summary: String(row.summary ?? ""), publishedAt: /** @type {string} */ (iso(row.published_at)),
    withdrawnAt: iso(row.withdrawn_at),
  };
}

/**
 * The lead's side: publish and withdraw, and read what a study has published.
 *
 * @param {{ store: any, service: any, matchStore?: { factSubjects?: (studyId: string) => Promise<Array<{ subjectKey: string }>>, subjectSummaries?: (studyId: string) => Promise<Array<{ subjectKey: string }>> } | null,
 *   now?: () => Date }} dependencies
 */
export function createVcrPublications({ store, service, matchStore = null, now = () => new Date() }) {
  if (!store || !service) throw new TypeError("The publication service needs the VCR store and service.");
  const counters = { published: 0, existing: 0, withdrawn: 0, refused: 0 };

  /** @param {string} code @param {number} status @param {string} message */
  const refuse = (code, status, message) => { counters.refused += 1; return new HttpError(status, code, message); };

  /** The engine receipts the results of the export's model stand on: the execution and the engine job, never a path or a row. @param {any} model @param {string} studyId */
  async function receiptsOf(model, studyId) {
    const ids = new Set();
    for (const result of Object.values(object(model.results))) if (object(result).id) ids.add(String(object(result).id));
    for (const entry of Object.values(object(model.scenarioResults))) if (object(entry).id) ids.add(String(object(entry).id));
    if (!ids.size) return [];
    const rows = await store.rows(`SELECT r.id AS result_id, r.kind, e.id AS execution_id, e.method, e.method_version, e.receipt
      FROM ${VCR_SCHEMA}.results r JOIN ${VCR_SCHEMA}.executions e ON e.id = r.execution_id
      WHERE r.study_id = $1 AND r.id = ANY($2::text[]) ORDER BY r.created_at`, [studyId, [...ids]]);
    return rows.map((/** @type {any} */ row) => ({
      resultId: String(row.result_id), kind: String(row.kind), receiptId: String(row.execution_id), method: String(row.method),
      methodVersion: String(row.method_version ?? ""),
      ...(object(row.receipt).engineJobId ? { engineJobId: String(object(row.receipt).engineJobId) } : {}),
      signed: object(row.receipt).signed === true,
    }));
  }

  return {
    counters,

    /**
     * Publish one export of a study. The caller has already established that the user is the study's lead.
     * @param {{ id: string, name?: string }} user @param {any} study @param {{ exportId: string, title: string, summary: string }} input
     */
    async publish(user, study, { exportId, title, summary }) {
      const row = await store.exportRow(study.id, exportId);
      if (!row) throw refuse("vcr_export_not_found", 404, "Export not found.");
      if (!VCR_PUBLICATION_KINDS.includes(String(row.kind))) {
        throw refuse("vcr_export_kind_invalid", 400, `Only these reports are published to 模拟研究: ${VCR_PUBLICATION_KINDS.join(", ")}.`);
      }
      if (!vcrExportHoldsDocument(row.cover)) {
        throw refuse("vcr_publication_not_ready", 409, "这份报告还没有写完，写完后再发布到模拟研究。");
      }
      const live = await store.one(`SELECT * FROM ${VCR_SCHEMA}.published_simulations WHERE study_id = $1 AND export_id = $2 AND withdrawn_at IS NULL`,
        [study.id, exportId]);
      if (live) { counters.existing += 1; return { ...rowOf(live), existing: true }; }

      // The runtime's boundary first, the template second: a small cell is a number that never existed for the reader.
      const model = service.forModel(object(row.cover).results ?? {});
      const reports = list(object(row.cover).reports).length ? list(row.cover.reports) : list([row.cover.report]).filter(Boolean);
      const content = publicationContent({ model, reports, kind: String(row.kind), title });
      const keys = [
        ...(matchStore?.factSubjects ? (await matchStore.factSubjects(study.id)).map((entry) => entry.subjectKey) : []),
        ...(matchStore?.subjectSummaries ? (await matchStore.subjectSummaries(study.id)).map((entry) => entry.subjectKey) : []),
      ];
      const named = subjectKeysIn(publicText(title, summary, content.sections), keys);
      if (named.length) {
        throw refuse("vcr_publication_patient_data", 422, "这份报告的文字里出现了本研究受试者的编号，不能公开；去掉后再发布。");
      }
      const receipts = await receiptsOf(model, study.id);
      const id = vcrId("simulation");
      const producer = { kind: "researcher", name: String(user.name ?? "").trim().slice(0, 80) };
      const saved = await store.transaction(async (/** @type {any} */ client) => {
        const inserted = (await client.query(`INSERT INTO ${VCR_SCHEMA}.published_simulations
          (id, study_id, user_id, published_by, export_id, export_kind, title, summary, producer, sections, limitations, intended_use, intended_use_key, receipts, published_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14::jsonb, $15)
          ON CONFLICT (study_id, export_id) WHERE withdrawn_at IS NULL DO NOTHING RETURNING *`,
        [id, study.id, study.userId, String(user.id), exportId, String(row.kind), title, summary, JSON.stringify(producer),
          JSON.stringify(content.sections), JSON.stringify(content.limitations), content.intendedUse, content.intendedUseKey,
          JSON.stringify(receipts), now().toISOString()])).rows[0];
        if (inserted) {
          await store.audit({ client, studyId: study.id, userId: study.userId, actor: String(user.id), action: "vcr.simulation.publish", object: id,
            detail: { exportId, kind: String(row.kind) } });
        }
        return inserted ?? null;
      });
      if (!saved) {
        // Two clicks at once: the second finds the first's row.
        const winner = await store.one(`SELECT * FROM ${VCR_SCHEMA}.published_simulations WHERE study_id = $1 AND export_id = $2 AND withdrawn_at IS NULL`,
          [study.id, exportId]);
        counters.existing += 1;
        return { ...rowOf(winner), existing: true };
      }
      counters.published += 1;
      return { ...rowOf(saved), existing: false };
    },

    /**
     * Withdraw one publication of this study. The row stays as the record; the reader no longer finds it.
     * @param {{ id: string }} user @param {any} study @param {string} publicationId
     */
    async withdraw(user, study, publicationId) {
      const row = await store.transaction(async (/** @type {any} */ client) => {
        const found = (await client.query(`UPDATE ${VCR_SCHEMA}.published_simulations SET withdrawn_at = $3, withdrawn_by = $4
          WHERE id = $1 AND study_id = $2 AND withdrawn_at IS NULL RETURNING *`, [publicationId, study.id, now().toISOString(), String(user.id)])).rows[0];
        if (found) {
          await store.audit({ client, studyId: study.id, userId: study.userId, actor: String(user.id), action: "vcr.simulation.withdraw", object: publicationId });
        }
        return found ?? null;
      });
      if (!row) throw refuse("vcr_publication_not_found", 404, "Publication not found.");
      counters.withdrawn += 1;
      return rowOf(row);
    },

    /** The study's live publications, newest first. @param {string} studyId */
    async forStudy(studyId) {
      const rows = await store.rows(`SELECT * FROM ${VCR_SCHEMA}.published_simulations WHERE study_id = $1 AND withdrawn_at IS NULL
        ORDER BY published_at DESC, id DESC LIMIT 100`, [studyId]);
      return rows.map(rowOf);
    },
  };
}

/**
 * The reader the public pages package takes: one list, one document, both of what was published and not withdrawn, of studies that
 * still exist. Everything it returns was frozen at publication; it reads nothing of the study.
 *
 * @param {{ store: any, counters?: { reads: number } }} dependencies
 * @returns {{ list: (query?: { limit?: number, before?: string | null }) => Promise<Array<{ id: string, title: string, summary: string, studyKind: string, publishedAt: string, producer: { kind: string, name: string } }>>,
 *   get: (id: string) => Promise<any | null>, counters: { reads: number } }}
 */
export function createVcrPublicSimulations({ store, counters = { reads: 0 } }) {
  if (!store) throw new TypeError("The public simulation reader needs the VCR store.");
  const live = `p.withdrawn_at IS NULL AND s.deleted_at IS NULL`;
  return {
    counters,
    async list({ limit = 20, before = null } = {}) {
      counters.reads += 1;
      const size = Math.max(1, Math.min(VCR_PUBLICATION_PAGE_MAX, Math.trunc(Number(limit)) || 20));
      const rows = await store.rows(`SELECT p.id, p.title, p.summary, p.export_kind, p.published_at, p.producer
        FROM ${VCR_SCHEMA}.published_simulations p JOIN ${VCR_SCHEMA}.studies s ON s.id = p.study_id
        WHERE ${live} AND ($1::text IS NULL OR (p.published_at, p.id) < (SELECT q.published_at, q.id FROM ${VCR_SCHEMA}.published_simulations q WHERE q.id = $1))
        ORDER BY p.published_at DESC, p.id DESC LIMIT ${size}`, [before ? String(before) : null]);
      return rows.map((/** @type {any} */ row) => ({
        id: String(row.id), title: String(row.title), summary: String(row.summary ?? ""), studyKind: String(row.export_kind),
        publishedAt: /** @type {string} */ (iso(row.published_at)), producer: { kind: String(object(row.producer).kind ?? "researcher"), name: String(object(row.producer).name ?? "") },
      }));
    },
    async get(id) {
      counters.reads += 1;
      const row = await store.one(`SELECT p.* FROM ${VCR_SCHEMA}.published_simulations p JOIN ${VCR_SCHEMA}.studies s ON s.id = p.study_id
        WHERE p.id = $1 AND ${live}`, [String(id)]);
      if (!row) return null;
      return {
        id: String(row.id), title: String(row.title), summary: String(row.summary ?? ""), studyKind: String(row.export_kind),
        publishedAt: iso(row.published_at), producer: { kind: String(object(row.producer).kind ?? "researcher"), name: String(object(row.producer).name ?? "") },
        sections: list(row.sections), limitations: list(row.limitations), intendedUse: String(row.intended_use ?? ""), receipts: list(row.receipts),
        notEvidence: VCR_SIMULATION_NOT_EVIDENCE,
      };
    },
  };
}
