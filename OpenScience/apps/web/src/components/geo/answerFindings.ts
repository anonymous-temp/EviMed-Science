/**
 * What the answer page says is wrong with an answer — decided from the answer's own words, before anything is drawn.
 *
 * An error is one row per fingerprint: its `statement` is the first sentence the claim was seen as, and every later answer that
 * repeats the claim in other words only moves the row's last snapshot. So the rows the answer endpoint returns for a question are
 * not all *in* this answer. The sentences that are come from this answer's own facts (the judge quotes them verbatim and the
 * server re-checks that), and a row is attached to one by the claim it contradicts; the page marks the answer with those and
 * with nothing else. A row whose sentence is not in the answer is a record of an earlier answer, kept apart from the text.
 *
 * Two sources for one claim are one finding: the correction is the claim's, not the source's.
 */
import type { GeoAnswer, GeoErrorRow, GeoStatementFact } from "@/lib/geoClient";
import { markAnswer } from "./answerMarks";

export interface AnswerFinding {
  /** The sentence as this answer says it. */
  sentence: string;
  /** The judge's finding on it; null for a sentence known only from an error row. */
  statement: GeoStatementFact | null;
  /** The error row that carries its source and its handling. */
  error: GeoErrorRow | null;
}

export interface AnswerFindings {
  /** Sentences in this answer, to be marked and corrected in place. */
  findings: AnswerFinding[];
  /** Error rows whose sentence is not in this answer (an earlier one, or one the text does not hold). */
  elsewhere: GeoErrorRow[];
}

const RANK: Record<string, number> = { S4: 4, S3: 3, S2: 2, S1: 1, S0: 0 };
const rank = (error: GeoErrorRow) => RANK[error.severity] ?? -1;
const same = (left: string | null | undefined, right: string | null | undefined) => !!left && !!right && left.trim() === right.trim();

/** The key of a claim: its id, else the sentence it was first seen as. */
const claimKey = (error: GeoErrorRow) => error.claimId || `sentence:${error.statement.trim()}`;

export function answerFindings(data: Pick<GeoAnswer, "snapshot" | "facts" | "errors">): AnswerFindings {
  const text = data.snapshot.answerText ?? "";
  const rows = (Array.isArray(data.errors) ? data.errors : []).filter((row) => row && row.statement);
  const statements = (Array.isArray(data.facts?.statements) ? data.facts.statements : [])
    .filter((statement) => statement && statement.verdict === "wrong" && statement.text && statement.text.trim());

  // The row that speaks for a claim: the one first seen in this very answer, then the gravest.
  const best = (candidates: GeoErrorRow[]) => candidates.slice().sort((left, right) =>
    Number(right.firstSnapshotId === data.snapshot.id) - Number(left.firstSnapshotId === data.snapshot.id) || rank(right) - rank(left))[0] ?? null;

  const findings: AnswerFinding[] = [];
  const spoken = new Set<string>();
  for (const statement of statements) {
    if (findings.some((finding) => same(finding.sentence, statement.text))) continue;
    const candidates = rows.filter((row) => (statement.claimId && row.claimId === statement.claimId) || same(row.statement, statement.text));
    const error = best(candidates);
    for (const row of candidates) spoken.add(claimKey(row));
    findings.push({ sentence: statement.text.trim(), statement, error });
  }

  // A row no statement spoke for: its sentence may still stand in this answer's text word for word.
  const elsewhere: GeoErrorRow[] = [];
  const grouped = new Map<string, GeoErrorRow[]>();
  for (const row of rows) {
    if (spoken.has(claimKey(row))) continue;
    grouped.set(claimKey(row), [...(grouped.get(claimKey(row)) ?? []), row]);
  }
  for (const group of grouped.values()) {
    const row = best(group);
    if (!row) continue;
    const inText = text !== "" && markAnswer(text, { wrong: [row.statement] }).unplaced.length === 0;
    if (inText) findings.push({ sentence: row.statement.trim(), statement: null, error: row });
    else elsewhere.push(row);
  }
  return { findings, elsewhere };
}
