/**
 * A paper's number, carried by the call that computes with it (2026-11-02).
 *
 * A median read in a paper goes straight into the scenario of `vcr_simulate`: the run has the number in hand and the computation to
 * make, and writing it down as evidence first, then as a card, then computing, is two calls it has no reason to make. Measured on
 * real runs: 0 of 6 designs whose control median came from a paper said so on the result page, and a line in the tool's answer
 * did not change that. So the one call carries it: beside the scenario the run may send `sources`, each entry the scenario field,
 * the paper (a PMID or a DOI) and the sentence that prints the number. The platform writes the evidence item and the card through the
 * writers the run would have called itself, and records which card each number of the job came from, so the quotation check, the
 * "reported, not checked" mark and the page's 文献 label are the existing ones.
 *
 * Hidden knowledge:
 *
 * - **A wrong entry costs that premise, never the computation (principle 19).** A field that is not one a paper's number can be
 *   tied to, a number the scenario does not hold, a sentence that does not print it, a store that did not answer: the job is queued
 *   with the scenario as written, the premise stays an assumption, and the answer says why, by field.
 * - **The number is the scenario's, the sentence is the paper's.** The value written as evidence is the one the scenario holds at the
 *   field; the existing evidence writer refuses a number its own sentence does not print (`quote_missing_number`), so a number the
 *   run mistyped, or took from memory and attached a sentence to, is not turned into a citation.
 * - **Only a single-study value.** No pooling, no verified status beyond what the capture check gives (a paper the platform never read is
 *   `reported_unverified`, and the page says 未核对), and a simulated value never reaches a card: the only inputs here are the run's
 *   scenario fields, which are assumptions or a paper's numbers, never an engine output.
 * - **The same entry again is the same card.** A run that sends the same three entries on each of three starts writes one evidence item
 *   and one card; a different number, paper or sentence for the key is a new version of the card, as any edit of a card is.
 * - **`validate` reads the shape and writes nothing.** It says which entries the platform will carry; the sentence is held against the
 *   paper when the job starts.
 *
 * @module vcrScenarioSources
 */

import { VCR_DEFAULT_TIME_UNIT, vcrTimeUnitOf } from "@evimed/domain";
import { vcrPublicationId } from "./vcrPublicationSources.mjs";

/** The most entries one call carries; the rest are said, not read. */
export const VCR_SOURCES_MAX = 8;

/**
 * The scenario fields a paper's number can be tied to: the leaf under `truth` (or under one `truths[]` entry of a grid), the endpoint
 * type that reads it, the evidence parameter and arm it is a quantity of, and the key of the card that states it. The card keys are the
 * ones `VCR_ASSUMPTION_BINDINGS` binds into those fields. `suffixed`: the key carries the endpoint (`control_median_tte`), as the binding
 * rule allows; the others are exact.
 * @type {ReadonlyArray<{ leaf: string, endpoint: string, parameter: string, armRole: "control" | "contrast", label: string, time?: boolean, suffixed?: boolean }>}
 */
export const VCR_SOURCE_PARAMETERS = Object.freeze([
  { leaf: "controlMedian", endpoint: "time_to_event", parameter: "control_median", armRole: "control", label: "对照组中位时间", time: true, suffixed: true },
  { leaf: "hazardRatio", endpoint: "time_to_event", parameter: "hazard_ratio", armRole: "contrast", label: "风险比", suffixed: true },
  { leaf: "controlRate", endpoint: "binary", parameter: "control_event_rate", armRole: "control", label: "对照组事件率" },
  { leaf: "oddsRatio", endpoint: "binary", parameter: "odds_ratio", armRole: "contrast", label: "优势比" },
  { leaf: "riskDifference", endpoint: "binary", parameter: "risk_difference", armRole: "contrast", label: "风险差" },
  { leaf: "effect", endpoint: "continuous", parameter: "mean_difference", armRole: "contrast", label: "均数差" },
  { leaf: "sd", endpoint: "continuous", parameter: "outcome_sd", armRole: "control", label: "结局的标准差" },
]);

/** The short word an endpoint type stands for in a card key. */
const ENDPOINT_KEY = Object.freeze(/** @type {Record<string, string>} */ ({ time_to_event: "tte", binary: "binary", continuous: "continuous" }));

/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});

/**
 * @typedef {object} SourceEntry
 * @property {number} index where the entry stood in the list
 * @property {string} field the scenario field as the run wrote it
 * @property {{ kind: "pmid" | "doi", id: string } | null} publication null when the paper could not be read from what was written
 * @property {string} quote the sentence that prints the number
 */

