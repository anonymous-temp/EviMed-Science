import { useEffect, useMemo, useState } from "react";
import type { ResultVersion } from "@/lib/resultProvenance";
import type { FileRoot } from "@ai4s/shared";
import { readArtifact, readClaimVerification } from "@/lib/artifactFile";
import {
  claimMatrixPathFor,
  isClaimMatrixPath,
  parseClaimMatrixDocument,
  type ClaimCheckState,
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
 *
 * `verificationState` says which of three things an empty `verified` means:
 * the checks are still being read (`loading`), they were read (`ready` — a
 * claim missing from them was not checked), or they cannot be read
 * (`unavailable`: the read failed, or this report was never checked).
 */
export function useClaimMatrix(path: string, root: FileRoot | undefined, enabled = true, immutableVersion?: ResultVersion): {
  matrixPath: string | null;
  document: ClaimMatrixDocument | null;
  verification: ClaimVerification | null;
  verified: Map<string, VerifiedClaim>;
  verificationState: ClaimCheckState;
} {
  const matrixPath = enabled ? (isClaimMatrixPath(path) ? path : claimMatrixPathFor(path)) : null;
  const [document, setDocument] = useState<ClaimMatrixDocument | null>(null);
  const [verification, setVerification] = useState<ClaimVerification | null>(null);
  const [readState, setReadState] = useState<ClaimCheckState>("loading");

  useEffect(() => {
    setDocument(null);
    setVerification(null);
    setReadState("loading");
    if (!matrixPath) {
      setReadState("unavailable");
      return;
    }
    let cancelled = false;
    readArtifact(matrixPath, root)
      .then((file) => {
        if (cancelled) return;
        const parsed = file && file.encoding === "utf8" ? parseClaimMatrixDocument(file.data) : null;
        if (!parsed || parsed.claims.size === 0) {
          setReadState("unavailable");
          return;
        }
        setDocument(parsed);
        readClaimVerification(matrixPath, root)
          .then((found) => {
            if (cancelled) return;
            setVerification(found);
            setReadState(found ? "ready" : "unavailable");
          })
          // Unchecked: the citations still open, and the matrix says the checks could not be read.
          .catch(() => { if (!cancelled) setReadState("unavailable"); });
      })
      // No matrix, no citations; the report itself is unaffected.
      .catch(() => { if (!cancelled) setReadState("unavailable"); });
    return () => { cancelled = true; };
  }, [matrixPath, root]);

  const frozenDocument = useMemo(() => {
    if (!immutableVersion?.review?.matrixText || immutableVersion.review.status !== "available") return null;
    const parsed = parseClaimMatrixDocument(immutableVersion.review.matrixText);
    const bindSource = (source: import("@/lib/claimCitations").ClaimSource) => {
      const input = immutableVersion.inputs.find((value) => value.path === source.artifactPath && value.versionId && value.digest);
      // A historical source must never fall through to current workspace bytes.
      return { ...source, artifactPath: input ? source.artifactPath : undefined,
        resultVersionId: input?.versionId, resultDigest: input?.digest };
    };
    return { ...parsed, claims: new Map([...parsed.claims].map(([id, claim]) => [id,
      { ...claim, ...bindSource(claim), supportingSources: claim.supportingSources?.map(bindSource) }])) };
  }, [immutableVersion]);
  const selectedVerification = immutableVersion ? (immutableVersion.review?.status === "available" ? immutableVersion.review.verification ?? null : null) : verification;
  const verified = useMemo(
    () => new Map((selectedVerification?.claims ?? []).map((claim) => [claim.claimId, claim] as const)),
    [selectedVerification],
  );
  const verificationState: ClaimCheckState = immutableVersion
    ? (selectedVerification ? "ready" : "unavailable")
    : readState;
  return { matrixPath, document: immutableVersion ? frozenDocument : document, verification: selectedVerification, verified, verificationState };
}
