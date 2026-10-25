import { ClinicalTimeline, CriterionTable, useMatchingControls } from "../ClinicalMatchingDetails";
import { VcrCorrectionCasesActions } from "../VcrCorrectionCasesActions";
import { useState } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import {
  getVcrMatching,
  recordVcrDecision,
  reviewVcrAssessment,
  type VcrCandidate,
  type VcrCriterionJudgement,
  type VcrMatchingTab as MatchingData,
  type VcrStudy,
} from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/DataTable";
import { Headline } from "@/components/ui/Headline";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { StatTile } from "@/components/ui/StatTile";
import { Tag } from "@/components/ui/Tag";
import type { ToolbarFilter } from "@/components/ui/Toolbar";
import { EmptyState } from "@/components/cards/EmptyState";
import { VcrJudgmentDrawer } from "../VcrJudgmentDrawer";
import { VcrFunnelBar } from "../VcrDiagrams";
import { VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { VcrToolbarActions } from "../VcrToolbarActions";
import { PatientTrials } from "./PatientTrials";
import { useVcrToolbar } from "../studyFrameContext";
import { useVcrLoad, VcrTabError } from "../vcrTabKit";
import { criterionStateLabel, NO_VALUE, numberText, VCR_MATCHING_EMPTY_T0 } from "../vcrText";

type Direction = NonNullable<MatchingData["direction"]>;

/**
 * A page of the tab with what it was asked for. Its timeline is the facts of the person named in the request (`?candidate=`), or of
 * the server's own default when nobody was — and the panel above it is the first candidate's whenever the person asked for has no
 * assessment (a registered person nobody has evaluated yet), so the two can be two people.
 */
type MatchingPage = MatchingData & { askedFor: string | null };

/** Whose facts the page's timeline holds, or null when it cannot be told: nobody was asked for and there is no panel to say. */
function timelineOwner(page: MatchingPage): string | null {
  return page.askedFor ?? page.selected?.candidate.id ?? null;
}

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

/** Evidence-backed eligibility in either direction, without recruitment operations. */
export function MatchingTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const view = "matching";
  const [direction, setDirection] = useState<Direction>("trial_to_patient");
  const [candidate, setCandidate] = useState<string | null>(null);
  // 给患者找试验: the trial of the patient's list the reader opened. It is the patient's, so it goes with them.
  const [trial, setTrial] = useState<string | null>(null);
  const [protocolVersionId, setProtocolVersionId] = useState<string | null>(null);
  const { state, reload, last } = useVcrLoad(`${studyId}:matching:${view}:${direction}:${protocolVersionId ?? "latest"}`, () => {
    const askedFor = view === "matching" && candidate ? candidate : null;
    const askedTrial = view === "matching" && direction === "patient_to_trial" && askedFor && trial ? trial : null;
    return getVcrMatching(studyId, {
      view, direction, ...(protocolVersionId ? { protocolVersionId } : {}), ...(askedFor ? { candidate: askedFor } : {}),
      ...(askedTrial ? { trial: askedTrial } : {}),
    }).then((page): MatchingPage => ({ ...page, askedFor }));
  });
  const pick = (id: string) => {
    // An empty id is the select's own 请选择患者: nobody asked for.
    setCandidate(id || null);
    setTrial(null);
    // Same key, a new round: the tab stays on screen while the person loads.
    reload();
  };
  const pickTrial = (id: string) => {
    setTrial(id);
    reload();
  };

  const switchDirection = (next: Direction) => { setDirection(next); setCandidate(null); setTrial(null); };

  // The controls are the reader's own instrument: the chip they just used, the patient they are filling in. They are drawn from this
  // key's page once it has arrived and from the newest one before that — also when this one could not be read — so a change of
  // protocol or direction never unmounts them (focus falls to <body>, a half-made choice is lost; review V-M2).
  const shown = state.kind === "ready" ? state.data : last;
  const canRun = study.abilities.includes("run") && study.abilities.includes("read_patient_level");
  const controls = useMatchingControls({
    studyId,
    data: view === "matching" && shown && shown.available !== false ? shown : null,
    direction,
    protocolId: protocolVersionId,
    subjectKey: direction === "patient_to_trial" ? candidate : undefined,
    settling: state.kind !== "ready",
    canRun,
    onProtocol: setProtocolVersionId,
    onCandidate: pick,
    onReload: reload,
  });

  // --- the band's one row: the views, the direction, the protocol and the patient, and what starts work ----------------------------
  const filters: ToolbarFilter[] = [
    ...(view === "matching"
      ? [{ kind: "chips" as const, label: "匹配方向", neutral: "trial_to_patient", value: direction, onChange: (next: string) => switchDirection(next as Direction), options: DIRECTIONS }]
      : []),
    ...(controls?.filters ?? []),
  ];
  // The tab as it opens, before the reader has chosen a view, a direction, a protocol or a person: nothing to switch between yet, so
  // an empty one is the step's one sentence and its one button, with or without protocol versions behind it (R11). Once the reader
  // has chosen, they got there by the switches, and an answer that comes back empty keeps them — the way back must not vanish with
  // the page (review V-M3).
  const asOpened = view === "matching" && direction === "trial_to_patient" && protocolVersionId === null && candidate === null;
  const summary = shown && shown.available !== false ? partnerLine(shown) : "";
  useVcrToolbar({
      label: "患者匹配",
      filters,
      ...(summary ? { summary } : {}),
      ...(controls && controls.actions.length > 0 ? { actions: <VcrToolbarActions actions={controls.actions} /> } : {}),
    });
  const aside = controls ? <div className="flex flex-col gap-2">{controls.notes}{controls.compare}</div> : null;

  if (state.kind === "loading") return <div className="flex flex-col gap-6">{aside}<VcrTabSkeleton /></div>;
  if (state.kind === "error") return <div className="flex flex-col gap-6">{aside}<VcrTabError message={state.message} onRetry={reload} /></div>;
  const data = state.data;
  if (data.available === false) {
    return (
      <div data-vcr-matching-unavailable="">
        <EmptyState title={data.unavailable?.message ?? "患者匹配在本部署尚未接入。"} />
      </div>
    );
  }
  // 给患者找试验 is a page of its own: one patient's trials, ranked, with the chosen trial's criteria. It is taken only where the server
  // sent that page; a server that did not answers the direction with the protocol's page, and that is drawn as it always was.
  if (view === "matching" && direction === "patient_to_trial" && data.patientTrials) {
    const owner = data.patientTrials.subject;
    return (
      <div className="flex flex-col gap-6">
        {aside}
        <PatientTrials
          studyId={studyId}
          study={study}
          page={data.patientTrials}
          roster={data.candidateRoster ?? []}
          asked={candidate}
          picked={trial}
          facts={owner && timelineOwner(data) === owner ? data.timeline : undefined}
          onPick={pickTrial}
          onSearched={reload}
        />
        {owner && timelineOwner(data) === owner && (
          <ClinicalTimeline studyId={studyId} data={data} subject={owner} mayReadOriginal={study.abilities.includes("read_patient_level")} />
        )}
      </div>
    );
  }
  const nothing = emptyPage(data);
  if (nothing && asOpened) {
    // 开始评估 where there is something to evaluate — protocol versions to evaluate and people registered to evaluate them for —
    // and the step's own ask where there is not (no criteria yet, or at T0 nobody): that is what the step's button fills in.
    const evaluable = canRun && (data.protocols?.length ?? 0) > 0 && (data.candidateRoster?.length ?? 0) > 0;
    return evaluable
      ? <div className="flex flex-col gap-6">{aside}<EmptyState title="尚未生成匹配评估" description="上方可选择方案和患者，逐条评估符合条件、排除条件及缺失证据。" /></div>
      : <VcrStepPending studyId={studyId} study={study} step="matching" hint={study.tier === "T0" ? VCR_MATCHING_EMPTY_T0 : undefined} />;
  }
  if (nothing) {
    return (
      <div className="flex flex-col gap-6">
        {aside}
        <VcrStepPending studyId={studyId} study={study} step="matching" hint={study.tier === "T0" ? VCR_MATCHING_EMPTY_T0 : undefined} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {aside}
      {/* The sentence is about who was assessed; the referral ledger, the sites and the follow-up say their own numbers. */}
      {view === "matching" && data.headline && <Headline parts={[data.headline]} />}
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
      {view === "matching" && <ClinicalTimeline studyId={studyId} data={data} subject={timelineOwner(data)} mayReadOriginal={study.abilities.includes("read_patient_level")} />}
      {study.abilities.includes("export") && study.abilities.includes("read_patient_level") && <VcrCorrectionCasesActions key={studyId} studyId={studyId} />}
    </div>
  );
}

/**
 * Whether the page has nothing in any of its views. Every sub-view counts: a referral ledger with no candidate list is a study whose
 * matching has already run, and offering 「开始评估」 there would ask for work that is done.
 */
function emptyPage(data: MatchingData): boolean {
  return data.candidates.length === 0 && !data.pendingReview
    // A person in view counts once something is known of them: recorded facts, or an assessment. A protocol listed as 尚未评估 is not one.
    && !(data.timeline?.length || data.comparisons?.some((entry) => entry.summary));
}

/**
 * A study with protocol versions and people registered, and nothing evaluated yet: the step's one sentence and the one button that
 * evaluates the newest protocol for all of them. The job runs on its own time, so once it is queued the way to read the answer stands
 * beside the line that says it was asked.
 */
function partnerLine(data: MatchingData): string {
  return [
    data.partner?.name ? `合作方：${data.partner.name}` : null,
    data.partner?.candidates != null ? `患者 ${numberText(data.partner.candidates, 0)} 名` : null,
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
  data: MatchingPage;
  abilities: readonly string[];
  /** The candidate asked for; the detail may still be the previous one while it loads. */
  picked: string | null;
  onPick: (id: string) => void;
  onDone: () => void;
}) {
  const [judging, setJudging] = useState<VcrCriterionJudgement | null>(null);
  const [busy, setBusy] = useState<"evidence" | "review" | null>(null);
  const selected = data.selected;
  const current = picked ?? selected?.candidate.id ?? null;
  // The rules of the panel are tagged from the facts of the panel's person: with another person's timeline under it, from none.
  const caveatFacts = selected && timelineOwner(data) === selected.candidate.id ? data.timeline : undefined;
  const needs = selected ? evidenceNeeds(selected.criteria) : [];
  const applicable = selected ? selected.criteria.filter((row) => row.applicable !== false) : [];
  const allMet = applicable.length > 0 && applicable.every((row) => row.state === "satisfied");
  const assessmentId = selected?.assessmentId ?? null;
  const mayJudge = Boolean(assessmentId)
    && (abilities.includes("review_clinical") || abilities.includes("review_any"));
  const mayReview = Boolean(assessmentId) && (abilities.includes("review_clinical") || abilities.includes("review_any")) && !selected?.reviewedBy;
  const mayAskEvidence = needs.length > 0 && abilities.includes("write");

  /** One write at a time (CW-18): every control that writes is disabled while one is in flight. */
  const once = (key: "evidence" | "review", work: () => Promise<unknown>) => {
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

  const requestEvidence = () => {
    if (!selected || needs.length === 0) return;
    const subject = selected.candidate.id;
    const requests = needs.map((row) => `${row.code} ${row.request ?? criterionStateLabel(row.state)}${row.requestNote ? `（${row.requestNote}）` : ""}`).join("；");
    const failure = "补证请求暂时无法记录，请稍后重试。";
    const done = () => { toast.success("已记录补证请求。"); onDone(); };
    once("evidence", () => recordVcrDecision(studyId, {
      question: `请求补证 ${subject}：${requests}`.slice(0, 500),
      chosen: { kind: "evidence_request", subject, assessmentId, criteria: needs.map((row) => row.code), criterionIds: needs.flatMap(row => row.criterionId ? [row.criterionId] : []) },
      rationale: requests,
    })
      .then(done)
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: failure }))));
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data.funnel.map((step) => (
          <StatTile
            key={step.key}
            label={step.label}
            value={<span className={cn(step.tone === "attention" && "text-warn-strong", step.tone === "accent" && "text-accent")}>{numberText(step.count, 0)}</span>}
            note={step.note ?? undefined}
          />
        ))}
      </div>
      <VcrFunnelBar
        eligible={data.funnel.find((step) => step.key === "eligible")?.count ?? null}
        insufficient={data.funnel.find((step) => step.key === "insufficient")?.count ?? null}
        ineligible={data.funnel.find((step) => step.key === "ineligible")?.count ?? null}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {data.candidates.length > 0 && (
            <Section title="患者" count={data.candidates.length}>
              {/* A section holds one shape of body: the table beside it is a div, and so is the list. */}
              <div>
                <List label="患者名单">
                  {data.candidates.map((candidate) => (
                    <CandidateRow key={candidate.id} candidate={candidate} current={current === candidate.id} onPick={() => onPick(candidate.id)} />
                  ))}
                </List>
              </div>
            </Section>
          )}

          {data.gaps.length > 0 && (
            <Section title="待补证的主要缺口" count={data.gaps.length}>
              <DataTable
                label="待补证的主要缺口"
                minWidth="min-w-0"
                columns={[
                  { key: "code", header: "编号", rowHeader: true, width: "w-14", cell: (gap) => <span className="tabular-nums text-text-3">{gap.code}</span> },
                  {
                    key: "gap",
                    header: "缺口",
                    cell: (gap) => (
                      <span className="flex flex-col">
                        <span className="text-text">{gap.label}</span>
                        {gap.detail && <span className="text-caption text-text-3">{gap.detail}</span>}
                      </span>
                    ),
                  },
                  { key: "count", header: "人数", align: "right", cell: (gap) => <span className="tabular-nums text-text">{numberText(gap.count, 0)}</span> },
                ]}
                rows={data.gaps}
                rowKey={(gap) => gap.code}
              />
            </Section>
          )}

          {data.pendingReview && data.pendingReview.count > 0 && (
            // Excluded on a model's word alone: they wait here for a person,
            // and are never counted as 不符合 until one has looked (plan §7.1).
            <Card
              header={(
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-section font-semibold text-text">待复核排除</h2>
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
                {selected.candidate.basis === "withdrawn" && <Tag>已撤回</Tag>}
                {selected.candidate.basis === "updated" && <Tag>依据已更新</Tag>}
              </div>
            )}
          >
            {selected.facts && selected.facts.length > 0 && (
              <dl className="mb-4 grid gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-3 lg:grid-cols-5 [&>div]:bg-surface">
                {selected.facts.map((fact) => (
                  <div key={fact.label} className="p-3">
                    <dt className="truncate text-caption text-text-3">{fact.label}</dt>
                    <dd className={cn("mt-0.5 truncate text-ui", fact.tone === "attention" ? "text-warn-strong" : "text-text")}>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            <CriterionTable
              label={`${selected.candidate.id} 的逐条判定`}
              rows={selected.criteria}
              facts={caveatFacts}
              extraColumns={mayJudge ? [{
                key: "judge",
                header: "改判",
                width: "w-20",
                isEmpty: (row: VcrCriterionJudgement) => !row.criterionId,
                cell: (row: VcrCriterionJudgement) => row.criterionId ? (
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setJudging(row)}>改判</Button>
                ) : null,
              }] : []}
            />

            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
              {selected.verdict && (
                <p data-vcr-eligibility={allMet ? "met" : "open"} className={cn("flex min-w-0 flex-1 items-center gap-2 text-ui max-sm:basis-full", allMet ? "text-ok" : "text-warn-strong")}>
                  {/* The mark follows the judgements, not the sentence: every applicable criterion satisfied is a check, anything else keeps its warning. */}
                  {allMet ? <CircleCheck size={16} aria-hidden="true" className="shrink-0" /> : <TriangleAlert size={16} aria-hidden="true" className="shrink-0" />}
                  <span>{selected.verdict.text}</span>
                  {selected.verdict.note && <span className="text-text-3">{selected.verdict.note}</span>}
                </p>
              )}
              {mayReview && (
                <Button variant="secondary" loading={busy === "review"} disabled={busy !== null} onClick={review}>复核这份评估</Button>
              )}
              {selected.reviewedBy && <span data-vcr-reviewed-by=""><Tag>{`已复核 · ${selected.reviewedByName ?? NO_VALUE}`}</Tag></span>}
              {/* A person with nothing open has nothing to ask for: the button is not drawn grey, it is not drawn. */}
              {(needs.length > 0) && (
                <Button
                  variant="secondary"
                  loading={busy === "evidence"}
                  disabled={!mayAskEvidence || busy !== null}
                  onClick={requestEvidence}
                >
                  记录待补证项
                </Button>
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


    </>
  );
}

/** One person in the list: a row that opens their rule-by-rule judgement beside the list. */
function CandidateRow({ candidate, current, onPick }: { candidate: VcrCandidate; current: boolean; onPick: () => void }) {
  return (
    <ListRow
      title={candidate.id}
      onOpen={onPick}
      selected={current}
      titleProps={{ "data-vcr-candidate": candidate.id }}
      trailing={(
        <>
          {candidate.basis === "withdrawn" && <Tag>已撤回</Tag>}
          {candidate.basis === "updated" && <Tag>依据已更新</Tag>}
          {candidate.site && <span className="shrink-0 text-caption text-text-3">{candidate.site}</span>}
        </>
      )}
      meta={(
        <span className="flex flex-col gap-1">
          <span className="truncate text-caption text-text-2">{candidate.summary}</span>
          {candidate.open.length > 0 && (
            <span className="flex flex-wrap gap-1">
              {candidate.open.map((open) => (
                <Tag key={open.code} tone="warn">
                  {`${open.code} ${criterionStateLabel(open.state)}${open.note ? ` ${open.note}` : ""}`}
                </Tag>
              ))}
            </span>
          )}
          {candidate.priority && (
            <span data-vcr-priority="" className="text-caption text-text-3">
              {candidate.priority.rationale ? `${PRIORITY_LABEL} · ${candidate.priority.rationale}` : PRIORITY_LABEL}
            </span>
          )}
        </span>
      )}
    />
  );
}
