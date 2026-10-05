import type { ResultVersion } from "@/lib/resultProvenance";

/** One claim of a clinical result as the publish dialog lists it. */
export interface ResultCardClaim {
  claimId: string;
  text: string;
  claimType: "direct" | "synthesized" | "derived";
  /** What the run's gate found: `verified`, `quote_not_found`, `source_unavailable`, `no_quote`, `derived`. */
  status: string;
}

/**
 * The claims of a result's evidence matrix with the verdict the run's gate stored beside each — the list the dialog
 * shows. Empty when the version carries no readable matrix (a source the project can no longer read holds it back), which
 * the dialog says; the server then publishes the verified claims itself.
 */
export function resultCardClaims(version: Pick<ResultVersion, "review">): ResultCardClaim[] {
  const review = version.review;
  if (!review?.matrixText) return [];
  let matrix: unknown;
  try { matrix = JSON.parse(review.matrixText); } catch { return []; }
  const claims = (matrix as { claims?: unknown })?.claims;
  if (!Array.isArray(claims)) return [];
  const statusOf = new Map((review.verification?.claims ?? []).map((claim) => [claim.claimId, claim.status]));
  return claims.flatMap((raw): ResultCardClaim[] => {
    const claim = raw as { claimId?: unknown; claim?: unknown; claimType?: unknown };
    if (typeof claim?.claimId !== "string" || typeof claim.claim !== "string" || !claim.claim.trim()) return [];
    const claimType = claim.claimType === "synthesized" || claim.claimType === "derived" ? claim.claimType : "direct";
    return [{ claimId: claim.claimId, text: claim.claim.trim(), claimType, status: String(statusOf.get(claim.claimId) ?? (claimType === "derived" ? "derived" : "unknown")) }];
  });
}