/**
 * The list as the call sent it: at most `VCR_SOURCES_MAX` entries, each an object. What cannot be read is said, never thrown.
 * `publication` is read from the forms a run writes (`PMID 123`, `10.1056/…`, `{ pmid }`, `{ doi }`), and `pmid` / `doi` beside it are
 * the same word.
 * @param {unknown} raw
 * @returns {{ entries: SourceEntry[], said: Array<{ index: number | null, field: string, state: "assumption", because: string, message: string }> }}
 */
export function readSourceEntries(raw) {
  if (raw === undefined || raw === null) return { entries: [], said: [] };
  if (!Array.isArray(raw)) {
    return { entries: [], said: [{ index: null, field: "", state: "assumption", because: "sources_not_a_list",
      message: "sources 是一个列表，每一项写 field（场景里的字段路径）、publication（PMID 或 DOI）和 quote（论文里印出这个数的原句）；这次没有读它，计算照常。" }] };
  }
  /** @type {SourceEntry[]} */
  const entries = [];
  /** @type {Array<{ index: number | null, field: string, state: "assumption", because: string, message: string }>} */
  const said = [];
  raw.slice(0, VCR_SOURCES_MAX).forEach((entry, index) => {
    const row = object(entry);
    const field = typeof row.field === "string" ? row.field.trim().slice(0, 160) : "";
    const paper = row.publication ?? (row.pmid != null ? { pmid: row.pmid } : row.doi != null ? { doi: row.doi } : null);
    entries.push({ index, field, publication: vcrPublicationId(paper), quote: typeof row.quote === "string" ? row.quote.trim().slice(0, 3000) : "" });
  });
  if (raw.length > VCR_SOURCES_MAX) {
    said.push({ index: null, field: "", state: "assumption", because: "too_many_sources", message: `一次最多带 ${VCR_SOURCES_MAX} 条来源，其余没有读；它们的前提仍是假设。` });
  }
  return { entries, said };
}

/**
 * A field path as the table names it: indices of a list are `[]`, and a path a run wrote from the top of the scenario (`scenario.truth…`)
 * or of a design's configuration is the same path.
 * @param {string} field @returns {string}
 */
export function normalizeSourceField(field) {
  return field.replace(/^(?:scenario|configuration)\./, "").replace(/\[\s*\d+\s*\]/g, "[]").replace(/\.\d+(?=\.|$)/g, "[]").replace(/\.\[\]/g, "[]");
}

/**
 * The value at a path of the scenario, the list indices read as they were written (`truths[0].hazardRatio`, `truths.0.hazardRatio`).
 * @param {Record<string, any>} scenario @param {string} field @returns {unknown}
 */
