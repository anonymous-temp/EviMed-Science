import { createHash } from "node:crypto";
import {
  EvidenceCardError,
  createEvidenceCardHashing,
  evidencePublicExcerpt,
  evidencePublicationStatus as domainPublicationStatus,
  evidenceStructuredContent as domainStructuredContent,
} from "@evimed/domain";
import { HttpError } from "./security.mjs";

// The card contract moved into `@evimed/domain` on 2026-10-05 (flywheel B1): the
// zone service, the result publisher, the platform's programme and the public
// page share it, and none may restate it. This file only adapts the domain's
// `EvidenceCardError` to this boundary's `HttpError` and supplies the sha-256 the
// domain, being browser-safe, cannot reach for. It holds no rule — a rule added
// here instead of in the domain would be invisible to every other writer.

/** Answers a domain refusal as this boundary's `HttpError`; anything else is not ours to translate.
 * @template {(...args: any[]) => any} F @param {F} fn @returns {F} */
export function evidenceContract(fn) {
  return /** @type {F} */ ((/** @type {any[]} */ ...args) => {
    try {
      return fn(...args);
    } catch (error) {
      throw asHttpError(error);
    }
  });
}
/** @param {unknown} error */
export function asHttpError(error) {
  return error instanceof EvidenceCardError ? new HttpError(error.status, error.code, error.message) : error;
}

const hashing = createEvidenceCardHashing((text) => createHash("sha256").update(text).digest("hex"));
export const evidenceHash = hashing.evidenceHash;
export const evidenceContentHash = hashing.evidenceContentHash;
export const evidenceSourceFingerprint = hashing.evidenceSourceFingerprint;
export const evidenceEditorialReceipt = evidenceContract(hashing.evidenceEditorialReceipt);
export const evidencePublicationStatus = evidenceContract(domainPublicationStatus);
export const evidenceStructuredContent = evidenceContract(domainStructuredContent);
export { evidencePublicExcerpt };
