import { useState } from "react";
import { CircleCheck, CircleHelp, CircleMinus, CircleX, Clock, TriangleAlert } from "lucide-react";
import {
  contactVcrReferral,
  getVcrMatching,
  getVcrReferrals,
  recordVcrDecision,
  reviewVcrAssessment,
  transitionVcrReferral,
  type VcrCandidate,
  type VcrCriterionJudgement,
  type VcrCriterionState,
  type VcrMatchingTab as MatchingData,
  type VcrReferral,
  type VcrStudy,
} from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChartCard } from "@/components/ui/ChartCard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable } from "@/components/ui/DataTable";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Tag } from "@/components/ui/Tag";
import { VcrJudgmentDrawer } from "../VcrJudgmentDrawer";
import { VcrCountsBand } from "../VcrCounts";
import { VcrForecastChart } from "../VcrCharts";
import { VcrFunnelBar } from "../VcrDiagrams";
import { SourceTag } from "../VcrMarks";
import { VcrStat, VcrStatNote } from "../VcrNumber";
import { VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useVcrLoad, VcrHeadline, VcrSection, VcrTabError, VcrToolbar } from "../vcrTabKit";
import { criterionStateLabel, intervalLabel, numberText, referralStateLabel } from "../vcrText";

type View = "matching" | "referral" | "sites" | "followup";
type Direction = NonNullable<MatchingData["direction"]>;

const VIEWS: ReadonlyArray<{ value: View; label: string }> = Object.freeze([
  { value: "matching", label: "匹配" },
  { value: "referral", label: "转诊" },
  { value: "sites", label: "中心" },
  { value: "followup", label: "随访" },
]);

const DIRECTIONS: ReadonlyArray<{ value: Direction; label: string }> = Object.freeze([
  { value: "trial_to_patient", label: "给试验找患者" },
  { value: "patient_to_trial", label: "给患者找试验" },
]);

/**
 * What the model's ranking hint is called wherever it appears. It orders a
 * coordinator's work; it is not a chance of benefit, and no number of it is
 * printed that could be read as one.
 */
const PRIORITY_LABEL = "临床优先级（不是获益概率）";

const STATE_ICON: Record<VcrCriterionState, typeof CircleCheck> = {
  satisfied: CircleCheck,
  not_satisfied: CircleX,
  unknown: CircleHelp,
  pending_recheck: Clock,
};

/**
 * 匹配与招募: who might be eligible, what is still missing on each of them,
 * and what the sites have actually done.
 *
 * This is the one tab with a human stop in it (plan §10.1). 「确认后联系」 is
 * per person and is the coordinator's, because contacting a patient is an act
 * outside the platform that cannot be undone; the platform has the reason and
 * the missing evidence ready, and stops there.
 *
 * Hidden knowledge:
 *  - Eligibility is three-valued and stays three-valued: 未知 is never folded
 *    into 不符合, and a rule that does not apply to a person is 「不适用」, never
 *    未知 (plan §7.1).
 *  - **The confirmation names the referral, not the person's key.** The route
 *    takes the referral id the server attached to the selected candidate; a
 *    subject key sent there is a 404 (review UI-2).
 *  - **A candidate with no referral is not yet contactable.** Confirming a
 *    contact is a move on the referral ledger, so a person the ledger has not
 *    taken in says so instead of offering a button that would be refused.
 *  - Picking a candidate re-reads the tab for that person (`?candidate=`), and
 *    the page keeps the rest of the tab on screen while it does.
 *  - **改判 and 复核 are a person's hand, addressed by the page contract.** The
 *    panel names the assessment it is about (`selected.assessmentId`) and each
 *    rule names itself (`criterionId`); with either missing neither control is
 *    offered, because an address that is guessed lands a judgment on the wrong
 *    assessment. The platform's answer stays beside the person's.
 *  - **The ledger is read from its own route.** The counts above it are the
 *    presenter's; the rows — each person, their state, who confirmed the contact —
 *    are `GET …/referrals`, read only by an account the route would answer.
 *  - When the recruiting side is not composed on this deployment the payload
 *    says so (`available: false`), and that sentence is all the tab shows.
 */
