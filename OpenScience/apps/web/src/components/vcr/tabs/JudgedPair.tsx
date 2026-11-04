import { useState } from "react";
import { CircleCheck, CircleDashed, CircleHelp, CircleMinus, CircleX, ExternalLink } from "lucide-react";
import { VCR_MATCH_REASON_GROUP_LABELS_ZH, VCR_MATCH_STANCE_LABELS_ZH } from "@evimed/domain";
import type { VcrJudgedClause, VcrJudgedOpen, VcrJudgedPair, VcrStance, VcrVerdict } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Tag, type TagTone } from "@/components/ui/Tag";
import { VcrRecordDrawer, type VcrRecordSpot } from "../VcrRecordDrawer";

/** The chip of a verdict: the ones still to settle are the ones a coordinator acts on. */
const VERDICT_TONE: Record<VcrVerdict, TagTone> = { eligible: "accent", possible: "warn", insufficient: "warn", ineligible: "neutral" };

export function VerdictTag({ pair }: { pair: Pick<VcrJudgedPair, "verdict" | "verdictLabel"> }) {
  return <span data-vcr-verdict={pair.verdict}><Tag tone={VERDICT_TONE[pair.verdict]}>{pair.verdictLabel}</Tag></span>;
}

/** 匹配度 as a plain level, with the model's confidence a step behind it. Never a percentage of anything. */
export function fitText(pair: Pick<VcrJudgedPair, "fitLabel" | "confidenceLabel">): string {
  return [pair.fitLabel ? `匹配度${pair.fitLabel}` : null, pair.confidenceLabel ? `把握${pair.confidenceLabel}` : null].filter(Boolean).join(" · ");
}

