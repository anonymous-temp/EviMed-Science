import { useId, useRef, type ReactNode } from "react";
import { EVIDENCE_AI_STEP_LABELS_ZH, EVIDENCE_PRODUCER_KIND_LABELS_ZH, EVIDENCE_PRODUCER_RELATION_LABELS_ZH } from "@evimed/domain";
import { Disclosure } from "@/components/ui/Disclosure";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Outline, useOutline } from "@/components/ui/Outline";
import { Section } from "@/components/ui/Section";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import type { EvidenceChallengeView } from "@/lib/evidenceUpkeepClient";
import { useWide } from "@/lib/useMediaQuery";
import { EvidenceContent, EvidenceReferences } from "./EvidenceContent";
import { EvidenceCardHeader, evidenceCurrencyLabel, evidenceNatureLabel } from "./EvidenceCardHeader";
import { EvidenceCardViews } from "./EvidenceCardViews";
import { EvidenceClaims } from "./EvidenceCardClaims";
import { EvidenceSources } from "./EvidenceSources";
import { EvidenceInspector } from "./EvidenceInspector";
import { publicationLabel } from "./EvidenceClaimDetail";
import { evidenceClaimsAnchor, useEvidenceInspect } from "./evidenceInspect";
import { evidenceDate, evidenceDay } from "./evidenceDate";

export { evidenceDate, evidenceDay };
/** Only omit an exact repeated answer; additional authored prose remains visible. */
const redundantBody = (evidence: EvidenceCard) =>
  !!evidence.content &&
  evidence.body.trim() === evidence.content.answer?.trim();
/** The day the card last changed: its newest revision, else the day it was made. */
export const evidenceUpdatedAt = (evidence: Pick<EvidenceCard, "revisions" | "createdAt">) =>
  evidence.revisions?.[0]?.recordedAt ?? evidence.createdAt ?? null;

/**
 * Who made the card and how it was checked, as the rows of the one fold under the answer — 「编写与核查」. A reader weighs a card by
 * what it says and by the line at its top; the rest is here for the one who wants it: the producer and what the card is (性质, 时效),
 * who wrote it, who read it, when its sources were last looked at, and the steps an AI took. What is wrong is above, in warning colour: a
 * retraction, a correction, a source that changed. Whether an AI has reviewed the card, and what the upkeep rounds kept from the last
 * reading, are the pipeline's bookkeeping and are not said (owner ruling 2026-10-10); a model's name is back office too.
 */
export function evidenceAuthoringRows(evidence: EvidenceCard): Fact[] {
  const rows: Fact[] = [];
  const editorial = evidence.editorial;
  const producer = evidence.producer;
  if (producer) {
    const kind = (EVIDENCE_PRODUCER_KIND_LABELS_ZH as Record<string, string>)[producer.kind] ?? producer.kind;
    const relation = (EVIDENCE_PRODUCER_RELATION_LABELS_ZH as Record<string, string>)[producer.relation];
    rows.push({ label: "出品方", value: [producer.name, kind, relation].filter(Boolean).join(" · ") });
  }
  const nature = evidenceNatureLabel(evidence);
  if (nature) rows.push({ label: "性质", value: nature });
  const currency = evidenceCurrencyLabel(evidence);
  if (currency) rows.push({ label: "时效", value: currency });
  if (editorial?.author) rows.push({ label: "编写", value: `${editorial.author.kind === "ai" ? "AI · " : ""}${editorial.author.name}` });
  else if (evidence.creator) rows.push({ label: "创作者", value: evidence.creator });
  if (editorial?.lastEditor) rows.push({ label: "用户修订", value: `${editorial.lastEditor.name} · ${evidenceDay(editorial.lastEditor.editedAt)}` });
  if (evidence.reviewer) rows.push({ label: "评议者", value: evidence.reviewer });
  if (evidence.reviewedAt) rows.push({ label: "评议于", value: evidenceDay(evidence.reviewedAt) });
  if (editorial?.sourceCheckedAt) rows.push({ label: "来源核查", value: evidenceDay(editorial.sourceCheckedAt) });
  // A source change that left the card waiting for its review is above, as a warning; the same fact, settled, is a row here.
  if (editorial?.sourceChangedAt && editorial.status !== "review-pending") rows.push({ label: "来源更新", value: evidenceDay(editorial.sourceChangedAt) });
  const disclosure = evidence.disclosure;
  if (disclosure) {
    const people = (list: Array<{ name: string; affiliation?: string; title?: string }>) => list.map((person) => [person.name, person.title, person.affiliation].filter(Boolean).join("，")).join("；");
    const steps = disclosure.aiSteps.map((step) => (EVIDENCE_AI_STEP_LABELS_ZH as Record<string, string>)[step] ?? step).join("、");
    if (steps) rows.push({ label: "AI 做了", value: steps });
    if (disclosure.generatedAt) rows.push({ label: "生成于", value: evidenceDay(disclosure.generatedAt) });
    if (disclosure.lastCheckedAt) rows.push({ label: "最后核对", value: evidenceDay(disclosure.lastCheckedAt) });
    if (disclosure.authors.length) rows.push({ label: "作者", value: people(disclosure.authors) });
    if (disclosure.reviewers.length) rows.push({ label: "审核", value: people(disclosure.reviewers) });
  }
  return rows;
}

function EvidenceAuthoring({ evidence }: { evidence: EvidenceCard }) {
  const rows = evidenceAuthoringRows(evidence);
  if (rows.length === 0) return null;
  return (
    <Disclosure summary="编写与核查" className="min-w-0 flex-1 open:basis-full">
      <FactList rows={rows} />
    </Disclosure>
  );
}