function valueAtField(scenario, field) {
  const path = field.replace(/^(?:scenario|configuration)\./, "").replace(/\[\s*(\d+)\s*\]/g, ".$1").split(".").filter(Boolean);
  /** @type {any} */
  let node = scenario;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

/**
 * What one entry would tie, or why it cannot be tied. Pure.
 * @param {SourceEntry} entry @param {Record<string, any>} scenario the scenario (or a design's configuration) the entry's field is in
 * @param {string | null} [endpointType] the endpoint type when the scenario does not state one (a design object states it beside its configuration)
 * @returns {{ ok: true, spec: (typeof VCR_SOURCE_PARAMETERS)[number], premisePath: string, value: number, unit: string, endpointKey: string, key: string }
 *   | { ok: false, because: string, message: string }}
 */
export function planSourceEntry(entry, scenario, endpointType = null) {
  const normal = normalizeSourceField(entry.field);
  const [section, leaf] = normal.split(/\.(?=[^.]+$)/);
  const spec = VCR_SOURCE_PARAMETERS.find((candidate) => candidate.leaf === leaf && (section === "truth" || section === "truths[]"));
  if (!entry.field || !spec) {
    return { ok: false, because: "field_not_supported", message: `「${entry.field}」不是能挂文献来源的场景字段。能挂的是 truth 下的 ${VCR_SOURCE_PARAMETERS.map((candidate) => candidate.leaf).join("、")}（按终点类型）；这个前提仍是你的假设。` };
  }
  const type = String(object(scenario.endpoint).type ?? endpointType ?? "");
  if (type && type !== spec.endpoint) {
    return { ok: false, because: "field_not_for_endpoint", message: `「${entry.field}」是 ${spec.endpoint} 终点的字段，这个场景的终点是 ${type}；这个前提仍是你的假设。` };
  }
  if (!entry.publication) {
    return { ok: false, because: "publication_unreadable", message: "publication 写 PMID（例如 PMID 18650514）或 DOI（10.xxxx/…）；这个前提仍是你的假设。" };
  }
  if (!entry.quote) {
    return { ok: false, because: "quote_missing", message: "quote 写论文里印出这个数的那句原话；这个前提仍是你的假设。" };
  }
  const raw = valueAtField(scenario, entry.field);
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  if (value === null) {
    return { ok: false, because: "no_number_at_field", message: `场景里 ${entry.field} 没有数：先把论文里的数写进场景这个字段，再带来源；这个前提仍是你的假设。` };
  }
  const endpointKey = ENDPOINT_KEY[spec.endpoint] ?? spec.endpoint;
  return {
    ok: true, spec, value, endpointKey,
    premisePath: section === "truth" ? `truth.${spec.leaf}` : normal,
    unit: spec.time ? (vcrTimeUnitOf(scenario.timeUnit) ?? VCR_DEFAULT_TIME_UNIT) : "",
    key: spec.suffixed ? `${spec.parameter}_${endpointKey}` : spec.parameter,
  };
}

/**
 * What `validate` says: which entries the platform will carry and why it will not carry the others. Reads the shape; writes nothing.
 * @param {unknown} raw @param {Record<string, any>} scenario
 */
export function checkSourceEntries(raw, scenario) {
  const { entries, said } = readSourceEntries(raw);
  const checked = entries.map((entry) => {
    const plan = planSourceEntry(entry, scenario);
    return plan.ok ? { field: entry.field, state: "ready", message: "平台会在启动时把这句原文对到论文上，写成文献来源。" }
      : { field: entry.field, state: "assumption", because: plan.because, message: plan.message };
  });
  return [...checked, ...said.map(({ index: _index, ...rest }) => rest)];
}

/**
 * The words the answer says a carried entry in: whether the sentence was found in what the platform read of the paper.
 * @param {string} state the evidence writer's verdict
 */
const CARRIED = Object.freeze(/** @type {Record<string, { checked: boolean, message: string }>} */ ({
  verified: { checked: true, message: "数和原句都在平台读到的论文里找到了：这个前提在结果页标为文献，注明论文。" },
  reported_unverified: { checked: false, message: "已记为这篇论文报告的数，但平台没有读到可核对的原文，或原句不在读到的部分里：结果页标为文献，注明论文，并写明未核对。" },
}));

/**
 * Carry the entries of one call: write the evidence item and the card of each through `write`, and say which card each number of the job
 * came from. Never throws; an entry that cannot be carried is an assumption and says why.
 *
 * @param {object} input
 * @param {unknown} input.raw the call's `sources`
 * @param {Record<string, any>} input.scenario the scenario the job runs (or a design's configuration)
 * @param {string | null} [input.endpointType]
 * @param {(what: "evidence_item" | "assumption", item: Record<string, any>) => Promise<{ ids: string[], issues: Array<Record<string, any>>, results?: any[] }>} input.write the gateway's own writer
 * @param {() => Promise<Array<Record<string, any>>>} input.cards the study's current cards
 * @param {(ids: string[]) => Promise<Array<Record<string, any>>>} input.evidence the evidence rows of some ids
 * @param {{ key: string, name?: string, endpoint?: string, effectRole?: string, note?: string } | null} [input.card] the card the run itself named (an assumption written with its source): its key, role and note, not the platform's
 * @returns {Promise<{ bound: Array<{ key: string, version: number, path: string, value: number }>, report: Array<Record<string, any>> }>}
 */
export async function carrySourceEntries({ raw, scenario, endpointType = null, write, cards, evidence, card: named = null }) {
  const { entries, said } = readSourceEntries(raw);
  /** @type {Array<{ key: string, version: number, path: string, value: number }>} */
  const bound = [];
  /** @type {Array<Record<string, any>>} */
  const report = [];
  for (const entry of entries) {
    const plan = planSourceEntry(entry, scenario, endpointType);
    if (!plan.ok) { report.push({ field: entry.field, state: "assumption", because: plan.because, message: plan.message }); continue; }
    try {
      const paper = /** @type {{ kind: "pmid" | "doi", id: string }} */ (entry.publication);
      const citation = `${paper.kind === "pmid" ? "PMID" : "DOI"} ${paper.id}`;
      // The same entry again is the card that already stands for it.
      const key = named?.key ?? plan.key;
      const standing = (await cards()).find((card) => card.key === key);
      /** @type {Record<string, any> | null} */
      let card = null;
      let state = "";
      if (standing && standing.sourceKind === "external_evidence" && Number(standing.pointValue) === plan.value && Array.isArray(standing.evidenceIds) && standing.evidenceIds.length === 1) {
        const [row] = await evidence(standing.evidenceIds.map(String));
        const same = row && row.parameter === plan.spec.parameter && row.locator?.publication?.id === paper.id && String(row.quote ?? "").trim() === entry.quote;
        if (same) { card = standing; state = String(row.locator?.verification ?? "") === "verified" ? "verified" : "reported_unverified"; }
      }
      if (!card) {
        const written = await write("evidence_item", {
          publication: { [paper.kind]: paper.id }, parameter: plan.spec.parameter, armRole: plan.spec.armRole, value: plan.value,
          ...(plan.unit ? { unit: plan.unit } : {}), valueSource: "extracted", quote: entry.quote, endpointKey: plan.endpointKey, evidenceKind: "outcome",
          note: "Named by the call that computed with it.",
        });
        const evidenceId = written.ids[0];
        if (!evidenceId) {
          report.push({ field: entry.field, state: "assumption", because: "not_recorded", message: `没能记下这条来源（${String(written.issues[0]?.message ?? "存储没有接受").slice(0, 200)}）；这个前提仍是你的假设，计算照常。` });
          continue;
        }
        state = String(written.results?.find((row) => row?.id === evidenceId)?.state ?? "");
        if (!CARRIED[state]) {
          report.push({ field: entry.field, state: "assumption", because: state === "quote_missing_number" ? "number_not_in_sentence" : state || "not_recorded",
            message: state === "quote_missing_number"
              ? `这句话里印的数和场景里 ${entry.field} 的 ${plan.value} 对不上（数要在原句里原样出现）：改成原句印的数，或去掉来源；这个前提仍是你的假设，计算照常。`
              : `这条来源没有通过核对（${state || "未知"}）；这个前提仍是你的假设，计算照常。` });
          continue;
        }
        const made = await write("assumption", {
          key, name: named?.name ?? plan.spec.label, endpoint: named?.endpoint ?? plan.endpointKey, unit: plan.unit || undefined, parameter: plan.spec.parameter,
          sourceKind: "external_evidence", evidenceIds: [evidenceId], note: named?.note ?? "Named by the call that computed with it.",
          ...(named?.effectRole ? { effectRole: named.effectRole } : {}),
        });
        const cardId = made.ids[0];
        card = cardId ? (await cards()).find((candidate) => candidate.id === cardId) ?? null : null;
        if (!card) {
          report.push({ field: entry.field, state: "assumption", because: "not_recorded", message: `没能写出这张卡（${String(made.issues[0]?.message ?? "存储没有接受").slice(0, 200)}）；这个前提仍是你的假设，计算照常。` });
          continue;
        }
      }
      bound.push({ key: String(card.key), version: Number(card.version), path: plan.premisePath, value: plan.value });
      report.push({ field: entry.field, state: "carried", paper: citation, checked: CARRIED[state].checked, message: CARRIED[state].message });
    } catch {
      report.push({ field: entry.field, state: "assumption", because: "unavailable", message: "这条来源暂时没能记下；这个前提仍是你的假设，计算照常。" });
    }
  }
  for (const note of said) report.push({ field: note.field, state: note.state, because: note.because, message: note.message });
  return { bound, report };
}

/**
 * An assumption written with its source (`sources: [{ publication, quote }]` on the item) as the single entry the pipeline carries: the
 * card's own key says which parameter it states, its `pointValue` is the number, its `unit` the time unit. Null when the item is not one
 * a paper's number can be tied to; the caller then writes it as the run's own assumption and says why.
 * @param {Record<string, any>} row the assumption item
 * @returns {{ raw: Array<Record<string, any>>, scenario: Record<string, any>, endpointType: string, card: { key: string, name?: string, endpoint?: string } } | { because: string, message: string }}
 */
export function assumptionSourceEntry(row) {
  const key = typeof row.key === "string" ? row.key : "";
  const spec = VCR_SOURCE_PARAMETERS.find((candidate) => key === candidate.parameter || key.startsWith(`${candidate.parameter}_`));
  const given = Array.isArray(row.sources) && row.sources.length === 1 ? object(row.sources[0]) : null;
  if (!given) return { because: "one_source", message: "一张卡一个来源：sources 写一项 {publication, quote}；这张卡先按你的设定写下，仍是假设。" };
  if (!spec) {
    return { because: "field_not_supported", message: `这张卡的 key（${key}）不是能挂文献来源的参数。能挂的是以 ${VCR_SOURCE_PARAMETERS.map((candidate) => candidate.parameter).join("、")} 开头的 key；这张卡先按你的设定写下，仍是假设。` };
  }
  const pointValue = typeof row.pointValue === "number" ? row.pointValue : null;
  return {
    raw: [{ ...given, field: `truth.${spec.leaf}` }],
    scenario: { endpoint: { type: spec.endpoint }, truth: { [spec.leaf]: pointValue }, ...(typeof row.unit === "string" ? { timeUnit: row.unit } : {}) },
    endpointType: spec.endpoint,
    card: { key, ...(typeof row.name === "string" && row.name ? { name: row.name } : {}), ...(typeof row.endpoint === "string" && row.endpoint ? { endpoint: row.endpoint } : {}),
      ...(typeof row.effectRole === "string" && row.effectRole ? { effectRole: row.effectRole } : {}), ...(typeof row.note === "string" && row.note ? { note: row.note.slice(0, 1000) } : {}) },
  };
}
