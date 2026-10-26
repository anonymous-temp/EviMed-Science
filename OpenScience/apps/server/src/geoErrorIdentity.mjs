import { createHash } from "node:crypto";
import { geoClaimAssessmentIdentity } from "@evimed/domain";
import { compactText } from "./geoParse.mjs";

/**
 * The error's identity retains the actual claim version and applicability.
 * Historical rows without these fields keep their legacy identity.
 * @param {{ claimKey?: string | null, text?: string | null, claimId?: string | null, claimVersion?: number | null, applicability?: any }} statement
 */
export function errorFingerprint(statement) {
  const basis = statement.claimKey ? `claim:${statement.claimKey}` : `text:${compactText(statement.text)}`;
  const conditions = statement.applicability === undefined && statement.claimVersion === undefined ? "" : geoClaimAssessmentIdentity(statement);
  return createHash("sha256").update(basis + conditions).digest("hex").slice(0, 32);
}

