/**
 * The claims and sources behind a run's report, read for the frame's
 * `evidence` message (`FrameEvidence` in `runtimeUiBridge.ts`).
 *
 * A module of its own so it is a chunk of its own: the bridge loads it when a
 * run has delivered a report, and with it the claim matrix parser and the
 * domain's answer-level evidence grading — none of which the first paint of a
 * conversation needs.
 */
import { gradeAnswerEvidence } from "@evimed/domain/answer-evidence-grade";
import { readArtifact, readClaimVerification } from "./artifactFile";
import { claimMatrixPathFor, claimSources, parseClaimMatrix, type ClaimVerification } from "./claimCitations";
import type { FrameEvidence } from "./runtimeUiBridge";

const MAX_CLAIMS = 400;
const MAX_CLAIM_TEXT = 300;
const MAX_SOURCES = 200;
const MAX_QUOTE_TEXT = 600;

/** A string field of a raw matrix record, bounded, or undefined. */
function matrixText(value: unknown, max: number): string | undefined {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, max) : undefined;
}

/** The claims and cited sources of a matrix, bounded for the channel. */
export function frameEvidenceFrom(runId: string, reportPath: string, matrixPath: string, matrixJson: string,
  verification: ClaimVerification | null): FrameEvidence {
  const statuses = new Map((verification?.claims ?? []).map((claim) => [claim.claimId, String(claim.status)]));
  const verified = new Map((verification?.claims ?? []).map((claim) => [claim.claimId, claim]));
  const matrix = parseClaimMatrix(matrixJson);
  // `sourceType` rides in the matrix when the run wrote it (C8) and so may the
  // journal, the year and the funder; the parser keeps none of them, so they
  // are read beside it. Read by name, never by scanning the record: a card
  // says what the package recorded.
  const extras = new Map<string, { sourceType?: string; journal?: string; year?: string; funding?: string }>();
  try {
    const parsed = JSON.parse(matrixJson) as { claims?: Array<Record<string, unknown>> };
    for (const claim of parsed.claims ?? []) {
      if (typeof claim?.claimId !== "string") continue;
      extras.set(claim.claimId, {
        ...(typeof claim.sourceType === "string" ? { sourceType: claim.sourceType } : {}),
        ...(matrixText(claim.journal ?? claim.publication, 60) ? { journal: matrixText(claim.journal ?? claim.publication, 60) } : {}),
        ...(matrixText(claim.year ?? claim.publicationYear ?? claim.version, 24) ? { year: matrixText(claim.year ?? claim.publicationYear ?? claim.version, 24) } : {}),
        ...(claim.funding === "industry" ? { funding: "industry" } : {}),
      });
    }
  } catch { /* an unreadable matrix has no claims either */ }
  const claims: FrameEvidence["claims"] = [];
  const sources = new Map<string, FrameEvidence["sources"][number]>();
  // What the grade is computed over: one record per distinct source, with the
  // design the platform decided for it. The other three inputs — study count,
  // participants, the interval — are the matrix's to carry; it carries none
  // today, so a body of evidence grades on its designs and its size alone and
  // says so in its reasons.
  const graded: Array<{ design?: string }> = [];
  for (const claim of matrix.values()) {
    if (claims.length >= MAX_CLAIMS) break;
    const extra = extras.get(claim.claimId) ?? {};
    const text = claim.claim.length > MAX_CLAIM_TEXT ? `${claim.claim.slice(0, MAX_CLAIM_TEXT - 1)}…` : claim.claim;
    claims.push({
      claimId: claim.claimId,
      claim: text,
      claimType: claim.claimType,
      status: statuses.get(claim.claimId) ?? "unchecked",
      ...(claim.sourceTitle ? { sourceTitle: claim.sourceTitle } : {}),
      ...(claim.identifier ? { identifier: claim.identifier } : {}),
      ...(claim.sourceUrl ? { url: claim.sourceUrl } : {}),
      ...(extra.sourceType ? { sourceType: extra.sourceType } : {}),
    });
    const record = verified.get(claim.claimId);
    // `claimSources` is the one reading of which sources a claim rests on —
    // the same one the report reader's 「依据」 popover uses, and the order
    // `claim_verification` reports its verdicts in.
    const cited = claimSources(claim);
    cited.forEach((source, index) => {
      const key = source.identifier || source.sourceUrl || source.sourceTitle;
      if (!key) return;
      const known = sources.get(key);
      if (known) { known.claims += 1; return; }
      if (sources.size >= MAX_SOURCES) return;
      const checked = record?.sources?.[index];
      const type = checked?.sourceType ?? (index === 0 ? extra.sourceType : undefined) ?? source.sourceType;
      graded.push({ ...(type ? { design: type } : {}) });
      sources.set(key, {
        title: source.sourceTitle || source.identifier || key,
        ...(source.identifier || checked?.doi ? { identifier: source.identifier ?? `DOI ${checked?.doi}` } : {}),
        ...(source.sourceUrl ? { url: source.sourceUrl } : {}),
        ...(type ? { sourceType: type } : {}),
        ...(index === 0 && extra.journal ? { journal: extra.journal } : {}),
        ...(index === 0 && extra.year ? { year: extra.year } : {}),
        ...(index === 0 && extra.funding ? { funding: extra.funding } : {}),
        ...(source.supportQuote ? { quote: source.supportQuote.slice(0, MAX_QUOTE_TEXT) } : {}),
        ...(checked?.status ? { status: checked.status } : {}),
        ...(checked?.updates?.length ? { updates: checked.updates.slice(0, 4) } : {}),
        claimId: claim.claimId,
        claims: 1,
      });
    });
  }
  const { grade, reasons } = gradeAnswerEvidence({ sources: graded });
  return {
    runId,
    reportPath,
    matrixPath,
    claims,
    sources: [...sources.values()],
    grade: { letter: grade, reasons: reasons.map((reason) => reason.text).slice(0, 4) },
  };
}

/** Reads the evidence behind a report, or null when there is no matrix beside it. */
export async function readFrameEvidence(runId: string, reportPath: string): Promise<FrameEvidence | null> {
  const matrixPath = claimMatrixPathFor(reportPath);
  if (!matrixPath) return null;
  const file = await readArtifact(matrixPath, "workspace");
  if (!file || file.encoding !== "utf8") return null;
  const verification = await readClaimVerification(matrixPath, "workspace").catch(() => null);
  return frameEvidenceFrom(runId, reportPath, matrixPath, file.data, verification);
}