/** The registry's number as a link to its page where there is one. */
export function RegistryLink({ pair }: { pair: Pick<VcrJudgedPair, "registryId" | "url"> }) {
  if (!pair.registryId) return null;
  if (!pair.url) return <span className="text-caption tabular-nums text-text-2">{pair.registryId}</span>;
  return (
    <a href={pair.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-caption tabular-nums text-accent hover:underline">
      {pair.registryId}
      <ExternalLink size={16} aria-hidden="true" />
    </a>
  );
}

/** The registry's word for where a trial stands, with the day it was read: a status without its date is a claim about today. */
export function statusLine(pair: Pick<VcrJudgedPair, "phase" | "status" | "statusAsOf">): string {
  const status = pair.status && pair.statusAsOf ? `${pair.status}（${pair.statusAsOf}）` : pair.status;
  // A phase that does not apply (an observational study) says nothing a reader acts on.
  return [pair.phase === "不适用" ? "" : pair.phase, status].filter(Boolean).join(" · ");
}

const STANCE_ICON: Record<VcrStance, typeof CircleCheck> = { support: CircleCheck, against: CircleX, silent: CircleDashed, open: CircleHelp, not_applicable: CircleMinus };
const STANCE_TONE: Record<VcrStance, string> = { support: "text-ok", against: "text-danger-strong", silent: "text-text-2", open: "text-warn-strong", not_applicable: "text-text-3" };

/** One clause's state: a mark and the platform's words for it (「未见记载，按未排除」). The mark is never the only thing that says it. */
export function ClauseState({ clause }: { clause: Pick<VcrJudgedClause, "stance" | "display"> }) {
  const Icon = STANCE_ICON[clause.stance];
  return (
    <span className={cn("inline-flex items-start gap-1.5", STANCE_TONE[clause.stance])}>
      <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{clause.display}</span>
    </span>
  );
}

/** The sentences a clause rests on, each with the way into the record at that sentence. A clause with none shows no quotation. */
function Evidence({ clause, mayRead, onOpen }: { clause: VcrJudgedClause; mayRead: boolean; onOpen: (spot: VcrRecordSpot) => void }) {
  if (!clause.evidence.length && !clause.evidenceHidden) return null;
  return (
    <div className="flex flex-col gap-2">
      {clause.evidence.map((sentence) => (
        <div key={sentence.sentenceId} data-vcr-sentence={sentence.sentenceId}>
          <p className="text-ui text-text">{`“${sentence.text}”`}</p>
          {sentence.documentId && sentence.start !== null && sentence.end !== null && mayRead && (
            <Button variant="text" size="sm" aria-label={`在病历中查看：${sentence.text.slice(0, 20)}`} onClick={() => onOpen({ documentId: sentence.documentId!, start: sentence.start!, end: sentence.end! })}>
              在病历中查看
            </Button>
          )}
          {sentence.field && <p className="text-caption text-text-3">{`数据表字段“${sentence.field}”`}</p>}
        </div>
      ))}
      {clause.evidenceHidden ? <p className="text-caption text-text-3">{`另有 ${clause.evidenceHidden} 句依据暂时不能显示`}</p> : null}
    </div>
  );
}

/**
 * The clause table of one pair: the clause's own words, where it stands, the model's short reason and the patient's sentences it rests on.
 * One list that is a row of columns on a wide page and a card for each clause on a phone, so it never scrolls sideways.
 */
export function ClauseList({ label, clauses, mayRead, onOpen, compact = false }: { label: string; clauses: readonly VcrJudgedClause[]; mayRead: boolean; onOpen: (spot: VcrRecordSpot) => void; compact?: boolean }) {
  if (!clauses.length) return null;
  // Four columns need about 40rem; in a column beside a list, or a sheet, each clause stacks as it does on a phone.
  const columns = compact ? "" : "md:grid md:grid-cols-[3.5rem_minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1.6fr)] md:gap-x-4";
  return (
    <div>
      <div aria-hidden="true" className={cn("border-b border-border pb-2 text-caption text-text-3 max-md:hidden", compact && "hidden", columns)}>
        <span>条款</span><span>入排原文</span><span>判定与理由</span><span>病历中的依据</span>
      </div>
      <ol aria-label={label}>
        {clauses.map((clause) => (
          <li key={clause.number} data-vcr-clause={clause.number} data-vcr-clause-stance={clause.stance} className={cn("flex flex-col gap-2 border-b border-border py-3 last:border-b-0", columns)}>
            <div className={cn("flex items-baseline gap-2 text-caption text-text-3", !compact && "md:flex-col md:gap-0")}>
              <span className="tabular-nums">{clause.number}</span>
              <span>{clause.kind === "exclusion" ? "排除" : clause.kind === "unsectioned" ? "未分节" : "入选"}</span>
            </div>
            <p className="min-w-0 text-ui text-text">{clause.lead && <span className="text-text-3">{clause.lead} </span>}{clause.clause}</p>
            <div className="min-w-0 text-ui">
              <ClauseState clause={clause} />
              {clause.reason && <p className="mt-1 text-caption text-text-2">{clause.reason}</p>}
            </div>
            <div className="min-w-0 empty:hidden"><Evidence clause={clause} mayRead={mayRead} onOpen={onOpen} /></div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The three groups a pair opens with, in the model's words; a group with nothing in it is not drawn. */
export function ReasonGroups({ groups }: { groups: VcrJudgedOpen["groups"] }) {
  const present = (["support", "against", "open"] as const).filter((key) => groups[key]?.length);
  if (!present.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {present.map((key) => (
        <section key={key} data-vcr-reasons={key} aria-label={VCR_MATCH_REASON_GROUP_LABELS_ZH[key]}>
          <h4 className="text-ui font-semibold text-text">{VCR_MATCH_REASON_GROUP_LABELS_ZH[key]}</h4>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-ui text-text-2">
            {groups[key]!.map((reason, index) => <li key={index}>{reason}</li>)}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * One pair opened — a patient and a trial, or a patient and the study's protocol: what the model made of it in three groups, then every
 * clause with the sentences it rests on, and the way into the record at each. The record is opened in a drawer, which this owns.
 */
export function JudgedPairDetail({ studyId, pair, mayReadRecord, subject, showTitle = true, compact = false }: { studyId: string; pair: VcrJudgedOpen; mayReadRecord: boolean; subject: string; showTitle?: boolean; compact?: boolean }) {
  const [spot, setSpot] = useState<VcrRecordSpot | null>(null);
  const status = statusLine(pair);
  const counts = pair.counts;
  const stances = counts
    ? ([["support", counts.support], ["against", counts.against], ["silent", counts.silent], ["open", counts.open]] as const).filter(([, n]) => n > 0)
    : [];
  return (
    <div data-vcr-pair={pair.id} className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {showTitle && <h3 className="min-w-0 text-ui font-semibold text-text">{pair.title}</h3>}
          <RegistryLink pair={pair} />
          <VerdictTag pair={pair} />
        </div>
        {(status || fitText(pair)) && <p className="text-caption text-text-2">{[status, fitText(pair)].filter(Boolean).join(" · ")}</p>}
        {stances.length > 0 && (
          <p className="text-caption text-text-3">{stances.map(([stance, n]) => `${VCR_MATCH_STANCE_LABELS_ZH[stance]} ${n}`).join(" · ")}</p>
        )}
        {pair.eligibilityNote && <p data-vcr-eligibility-note="" className="text-caption text-warn-strong">{pair.eligibilityNote}</p>}
        {pair.clausesNote && <p data-vcr-clauses-note="" className="text-caption text-warn-strong">{pair.clausesNote}</p>}
        {pair.recordGap && <p data-vcr-record-gap="" className="text-caption text-warn-strong">{pair.recordGap}</p>}
      </header>
      {pair.reasonsWithheld && <p data-vcr-reasons-withheld="" className="text-caption text-text-2">{pair.reasonsWithheld}</p>}
      <ReasonGroups groups={pair.groups} />
      {!Object.keys(pair.groups).length && pair.summary && <p className="text-ui text-text-2">{pair.summary}</p>}
      {pair.evidenceNote && <p data-vcr-evidence-note="" className="text-caption text-text-3">{pair.evidenceNote}</p>}
      <ClauseList label={`${subject} 的逐条判定`} clauses={pair.clauses} mayRead={mayReadRecord} onOpen={setSpot} compact={compact} />
      {spot && <VcrRecordDrawer studyId={studyId} spot={spot} onClose={() => setSpot(null)} />}
    </div>
  );
}
