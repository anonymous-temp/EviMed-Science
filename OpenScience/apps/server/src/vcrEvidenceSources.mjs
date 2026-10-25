/** Preserved project sources use the same generation, text digest and quote locator as model parameters. */
import { createHash } from "node:crypto";
import { locateQuoteInText } from "@evimed/domain";
import { quoteIsPresent } from "@evimed/domain/clinical-evidence";
import { HttpError } from "./security.mjs";

const digest = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");
const invalid = () => new HttpError(400, "vcr_evidence_unverified", "The quotation must identify an exact span of the preserved source.");
/** Literal unit spellings, including explicit English time-unit plurals, do not perform a clinical conversion.
 * @param {string} quote @param {string} unit */
export function literatureUnitIsInQuote(quote, unit) {
  const normalized = unit.normalize("NFKC").trim().toLowerCase();
  // A number such as "1" is not evidence of a unit, and a dimensionless label still needs its own source wording.
  if (["", "1", "unknown", "unspecified", "not reported", "na", "n/a"].includes(normalized)) return false;
  const alternatives = [normalized, ...(["year", "month", "week", "day"].includes(normalized) ? [`${normalized}s`] : [])];
  return alternatives.filter(Boolean).some(value => new RegExp(`(?<![\\p{L}])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu").test(quote.normalize("NFKC")));
}
/** @param {string} text @param {any} span @param {string} quote */
function exactSpan(text, span, quote) {
  if (!Number.isSafeInteger(span?.start) || !Number.isSafeInteger(span?.end) || span.start < 0 || span.end <= span.start
    || span.end > text.length || text.slice(span.start, span.end) !== quote) throw invalid();
  return { start: span.start, end: span.end, quote };
}

/** This adapter reads existing SourceService captures; it does not retrieve or interpret articles.
 * @param {{sources:any}} dependencies */
export function createVcrEvidenceSources({ sources }) {
  return {
    /** @param {{userId:string,projectId:string,source:any,quote:string,locator:any,unit?:string}} input */
    async resolve({ userId, projectId, source: asked, quote, locator, unit = "" }) {
      const source = await sources.get(String(userId), String(asked?.sourceId ?? ""));
      if (!projectId || source.projectId !== projectId || String(source.userId) !== String(userId)) {
        throw new HttpError(404, "source_not_found", "Source not found in this study project.");
      }
      const capture = await sources.loadCapture(String(userId), source);
      const text = String(capture?.input?.text ?? "");
      const sourceHash = digest(text);
      if (!capture || source.payload?.generation !== asked?.generation || source.payload?.analysis?.textSha256 !== sourceHash
        || asked?.textSha256 !== sourceHash) throw new HttpError(409, "source_changed", "Read the current preserved source before extracting evidence.");
      const span = exactSpan(text, locator, quote);
      const parts = {};
      for (const field of ["ciLow", "ciHigh", "sampleSize", "events", "unit"]) {
        const part = locator?.parts?.[field];
        if (part) parts[field] = exactSpan(text, part, String(part.quote ?? ""));
      }
      return { text, sourceRef: `source:${source.id}:g${source.payload.generation}:${sourceHash}`,
        locator: { kind: "literature_text", sourceId: source.id, generation: source.payload.generation, sourceHash, textSha256: sourceHash,
          ...span, offsetUnit: "utf16", parts, inputs: Array.isArray(locator?.inputs) ? locator.inputs.map(String) : [],
          unitVerification: literatureUnitIsInQuote(quote, unit) || parts.unit && literatureUnitIsInQuote(parts.unit.quote, unit)
            ? { status: "verified", basis: parts.unit ? "companion_span_or_quotation" : "quotation" } : { status: "unknown", reason: "unit_not_in_quotation" },
          materialLocation: locateQuoteInText({ text, quote, matches: quoteIsPresent }) } };
    },
  };
}

/** Resolve only explicitly mapped baseline statistics. Quotation verification establishes source values, not transportability.
 * @param {{store:any,userId:string,studyId:string,baselineTable:any[],bindings:any[]}} input */
export async function verifyLiteratureBaseline({ store, userId, studyId, baselineTable, bindings }) {
  const rows = Array.isArray(baselineTable) ? baselineTable : [];
  const asked = Array.isArray(bindings) ? bindings : [];
  const ids = [...new Set(asked.map(binding => String(binding?.evidenceId ?? "")).filter(Boolean))];
  const evidence = new Map((await store.verifiedItemsById({ userId, studyId, ids })).map(row => [String(row.id), row]));
  /** @type {any[]} */ const issues = [], resolved = [];
  const units = new Map();
  /** @type {Set<any>} */ const used = new Set();
  for (const row of rows) {
    for (const field of ["mean", "sd", "proportion", "proportions", "min", "max"]) {
      if (row?.[field] == null) continue;
      const values = field === "proportions" ? row[field] : [row[field]];
      if (!Array.isArray(values)) { issues.push({ variable: row.variable, field, code: "baseline_value_invalid" }); continue; }
      for (const [index, value] of values.entries()) {
        const found = asked.filter(binding => binding?.variable === row.variable && binding?.field === field
          && (field === "proportions" ? binding.index === index : binding.index == null));
        const binding = found[0];
        const problem = (/** @type {string} */ code) => issues.push({ variable: row.variable, field, ...(field === "proportions" ? { index } : {}), code });
        if (found.length !== 1) { problem(found.length ? "baseline_binding_repeated" : "baseline_binding_missing"); continue; }
        used.add(binding);
        const item = evidence.get(String(binding.evidenceId));
        if (!item || item.locator?.verification !== "verified") { problem("baseline_evidence_unverified"); continue; }
        if (item.value_source !== "extracted" || item.detail?.evidenceKind !== "baseline" || item.detail?.verificationScope === "quoted_inputs_only"
          || item.enrollment_kind === "estimated" || item.detail?.sourceStanding === "registry_planned") {
          problem("reported_baseline_required"); continue;
        }
        const parameter = `${row.variable}.${field}${field === "proportions" ? `[${index}]` : ""}`;
        if (item.parameter !== parameter) { problem("baseline_statistic_differs"); continue; }
        if (item.locator?.kind === "literature_text" && item.locator?.unitVerification?.status !== "verified") {
          problem("baseline_source_unit_unverified"); continue;
        }
        const unit = String(binding.unit ?? "").trim();
        if (!unit || units.has(row.variable) && units.get(row.variable) !== unit) { problem("baseline_unit_missing_or_inconsistent"); continue; }
        units.set(row.variable, unit);
        const percent = String(item.unit).trim() === "%" && unit === "proportion" && ["proportion", "proportions"].includes(field);
        if (!percent && String(item.unit).trim() !== unit) { problem("baseline_unit_differs"); continue; }
        const converted = percent ? Number(item.value) / 100 : Number(item.value);
        if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(converted) || converted !== value) { problem("baseline_value_differs"); continue; }
        resolved.push({ variable: row.variable, field, ...(field === "proportions" ? { index } : {}), evidenceId: item.id, parameter,
          value, unit, sourceValue: Number(item.value), sourceUnit: item.unit, conversion: percent ? "percent_to_proportion" : "identity",
          sourceRef: item.source_ref ?? null, quote: item.quote, locator: item.locator, verification: "verified" });
      }
    }
  }
  if (!rows.length) issues.push({ code: "baseline_table_missing" });
  if (used.size !== asked.length) issues.push({ code: "baseline_binding_unused" });
  return { ok: issues.length === 0, issues, bindings: resolved, evidenceIds: [...new Set(resolved.map(binding => String(binding.evidenceId)))] };
}