export function MatchingTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const [view, setView] = useState<View>("matching");
  const [direction, setDirection] = useState<Direction>("trial_to_patient");
  const [candidate, setCandidate] = useState<string | null>(null);
  const { state, reload } = useVcrLoad(`${studyId}:matching:${view}:${direction}`, () => getVcrMatching(studyId, {
    view, direction, ...(view === "matching" && candidate ? { candidate } : {}),
  }));
  const pick = (id: string) => {
    setCandidate(id);
    // Same key, a new round: the tab stays on screen while the person loads.
    reload();
  };
  const switchView = (next: View) => { setView(next); setCandidate(null); };
  const switchDirection = (next: Direction) => { setDirection(next); setCandidate(null); };

  const toolbar = (summary?: string) => (
    <VcrToolbar summary={summary}>
      <SegmentedControl aria-label="匹配与招募的视图" value={view} onChange={switchView} options={[...VIEWS]} />
      {view === "matching" && (
        <SegmentedControl aria-label="匹配方向" value={direction} onChange={switchDirection} options={[...DIRECTIONS]} />
      )}
    </VcrToolbar>
  );
  if (state.kind === "loading") return <div className="flex flex-col gap-6">{toolbar()}<VcrTabSkeleton /></div>;
  if (state.kind === "error") return <div className="flex flex-col gap-6">{toolbar()}<VcrTabError message={state.message} onRetry={reload} /></div>;
  const data = state.data;
  if (data.available === false) {
    return (
      <p data-vcr-matching-unavailable="" className="py-12 text-center text-ui text-text-3">
        {data.unavailable?.message ?? "匹配与招募在本部署尚未接入。"}
      </p>
    );
  }
  // Every sub-view counts: a referral ledger with no candidate list is a
  // study whose matching has already run, and offering 「让 AI 做」 there
  // would ask for work that is done.
  const nothing = data.candidates.length === 0 && !data.forecast && !data.pendingReview
    && (data.ledger ?? []).length === 0 && (data.sites ?? []).length === 0 && (data.followup ?? []).length === 0;
  if (nothing) {
    return (
      <div className="flex flex-col gap-6">
        {toolbar()}
        <VcrStepPending studyId={studyId} study={study} step="matching" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {toolbar(partnerLine(data))}
      {data.headline && <VcrHeadline>{data.headline}</VcrHeadline>}
      {view === "matching" && (
        <MatchingView
          studyId={studyId}
          data={data}
          abilities={study.abilities}
          picked={candidate}
          onPick={pick}
          onDone={reload}
        />
      )}
      {view === "referral" && <ReferralView studyId={studyId} data={data} abilities={study.abilities} />}
      {view === "sites" && <SitesView data={data} />}
      {view === "followup" && <FollowupView data={data} />}
      <VcrCountsBand counts={data.counts} />
    </div>
  );
}

function partnerLine(data: MatchingData): string {
  return [
    data.partner?.name ? `合作方：${data.partner.name}` : null,
    data.partner?.candidates != null ? `${referralStateLabel("candidate")} ${numberText(data.partner.candidates, 0)} 名` : null,
    data.partner?.snapshotAt ? `数据快照 ${data.partner.snapshotAt}` : null,
  ].filter(Boolean).join(" · ");
}

/** The rules a request for evidence is about: what is unknown, and what waits on a named document. */
function evidenceNeeds(criteria: readonly VcrCriterionJudgement[]): VcrCriterionJudgement[] {
  return criteria.filter((row) => row.applicable !== false
    && (row.state === "unknown" || (row.state === "pending_recheck" && Boolean(row.request))));
}

