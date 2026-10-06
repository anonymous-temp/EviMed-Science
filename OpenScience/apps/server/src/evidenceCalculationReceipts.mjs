/**
 * Where an evidence card's calculation basis is read back from (evidence-flywheel plan §5.1, F02/F03, 2026-10-06).
 *
 * A calculated claim names a receipt; the domain's check (`evidenceCalculationVerdict`) compares the claim with it and is
 * synchronous and pure. This file is the reading side: it turns what the platform already keeps — a result version of an
 * engine's calculation, the evolution module's recalculation receipt — into the one shape that check reads
 * (`EvidenceCalculationReceipt`: engine, method, inputs, machine values at their paths).
 *
 * Hidden knowledge:
 *
 * - **Tenancy is the scope list.** A reader is built with the (account, project) pairs it may read, and no others. The
 *   platform's cards cite the platform's own internal projects; a card that cites another account's result would be a
 *   cross-tenant read, so the reader has no way to be asked for one.
 * - **A result version is a receipt only when a method and machine values stand behind it.** A file a run wrote that no
 *   admitted calculation produced has neither (`method: null`, `machineValues: []`) and is not a receipt, however many
 *   numbers it prints.
 * - **Reading never fails a card.** A receipt that cannot be read is `null`; the card's claim then says its receipt is
 *   unavailable, which is the honest label and not an error.
 *
 * @module evidenceCalculationReceipts
 */

import { EVIDENCE_METHOD_ENGINES } from "@evimed/domain";

/** The kinds of a result's inputs that are the data a calculation ran on (its code and method are named by the method record). */
const DATA_INPUT_KINDS = new Set(["source", "data", "artifact"]);

/**
 * A result version as the receipt of its calculation, or null when it is not one.
 * @param {any} version a projected result version @returns {import("@evimed/domain").EvidenceCalculationReceipt | null}
 */
export function receiptFromResultVersion(version) {
  const method = version?.method;
  if (!method || typeof method.id !== "string" || typeof method.version !== "string") return null;
  const engine = Object.hasOwn(EVIDENCE_METHOD_ENGINES, method.id) ? /** @type {Record<string, string>} */ (EVIDENCE_METHOD_ENGINES)[method.id] : null;
  const values = (Array.isArray(version.machineValues) ? version.machineValues : [])
    .filter((/** @type {any} */ entry) => typeof entry?.key === "string" && Number.isFinite(entry.value))
    .map((/** @type {any} */ entry) => ({ key: entry.key, value: entry.value, unit: typeof entry.unit === "string" ? entry.unit : null }));
  if (!engine || !values.length || typeof version.versionId !== "string") return null;
  const inputs = (Array.isArray(version.inputs) ? version.inputs : [])
    .filter((/** @type {any} */ input) => DATA_INPUT_KINDS.has(input?.kind) && typeof input.id === "string" && input.id)
    .map((/** @type {any} */ input) => ({ [input.kind === "source" ? "identifier" : "datasetId"]: input.id, ...(typeof input.digest === "string" && /^[a-f0-9]{64}$/.test(input.digest) ? { hash: input.digest } : {}) }));
  return { receiptId: version.versionId, engine, method: `${method.id}@${method.version}`, inputs, values };
}

/**
 * The reader of receipts: `get(receiptId)` answers the receipt or null. Result versions (`rv_…`) are read from the scopes it
 * was built with; the evolution module's recalculation receipts (`evolution-recalculation-receipt-…`) from `evolution`.
 *
 * @param {{ results?: { get(userId: string, projectId: string, versionId: string): Promise<any> } | null,
 *   scopes?: { userId: string, projectId: string }[],
 *   evolution?: { get(id: string): Promise<any> } | null }} options
 */
export function createCalculationReceiptReader({ results = null, scopes = [], evolution = null }) {
  return {
    /** @param {string} receiptId @returns {Promise<import("@evimed/domain").EvidenceCalculationReceipt | null>} */
    async get(receiptId) {
      if (typeof receiptId !== "string") return null;
      if (/^rv_[a-f0-9]{64}$/.test(receiptId) && results) {
        for (const scope of scopes) {
          const version = await results.get(scope.userId, scope.projectId, receiptId).catch(() => null);
          if (version) return receiptFromResultVersion(version);
        }
        return null;
      }
      if (RECALCULATION_RECEIPT_ID.test(receiptId) && evolution) return recalculationReceiptOf(await evolution.get(receiptId).catch(() => null));
      return null;
    },
  };
}

/** The evolution module's recalculation receipts: its own record kind, written once by the recalculation publisher. */
export const RECALCULATION_RECEIPT_ID = /^evolution-recalculation-receipt-[a-f0-9]{32}$/;

/** @param {any} row an evolution document @returns {import("@evimed/domain").EvidenceCalculationReceipt | null} */
function recalculationReceiptOf(row) {
  const payload = row?.payload;
  if (payload?.recordType !== "evolution-recalculation-receipt" || typeof row.id !== "string") return null;
  return { receiptId: row.id, engine: payload.engine, method: payload.method, inputs: payload.inputs ?? [], values: payload.values ?? [] };
}
