import { FactList, type Fact } from "@/components/ui/FactList";
import { claimConditionsText } from "./geoText";

/**
 * What the judge kept for one sampled answer, as labelled fields: the verdicts in words, the statements and their source text,
 * the brands and generic names it found with their counts. The stored judgment is a record of ids, versions and parser output;
 * none of that is shown, and a field this reader does not know is left out rather than printed as JSON.
 */

type Loose = Record<string, unknown>;
const record = (value: unknown): Loose | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Loose) : null);
const list = (value: unknown): Loose[] => (Array.isArray(value) ? value.map(record).filter((item): item is Loose => item !== null) : []);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const VERDICT_WORDS: Readonly<Record<string, string>> = Object.freeze({ correct: "正确", wrong: "错误", unverifiable: "无法核实" });
const COVERAGE_WORDS: Readonly<Record<string, string>> = Object.freeze({ complete: "完整", partial: "只判定了部分回答", unknown: "未知" });

/** A brand or generic name the judge found: whose it is, and how many times the answer said it. */
function mentionText(mention: Loose): string | null {
  const name = text(mention.name);
  if (!name) return null;
  const whose = mention.ours === true ? "本品" : mention.competitor === true ? "竞品" : "其他";
  const times = count(mention.count);
  return `${name}（${whose}）${times !== null ? ` ${times} 次` : ""}`;
}

/** The generic names an answer mentioned, in one line; none found is said, and a record that was never kept is said too. */
export function genericMentionsText(value: unknown): string {
  if (!Array.isArray(value)) return "未保留";
  const found = list(value).map(mentionText).filter((item): item is string => item !== null);
  return found.length ? found.join("；") : "回答中没有提到";
}

/** The rows of a stored judgment; empty when it holds nothing this reader can word. */
export function judgmentRows(judgment: unknown): Fact[] {
  const facts = record(judgment);
  if (!facts) return [];
  const rows: Fact[] = [];
  const judgedAt = text(facts.judgedAt);
  if (judgedAt) rows.push({ label: "判定时间", value: judgedAt });
  const coverage = text(record(record(facts.checks)?.judgementCoverage)?.status);
  if (coverage) rows.push({ label: "判定范围", value: COVERAGE_WORDS[coverage] ?? "未知" });
  if (Array.isArray(facts.brands)) {
    const brands = list(facts.brands).map(mentionText).filter((item): item is string => item !== null);
    rows.push({ label: "提到的品牌", value: brands.length ? brands.join("；") : "回答中没有提到品牌" });
  }
  if (typeof facts.retrievalTriggered === "boolean") rows.push({ label: "是否联网检索", value: facts.retrievalTriggered ? "是" : "否" });
  const hits = Array.isArray(facts.redFlagHits) ? facts.redFlagHits.length : null;
  const expected = Array.isArray(facts.redFlagExpected) ? facts.redFlagExpected.length : null;
  if (expected !== null && expected > 0) rows.push({ label: "就医提醒", value: `应提到 ${expected} 项，回答提到 ${hits ?? 0} 项` });
  return rows;
}

/** One statement of the answer with its verdict, the conditions it was judged under and the source text behind it. */
function statementRows(statement: Loose): Fact[] {
  const rows: Fact[] = [{ label: "回答陈述", value: text(statement.text) ?? "未保留" }];
  rows.push({ label: "判定", value: VERDICT_WORDS[text(statement.verdict) ?? ""] ?? "未知" });
  if (statement.applicability != null) rows.push({ label: "适用条件", value: claimConditionsText(statement.applicability) });
  const evidence = text(statement.evidence);
  if (evidence) rows.push({ label: "引文依据", value: evidence });
  return rows;
}

export function OriginalJudgment({ judgment }: { judgment: unknown }) {
  const facts = record(judgment);
  const rows = judgmentRows(judgment);
  const statements = list(facts?.statements);
  if (rows.length === 0 && statements.length === 0) return <p className="text-ui text-text-2">没有保留可读的判定内容。</p>;
  return (
    <div className="flex flex-col gap-3">
      {rows.length > 0 && <FactList rows={rows} />}
      {statements.map((statement, index) => <FactList key={index} rows={statementRows(statement)} />)}
    </div>
  );
}