function MatchingView({ studyId, data, abilities, picked, onPick, onDone }: {
  studyId: string;
  data: MatchingData;
  abilities: readonly string[];
  /** The candidate asked for; the detail may still be the previous one while it loads. */
  picked: string | null;
  onPick: (id: string) => void;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState<{ subject: string; referralId: string } | null>(null);
  const [judging, setJudging] = useState<VcrCriterionJudgement | null>(null);
  const [busy, setBusy] = useState<"contact" | "evidence" | "review" | null>(null);
  const selected = data.selected;
  const current = picked ?? selected?.candidate.id ?? null;
  const needs = selected ? evidenceNeeds(selected.criteria) : [];
  const referralId = selected?.referralId ?? null;
  const referralState = selected?.referralState ?? null;
  // The one human stop (plan §10.1): the server says whether this referral is
  // at a state a coordinator may confirm, and the reader's own roles say
  // whether they are the one who may.
  const mayContact = Boolean(selected?.canContact === true && referralId && abilities.includes("contact_patients"));
  // Asking for evidence is a move on the ledger when the person has a referral
  // (the coordinator's, `write_referrals`), and the study's own decision
  // record when there is none yet (`write`) — the two routes the server has.
  const mayMoveLedger = abilities.includes("write_referrals") || abilities.includes("contact_patients");
  const evidenceAsked = referralState === "needs_evidence";
  // A person's hand on an assessment (plan §7.5): a coordinator or clinician re-judges a rule, a
  // reviewer countersigns. Both are addressed to the assessment the panel shows, so a panel that
  // does not name it offers neither — an address is never guessed.
  const assessmentId = selected?.assessmentId ?? null;
  const mayJudge = Boolean(assessmentId)
    && (abilities.includes("write_referrals") || abilities.includes("review_clinical") || abilities.includes("review_any"));
  const mayReview = Boolean(assessmentId) && (abilities.includes("review_clinical") || abilities.includes("review_any")) && !selected?.reviewedBy;
  const mayAskEvidence = needs.length > 0 && !evidenceAsked && (referralId
    ? mayMoveLedger && (referralState === "candidate" || referralState === "contactable" || referralState === "contacted")
    : abilities.includes("write"));

  /** One write at a time (CW-18): every control that writes is disabled while one is in flight. */
  const once = (key: "contact" | "evidence" | "review", work: () => Promise<unknown>) => {
    if (busy !== null) return;
    setBusy(key);
    void work().finally(() => setBusy(null));
  };

  const review = () => {
    if (!assessmentId || busy !== null) return;
    once("review", () => reviewVcrAssessment(studyId, assessmentId)
      .then(() => { toast.success("已记录复核。"); onDone(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "复核暂时无法记录，请稍后重试。" }))));
  };

  const contact = () => {
    if (!confirming) return;
    const target = confirming;
    once("contact", () => contactVcrReferral(studyId, target.referralId)
      .then(() => { toast.success("已记录联系确认。"); onDone(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "联系确认暂时无法记录，请稍后重试。" })))
      .finally(() => setConfirming(null)));
  };

  const requestEvidence = () => {
    if (!selected || needs.length === 0) return;
    const subject = selected.candidate.id;
    const requests = needs.map((row) => `${row.code} ${row.request ?? criterionStateLabel(row.state)}${row.requestNote ? `（${row.requestNote}）` : ""}`).join("；");
    const failure = "补证请求暂时无法记录，请稍后重试。";
    const done = () => { toast.success("已记录补证请求。"); onDone(); };
    if (referralId) {
      // The ledger: the referral moves to 待补证, with what is asked for and
      // who asked kept on the move.
      once("evidence", () => transitionVcrReferral(studyId, referralId, { to: "needs_evidence", note: requests.slice(0, 1_000) })
        .then(done)
        .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: failure }))));
      return;
    }
    once("evidence", () => recordVcrDecision(studyId, {
      question: `请求补证 ${subject}：${requests}`.slice(0, 500),
      chosen: { kind: "evidence_request", subject, criteria: needs.map((row) => row.code) },
      rationale: requests,
    })
      .then(done)
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: failure }))));
  };

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-4">
        {data.funnel.map((step) => (
          <div key={step.key} className="rounded-card border border-border bg-surface p-4">
            <p className="truncate text-caption text-text-3">{step.label}</p>
            <p className={cn("mt-1 text-metric font-semibold tabular-nums",
              step.tone === "attention" ? "text-warn-strong" : step.tone === "accent" ? "text-accent" : "text-text")}
            >
              {numberText(step.count, 0)}
            </p>
            {step.note && <p className="mt-0.5 truncate text-caption text-text-3">{step.note}</p>}
          </div>
        ))}
      </div>
      <VcrFunnelBar
        eligible={data.funnel.find((step) => step.key === "eligible")?.count ?? null}
        insufficient={data.funnel.find((step) => step.key === "insufficient")?.count ?? null}
        ineligible={data.funnel.find((step) => step.key === "ineligible")?.count ?? null}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Card title={referralStateLabel("candidate")}>
            <ul className="flex flex-col gap-1">
              {data.candidates.map((candidate) => (
                <li key={candidate.id}>
                  <CandidateButton candidate={candidate} current={current === candidate.id} onPick={() => onPick(candidate.id)} />
                </li>
              ))}
            </ul>
          </Card>

          {data.gaps.length > 0 && (
            <Card title="待补证的主要缺口">
              <ul className="flex flex-col gap-2.5">
                {data.gaps.map((gap) => (
                  <li key={gap.code} className="flex items-baseline gap-3">
                    <span className="w-8 shrink-0 text-caption tabular-nums text-text-3">{gap.code}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui text-text">{gap.label}</span>
                      {gap.detail && <span className="block truncate text-caption text-text-3">{gap.detail}</span>}
                    </span>
                    <span className="shrink-0 text-ui tabular-nums text-text">{numberText(gap.count, 0)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.pendingReview && data.pendingReview.count > 0 && (
            // Excluded on a model's word alone: they wait here for a person,
            // and are never counted as 不符合 until one has looked (plan §7.1).
            <Card
              header={(
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-ui font-semibold text-text">待复核排除</h2>
                  <span className="text-caption tabular-nums text-text-3">{`${numberText(data.pendingReview.count, 0)} 人`}</span>
                </div>
              )}
            >
              <ul data-vcr-pending-review="" className="flex flex-wrap gap-1.5">
                {data.pendingReview.subjects.map((subject) => <li key={subject}><Tag>{subject}</Tag></li>)}
              </ul>
            </Card>
          )}
        </div>

        {selected && (
          <Card
            header={(
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-section font-semibold text-text">{selected.candidate.id}</h2>
                <span className="min-w-0 flex-1 text-ui text-text-2">{selected.candidate.summary}</span>
                {selected.referralState && <Tag>{referralStateLabel(selected.referralState)}</Tag>}
              </div>
            )}
          >
            {selected.facts && selected.facts.length > 0 && (
              <dl className="mb-4 grid gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-3 lg:grid-cols-5 [&>div]:bg-surface">
                {selected.facts.map((fact) => (
                  <div key={fact.label} className="p-3">
                    <dt className="truncate text-caption text-text-3">{fact.label}</dt>
                    <dd className={cn("mt-0.5 truncate text-ui font-medium", fact.tone === "attention" ? "text-warn-strong" : "text-text")}>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            <DataTable
              label={`${selected.candidate.id} 的逐条判定`}
              minWidth="min-w-[44rem]"
              columns={[
                { key: "code", header: "编号", rowHeader: true, width: "w-16", cell: (row) => <span className="tabular-nums text-text-3">{row.code}</span> },
                { key: "text", header: "方案原文", cell: (row) => <span className="text-text">{row.text}</span> },
                { key: "state", header: "状态", width: "w-24", cell: (row) => <CriterionState row={row} /> },
                {
                  key: "evidence",
                  header: "患者证据",
                  isEmpty: (row) => !row.evidence,
                  cell: (row) => row.evidence ? (
                    <span className="block">
                      <span className="block text-text">{`“${row.evidence.quote}”`}</span>
                      <span className="block text-caption text-text-3">{[row.evidence.source, row.evidence.at].filter(Boolean).join(" · ")}</span>
                    </span>
                  ) : null,
                },
                {
                  key: "request",
                  header: "补证建议",
                  isEmpty: (row) => !row.request,
                  cell: (row) => row.request ? (
                    <span className="block">
                      <span className="block text-text">{row.request}</span>
                      {row.requestNote && <span className="block text-caption text-text-3">{row.requestNote}</span>}
                    </span>
                  ) : <span className="text-text-3">—</span>,
                },
                ...(mayJudge ? [{
                  key: "judge",
                  header: "改判",
                  width: "w-20",
                  isEmpty: (row: VcrCriterionJudgement) => !row.criterionId,
                  cell: (row: VcrCriterionJudgement) => row.criterionId ? (
                    <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setJudging(row)}>改判</Button>
                  ) : null,
                }] : []),
              ]}
              rows={selected.criteria}
              rowKey={(row) => row.code}
              rowAttrs={(row) => ({
                "data-vcr-criterion": row.code,
                "data-vcr-criterion-state": row.applicable === false ? "not_applicable" : row.state,
              })}
            />

            {selected.trace && selected.trace.length > 0 && (
              // Who moved this person's referral, to where, and when: every step leaves its mark (plan §7.2).
              <ol data-vcr-referral-trace="" aria-label="转诊记录" className="mt-4 divide-y divide-faint border-t border-border">
                {selected.trace.map((step, index) => (
                  <li key={`${step.state}-${index}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <span className="w-28 shrink-0 text-caption tabular-nums text-text-3">{step.at ?? ""}</span>
                    <span className="min-w-0 flex-1 text-ui text-text">
                      {referralStateLabel(step.state)}
                      {step.by && <span className="ml-1.5 text-caption text-text-3">{step.by}</span>}
                    </span>
                    {step.note && <span className="w-full text-caption text-text-3">{step.note}</span>}
                  </li>
                ))}
              </ol>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
              {selected.verdict && (
                <p data-vcr-eligibility="" className="flex min-w-0 flex-1 items-center gap-2 text-ui text-warn-strong">
                  <TriangleAlert size={16} aria-hidden="true" className="shrink-0" />
                  <span className="font-medium">{selected.verdict.text}</span>
                  {selected.verdict.note && <span className="text-text-3">{selected.verdict.note}</span>}
                </p>
              )}
              {mayReview && (
                <Button variant="secondary" loading={busy === "review"} disabled={busy !== null} onClick={review}>复核这份评估</Button>
              )}
              {selected.reviewedBy && <span data-vcr-reviewed-by=""><Tag>{`已复核 · ${selected.reviewedBy}`}</Tag></span>}
              <Button
                variant="secondary"
                loading={busy === "evidence"}
                disabled={!mayAskEvidence || busy !== null}
                onClick={requestEvidence}
              >
                {evidenceAsked ? "已请求补证" : "请求补证"}
              </Button>
              {/* The one human stop: contacting a person is outside the
                  platform and cannot be undone (plan §10.1). */}
              <Button
                disabled={!mayContact || busy !== null}
                onClick={() => { if (mayContact && referralId) setConfirming({ subject: selected.candidate.id, referralId }); }}
              >
                确认后联系
              </Button>
              {!referralId && (
                <p data-vcr-not-contactable="" className="w-full text-right text-caption text-text-3">尚未生成转诊记录，暂不能联系。</p>
              )}
            </div>
          </Card>
        )}
      </div>

      {judging && assessmentId && judging.criterionId && (
        <VcrJudgmentDrawer
          studyId={studyId}
          assessmentId={assessmentId}
          criterion={{ ...judging, criterionId: judging.criterionId }}
          onClose={() => setJudging(null)}
          onSaved={onDone}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title={`确认联系 ${confirming.subject}？`}
          body="联系真实患者是平台之外、不可撤回的动作。确认后会记录是谁在什么时候确认的。"
          confirmLabel="确认联系"
          busy={busy === "contact"}
          onConfirm={contact}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}

/** One person in the list: a button that opens their rule-by-rule judgement. */
function CandidateButton({ candidate, current, onPick }: { candidate: VcrCandidate; current: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      data-vcr-candidate={candidate.id}
      aria-current={current ? "true" : undefined}
      onClick={onPick}
      className={cn("w-full rounded px-2.5 py-2 text-left hover:bg-surface-1", current && "bg-accent-soft hover:bg-accent-soft")}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-ui font-medium text-text">{candidate.id}</span>
        {candidate.site && <span className="shrink-0 text-caption text-text-3">{candidate.site}</span>}
      </span>
      <span className="block truncate text-caption text-text-2">{candidate.summary}</span>
      {candidate.open.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-1">
          {candidate.open.map((open) => (
            <Tag key={open.code} tone="warn">
              {`${open.code} ${criterionStateLabel(open.state)}${open.note ? ` ${open.note}` : ""}`}
            </Tag>
          ))}
        </span>
      )}
      {candidate.priority && (
        <span data-vcr-priority="" className="mt-1 block text-caption text-text-3">
          {candidate.priority.rationale ? `${PRIORITY_LABEL} · ${candidate.priority.rationale}` : PRIORITY_LABEL}
        </span>
      )}
    </button>
  );
}

/** A rule's state for one person — or 「不适用」, which is its own mark and never 未知. */
function CriterionState({ row }: { row: VcrCriterionJudgement }) {
  if (row.applicable === false) {
    return (
      <span data-vcr-not-applicable="" className="inline-flex items-center gap-1.5 whitespace-nowrap text-text-3">
        <CircleMinus size={16} aria-hidden="true" />
        不适用
      </span>
    );
  }
  const Icon = STATE_ICON[row.state] ?? CircleHelp;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap",
      row.state === "satisfied" ? "text-ok" : row.state === "not_satisfied" ? "text-danger-strong" : "text-warn-strong")}
    >
      <Icon size={16} aria-hidden="true" />
      {criterionStateLabel(row.state)}
      {/* The state shown is a person's: the platform's own answer is kept beside it. */}
      {row.overridden && <span data-vcr-overridden=""><Tag>人工改判</Tag></span>}
    </span>
  );
}

/**
 * The ledger itself: one row per person the platform has taken in, at the state
 * it holds them in, and who confirmed the contact. The counts above it are the
 * same ledger summed; this is what they add up.
 */
function ReferralLedger({ studyId, sites }: { studyId: string; sites: NonNullable<MatchingData["sites"]> }) {
  const { state, reload } = useVcrLoad(`${studyId}:referrals`, () => getVcrReferrals(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton rows={3} />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const referrals: VcrReferral[] = state.data;
  if (referrals.length === 0) return null;
  const siteName = (id: string | null) => (id ? sites.find((site) => site.id === id)?.name ?? null : null);
  return (
    <VcrSection title="转诊台账" meta={`${referrals.length} 人`}>
      <DataTable
        label="转诊台账"
        minWidth="min-w-[40rem]"
        columns={[
          { key: "subject", header: "受试者", rowHeader: true, cell: (row) => <span className="tabular-nums text-text">{row.subjectKey}</span> },
          { key: "state", header: "状态", cell: (row) => <Tag>{referralStateLabel(row.state)}</Tag> },
          { key: "site", header: "中心", isEmpty: (row) => !siteName(row.siteId), cell: (row) => siteName(row.siteId) ?? "—" },
          {
            key: "approved",
            header: "联系确认",
            isEmpty: (row) => !row.contactApprovedBy,
            cell: (row) => row.contactApprovedBy
              ? <span className="block">{row.contactApprovedBy}{row.contactApprovedAt && <span className="block text-caption text-text-3">{row.contactApprovedAt.slice(0, 10)}</span>}</span>
              : <span className="text-text-3">—</span>,
          },
          {
            key: "note",
            header: "备注",
            isEmpty: (row) => !row.screenFailReason && !row.enrolledOn,
            cell: (row) => row.screenFailReason ?? (row.enrolledOn ? `入组 ${row.enrolledOn.slice(0, 10)}` : "—"),
          },
        ]}
        rows={referrals}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ "data-vcr-referral": row.id, "data-vcr-referral-row-state": row.state })}
      />
    </VcrSection>
  );
}

function ReferralView({ studyId, data, abilities }: { studyId: string; data: MatchingData; abilities: readonly string[] }) {
  const forecast = data.forecast;
  // The ledger is read by whoever may read referrals: the study's readers, and a site (its own only).
  const readsLedger = abilities.includes("read") || abilities.includes("read_referrals");
  // The band's own level, from the forecast's own rows: 「80% 预测区间」 is
  // written only when the data says 80.
  const level = forecast?.rows?.map((row) => row.value.interval).find((interval) => interval?.kind === "prediction")?.level ?? null;
  const bandName = `${level != null ? `${numberText(level, 0)}% ` : ""}${intervalLabel("prediction")}`;
  const drawable = Boolean(forecast && ((forecast.actual ?? []).length || (forecast.median ?? []).length || (forecast.band ?? []).length));
  return (
    <>
      {data.ledger && data.ledger.length > 0 && (
        <VcrSection title="转诊进度">
          <ol className="grid gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-3 lg:grid-cols-6 [&>li]:bg-surface">
            {data.ledger.map((entry) => (
              <li key={entry.state} data-vcr-referral-state={entry.state} className={cn("p-4", entry.waiting && "bg-accent-soft")}>
                <p className="truncate text-caption text-text-3">{referralStateLabel(entry.state)}</p>
                <p className={cn("mt-1 text-heading font-semibold tabular-nums", entry.waiting ? "text-accent" : "text-text")}>
                  {numberText(entry.count, 0)}
                </p>
                {entry.note && <p className="mt-0.5 truncate text-caption text-text-3">{entry.note}</p>}
              </li>
            ))}
          </ol>
        </VcrSection>
      )}

      {readsLedger && (data.ledger ?? []).length > 0 && <ReferralLedger studyId={studyId} sites={data.sites ?? []} />}

      {forecast && (
        <div className={cn("grid gap-4", drawable && "xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]")}>
          {drawable && (
            <ChartCard
              title="入组预测与实际"
              legend={(
                <>
                  <SourceTag source="observed" />
                  <span className="text-caption text-text-3">实际入组</span>
                  <SourceTag source="predicted" />
                  <span className="text-caption text-text-3">{`预测中位与${bandName}`}</span>
                </>
              )}
              footnote={`实际入组是观察值，预测中位与${intervalLabel("prediction")}是模型输出，两者是不同种类的数。`}
            >
              <VcrForecastChart
                target={forecast.target}
                actual={forecast.actual}
                median={forecast.median}
                band={forecast.band}
                markers={forecast.markers}
                xLabels={forecast.xLabels}
              />
            </ChartCard>
          )}
          <div className={cn("grid gap-4", !drawable && "sm:grid-cols-2 lg:grid-cols-3")}>
            {(forecast.rows ?? []).map((metric) => (
              <VcrStat
                key={metric.key}
                label={metric.label}
                value={metric.value}
                note={<VcrStatNote value={metric.value} basis={metric.note} />}
                className="rounded-card border border-border bg-surface"
              />
            ))}
            {forecast.basis && forecast.basis.length > 0 && (
              <Card title="预测依据">
                <ul className="flex flex-col gap-1 text-caption text-text-2">
                  {forecast.basis.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function SitesView({ data }: { data: MatchingData }) {
  const sites = data.sites ?? [];
  if (sites.length === 0) return <p className="py-12 text-center text-ui text-text-3">还没有中心资料。</p>;
  return (
    <VcrSection title="中心" meta={`${sites.length} 个`}>
      <DataTable
        label="中心"
        minWidth="min-w-[48rem]"
        columns={[
          {
            key: "name",
            header: "中心",
            rowHeader: true,
            cell: (site) => (
              <span className="block">
                <span className="block text-text">{site.name}</span>
                {site.place && <span className="block text-caption text-text-3">{site.place}</span>}
              </span>
            ),
          },
          {
            key: "state",
            header: "状态",
            cell: (site) => (
              <span className="whitespace-nowrap">
                {site.state}
                {site.stateNote && <span className="ml-1.5 text-caption text-text-3">{site.stateNote}</span>}
              </span>
            ),
          },
          { key: "capacity", header: "容量", isEmpty: (site) => !site.capacity, cell: (site) => site.capacity ?? "—" },
          { key: "competing", header: "在研竞争研究", isEmpty: (site) => !site.competing, cell: (site) => site.competing ?? "—" },
          {
            key: "needs",
            header: "未满足的要求",
            isEmpty: (site) => !site.needs || site.needs.length === 0,
            cell: (site) => (site.needs && site.needs.length > 0
              ? <span className="flex flex-wrap gap-1">{site.needs.map((need) => <Tag key={need} tone="warn">{need}</Tag>)}</span>
              : <span className="text-text-3">—</span>),
          },
          {
            key: "contacts",
            header: "联系人",
            align: "right",
            isEmpty: (site) => !site.contacts,
            cell: (site) => numberText(site.contacts ?? null, 0),
          },
          { key: "referred", header: "已转诊", align: "right", cell: (site) => numberText(site.referred, 0) },
          { key: "waiting", header: "待响应", align: "right", cell: (site) => numberText(site.waiting, 0) },
          { key: "enrolled", header: "已入组", align: "right", cell: (site) => numberText(site.enrolled, 0) },
          {
            key: "checked",
            header: "最后核实",
            align: "right",
            cell: (site) => (
              <span className={cn("whitespace-nowrap", site.alert && "font-medium text-warn-strong")}>
                {site.checkedAt ?? "—"}
                {site.alert && <span className="ml-1.5">{site.alert}</span>}
              </span>
            ),
          },
        ]}
        rows={sites}
        rowKey={(site) => site.id}
        rowAttrs={(site) => ({ "data-vcr-site": site.id })}
      />
    </VcrSection>
  );
}

function FollowupView({ data }: { data: MatchingData }) {
  const episodes = data.followup ?? [];
  if (episodes.length === 0) return <p className="py-12 text-center text-ui text-text-3">还没有随访记录。</p>;
  return (
    <VcrSection title="随访" meta={`${episodes.length} 条`}>
      <ul className="divide-y divide-faint">
        {episodes.map((episode) => (
          <li key={episode.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
            <span className="w-28 shrink-0 text-caption tabular-nums text-text-3">{episode.at ?? ""}</span>
            <span className="min-w-0 flex-1 text-ui text-text">{episode.label}</span>
            <Tag>{episode.kind}</Tag>
            {episode.detail && <span className="w-full text-caption text-text-3">{episode.detail}</span>}
          </li>
        ))}
      </ul>
    </VcrSection>
  );
}