/** Past this many characters a card's body is folded under its heading. */
const LONG_BODY_CHARS = 1200;

/** The sections a card must have before it is given contents: a short card is read from its top. */
const OUTLINE_FROM = 4;

function EvidenceArticle({
  evidence,
  afterAnswer,
}: {
  evidence: EvidenceCard;
  afterAnswer?: ReactNode;
}) {
  const publicationSources = evidence.sources.flatMap((source,index)=>source.publicationStatus ? [{source,index:index+1}] : []);
  const wide = useWide();
  const article = useRef<HTMLElement>(null);
  const idPrefix = `evidence${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  // The contents are read off the article as rendered, so they are always what is on the page: the headings of the answer, the
  // overview, the card's own sections, the body, the conclusions, the limits, the sources.
  const { entries, active, select } = useOutline(article, { idPrefix, refresh: [evidence] });
  const outlined = entries.length >= OUTLINE_FROM;
  // ✓ n/m in the header goes to the list it counts.
  const toClaims = () => {
    const target = document.getElementById(evidenceClaimsAnchor(evidence.id));
    if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
  };
  return (
    <>
      {outlined && !wide && <Outline layout="folded" entries={entries} active={active} onSelect={select} className="mb-6" />}
      <div className="flex items-start gap-8">
        <article ref={article} className="min-w-0 max-w-read flex-1 space-y-8 break-words">
          <header className="space-y-2">
            <EvidenceCardHeader evidence={evidence} updatedAt={evidenceUpdatedAt(evidence)} onOpenClaims={evidence.claims.length > 0 ? toClaims : undefined} />
            {publicationSources.length > 0 && (
              <div role="alert" className="space-y-2 text-ui text-warn">
                <p>来源状态有警示，原有结论需要重新核查。以下内容保留供追溯，不能作为已完成核对的临床或科研依据。</p>
                {publicationSources.map(({source,index})=><p key={index}>{publicationLabel(source.publicationStatus!.kind)}<EvidenceReferences evidence={evidence} indexes={[index]} /></p>)}
              </div>
            )}
            {evidence.editorial?.sourceChangedAt && evidence.editorial.status === "review-pending" && (
              <p className="text-caption text-warn">
                依据来源更新于 {evidenceDay(evidence.editorial.sourceChangedAt)} · 等待复核
              </p>
            )}
          </header>
          {(evidence.content?.answer || evidence.summary) && (
            <section className="rounded-card bg-accent-soft p-4">
              <h2 className="mb-2 text-ui font-medium text-text">核心回答</h2>
              <p className="whitespace-pre-wrap text-ui leading-relaxed text-text-2">
                {evidence.content?.answer || evidence.summary}
              </p>
            </section>
          )}
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2 empty:hidden">
            {afterAnswer}
            <EvidenceAuthoring evidence={evidence} />
          </div>
          <EvidenceCardViews evidence={evidence} />
          <EvidenceContent evidence={evidence} />
          {evidence.body && !redundantBody(evidence) && (
            // Written in Markdown, and read as Markdown: it was printed as text, `##` and all. A long one is folded under its
            // heading — a programme card's body listed its 58 conclusions again above the 证据要点 that list them, and the page
            // ran to 50 000 px (release-11 walk).
            evidence.body.length > LONG_BODY_CHARS ? (
              <Disclosure summary={<h2 className="text-section font-semibold text-text">{evidence.content ? "补充说明" : "证据正文"}</h2>}>
                <MarkdownViewer variant="document" className="text-ui text-text-2">{evidence.body}</MarkdownViewer>
              </Disclosure>
            ) : (
              <Section title={evidence.content ? "补充说明" : "证据正文"}>
                <MarkdownViewer variant="document" className="text-ui text-text-2">{evidence.body}</MarkdownViewer>
              </Section>
            )
          )}
          <EvidenceClaims evidence={evidence} />
          {evidence.limitations && (
            <Section title="适用范围与局限">
              <p className="whitespace-pre-wrap text-ui leading-relaxed text-text-2">
                {evidence.limitations}
              </p>
            </Section>
          )}
          {evidence.content?.nextStep && (
            <Section title="下一步怎么用">
              <p className="whitespace-pre-wrap text-ui leading-relaxed text-text-2">
                {evidence.content.nextStep}
              </p>
            </Section>
          )}
          <EvidenceSources evidence={evidence} />
        </article>
        {outlined && wide && <Outline layout="column" entries={entries} active={active} onSelect={select} />}
      </div>
    </>
  );
}

/**
 * A card, read (R19 T5, audit D C2): its top line, the answer, the card's own sections, then two lists that open — the conclusions
 * with their ✓ / ⚠ and the sources with what stands on each — whose quotations and excerpts are read in a drawer, not stacked on the
 * page. A card of four sections or more has its contents beside it (folded above it on a narrow page). The drawer is the page's
 * (`EvidenceInspector`); this provides one where the caller has not.
 */
export function EvidenceReading({
  evidence,
  challenges,
  afterAnswer,
}: {
  evidence: EvidenceCard;
  /** The reader's own challenges on this card; given (even empty), each claim offers 「质疑」. Absent where the deployment keeps no upkeep. */
  challenges?: EvidenceChallengeView[];
  /** The action that goes with the answer — 「用这张卡继续研究」 — set beside 「编写与核查」 directly under it. */
  afterAnswer?: ReactNode;
}) {
  const provided = useEvidenceInspect();
  const article = <EvidenceArticle evidence={evidence} afterAnswer={afterAnswer} />;
  return provided ? article : <EvidenceInspector evidence={evidence} challenges={challenges}>{article}</EvidenceInspector>;
}
