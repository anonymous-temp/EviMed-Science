import { useEffect, useMemo, useState } from "react";
import type { FileRoot } from "@ai4s/shared";
import { readArtifact, readClaimVerification } from "@/lib/artifactFile";
import {
  claimMatrixPathFor,
  isClaimMatrixPath,
  parseClaimMatrixDocument,
  type ClaimMatrixDocument,
  type ClaimVerification,
} from "@/lib/claimCitations";
import type { VerifiedClaim } from "@/components/markdown-viewer/ClaimCitation";

/**
 * A clinical evidence report's matrix, read beside it, and what the control
 * plane found when it looked each quotation up in its preserved source
 * (`claim_verification`, the domain's `claimVerification`).
 *
 * Best effort on both counts: without the matrix the report still reads, and
 * a report nobody checked shows no marks rather than wrong ones.
 */
export function useClaimMatrix(path: string, root: FileRoot | undefined, enabled = true): {
  matrixPath: string | null;
  document: ClaimMatrixDocument | null;
  verification: ClaimVerification | null;
  verified: Map<string, VerifiedClaim>;
} {
  const matrixPath = enabled ? (isClaimMatrixPath(path) ? path : claimMatrixPathFor(path)) : null;
  const [document, setDocument] = useState<ClaimMatrixDocument | null>(null);
  const [verification, setVerification] = useState<ClaimVerification | null>(null);

  useEffect(() => {
    setDocument(null);
    setVerification(null);
    if (!matrixPath) return;
    let cancelled = false;
    readArtifact(matrixPath, root)
      .then((file) => {
        if (cancelled || !file || file.encoding !== "utf8") return;
        const parsed = parseClaimMatrixDocument(file.data);
        if (parsed.claims.size === 0) return;
        setDocument(parsed);
        readClaimVerification(matrixPath, root)
          .then((found) => { if (!cancelled) setVerification(found); })
          .catch(() => { /* unchecked: the citations still open */ });
      })
      .catch(() => { /* no matrix, no citations; the report itself is unaffected */ });
    return () => { cancelled = true; };
  }, [matrixPath, root]);

  const verified = useMemo(
    () => new Map((verification?.claims ?? []).map((claim) => [claim.claimId, claim] as const)),
    [verification],
  );
  return { matrixPath, document, verification, verified };
}
