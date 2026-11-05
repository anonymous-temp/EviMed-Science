import { useStudyFrame } from "../studyFrameContext";
import { ClinicalTimeline, CriterionTable, useMatchingControls } from "../ClinicalMatchingDetails";
import { VcrCorrectionCasesActions } from "../VcrCorrectionCasesActions";
import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight, CircleCheck, PenLine, TriangleAlert } from "lucide-react";
import { VCR_TRIAL_VERDICT_LABELS_ZH } from "@evimed/domain";
import {
  getVcrJudged,
  getVcrJudgedLatest,
  getVcrMatching,
  VCR_VERDICTS,
  type VcrCandidate,
  type VcrCriterionJudgement,
  type VcrJudged,
  type VcrMatchingTab as MatchingData,
  type VcrStudy,
  type VcrVerdict,
} from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/DataTable";
import { Headline } from "@/components/ui/Headline";
import { IconButton } from "@/components/ui/IconButton";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { measurement } from "@/lib/measurement";
import { StatTile } from "@/components/ui/StatTile";
import { Tag } from "@/components/ui/Tag";
import type { ToolbarFilter } from "@/components/ui/Toolbar";
import { EmptyState } from "@/components/cards/EmptyState";
import { VcrJudgmentDrawer } from "../VcrJudgmentDrawer";
import { VcrFunnelBar } from "../VcrDiagrams";
import { VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { VcrToolbarActions } from "../VcrToolbarActions";
import { PatientTrials } from "./PatientTrials";
import { PatientTrialsLegacy } from "./PatientTrialsLegacy";
import { MatchingPeople } from "./MatchingPeople";
import { MatchingExport } from "./MatchingExport";
import { useVcrToolbar } from "../studyFrameContext";
import { useVcrLoad, VcrTabError } from "../vcrTabKit";
import { criterionStateLabel, NO_VALUE, numberText, VCR_MATCHING_EMPTY_T0 } from "../vcrText";
import { DRAFT_PREFIX, INTAKE_LABEL } from "../vcrActionWords";

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

/** People on one page of the protocol's table. */
const PAGE = 25;

/** The verdicts a table screened by rules is narrowed to, on the funnel's own keys. */
type RuleVerdict = "eligible" | "insufficient" | "ineligible";
const RULE_VERDICTS: ReadonlyArray<{ key: RuleVerdict; label: string }> = Object.freeze([
  { key: "eligible", label: "符合" }, { key: "insufficient", label: "可能符合 · 待补证" }, { key: "ineligible", label: "不符合" },
]);

const DIRECTIONS: ReadonlyArray<{ value: Direction; label: string }> = Object.freeze([
  { value: "trial_to_patient", label: "给试验找患者" },
  { value: "patient_to_trial", label: "给患者找试验" },
]);

/**
 * Evidence-backed eligibility in either direction.
 *
 * Two sets of data stand behind it. What the model judged — the job's and the conversation's rows — is read from `matching/judged` and drawn by
 * `PatientTrials` (one patient's trials) and `MatchingPeople` (one protocol's people). What the earlier path assessed is the tab's own payload, and it
 * is drawn, as it always was, for a patient or a protocol that has nothing in the judgments; nobody's earlier assessment disappears.
 */
export function MatchingTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const view = "matching";
  const [direction, setDirection] = useState<Direction>("trial_to_patient");
  const [candidate, setCandidate] = useState<string | null>(null);
  // 给患者找试验: the trial of the patient's list the reader opened. It is the patient's, so it goes with them.
  const [trial, setTrial] = useState<string | null>(null);
  const [protocolVersionId, setProtocolVersionId] = useState<string | null>(null);
  // Which of the two sets of results the reader chose, where both exist; null until they choose.
  const [source, setSource] = useState<"judged" | "rules" | null>(null);
  // 给试验找患者: the verdict the table is narrowed to, the page of it, and the person opened.
  const [verdict, setVerdict] = useState<VcrVerdict | null>(null);
  const [offset, setOffset] = useState(0);
  const [person, setPerson] = useState<string | null>(null);
  // The rule path pages on the server too: the verdict its table is narrowed to and the page of it.
  const [ruleVerdict, setRuleVerdict] = useState<RuleVerdict | null>(null);
  const [ruleOffset, setRuleOffset] = useState(0);
  const frame = useStudyFrame();
  // The reader has chosen something themselves (a direction, a protocol, a patient): where the newest work is no longer decides what opens.
  const touched = useRef(false);
  const { state, reload, last } = useVcrLoad(`${studyId}:matching:${view}:${direction}:${protocolVersionId ?? "latest"}`, () => {
    const askedFor = view === "matching" && candidate ? candidate : null;
    const askedTrial = view === "matching" && direction === "patient_to_trial" && askedFor && trial ? trial : null;
    return getVcrMatching(studyId, {
      view, direction, ...(protocolVersionId ? { protocolVersionId } : {}), ...(askedFor ? { candidate: askedFor } : {}),
      ...(direction === "trial_to_patient" && ruleVerdict ? { verdict: ruleVerdict } : {}), ...(direction === "trial_to_patient" && ruleOffset > 0 ? { offset: String(ruleOffset) } : {}),
      ...(askedTrial ? { trial: askedTrial } : {}),
    }).then((page): MatchingPage => ({ ...page, askedFor }));
  });
  // What the model judged for what the reader chose: one patient's trials, or one protocol's people. Nothing is asked until a patient is chosen.
  const judgedLoad = useVcrLoad<VcrJudged | null>(`${studyId}:matching-judged:${direction}:${protocolVersionId ?? "latest"}${direction === "patient_to_trial" ? `:${candidate ?? ""}` : ""}`, () => {
    if (direction === "patient_to_trial") {
      return candidate ? getVcrJudged(studyId, { direction, subjectKey: candidate, target: trial }) : Promise.resolve(null);
    }
    return getVcrJudged(studyId, { direction, protocolVersionId, verdict, offset, limit: PAGE, subjectKey: person });
  });
  const reloadAll = () => { reload(); judgedLoad.reload(); };
  const pick = (id: string) => {
    touched.current = true;
    // An empty id is the select's own 请选择患者: nobody asked for.
    setCandidate(id || null);
    setTrial(null);
    // The judged page's key follows the patient, so a read that fails for the new patient is a failure and never the last patient's page under the new name.
    reload();
  };
  const pickTrial = (id: string | null) => {
    setTrial(id);
    judgedLoad.reload();
    // The earlier path's page opens the trial through the tab's own payload.
    reload();
  };
  const narrowTo = (next: VcrVerdict | null) => { setVerdict(next); setOffset(0); judgedLoad.reload(); };
  const pickPerson = (key: string | null) => { setPerson(key); judgedLoad.reload(); };
  const pageTo = (next: number) => { setOffset(next); judgedLoad.reload(); };
  const narrowRules = (next: RuleVerdict | null) => { setRuleVerdict(next); setRuleOffset(0); reload(); };
  const pageRules = (next: number) => { setRuleOffset(next); reload(); };

  const switchDirection = (next: Direction) => {
    touched.current = true; setDirection(next); setCandidate(null); setTrial(null); setVerdict(null); setOffset(0); setPerson(null); setRuleVerdict(null); setRuleOffset(0);
    // To the protocols' side with none chosen yet: land on the newest protocol that was judged, as the first load does, and not on whichever the list starts with.
    if (next === "trial_to_patient" && protocolVersionId === null) {
      void getVcrJudgedLatest(studyId, "trial_to_patient").then((latest) => { if (latest?.direction === "trial_to_patient") setProtocolVersionId((now) => now ?? latest.protocolVersionId); }).catch(() => undefined);
    }
  };

  // Once per visit: a study with a patient and no protocol opens on that patient. A later click on the other direction stays there.
  const opened = useRef(false);
  const opensOn = state.kind === "ready" ? state.data.opensOnPatient : undefined;
  useEffect(() => {
    // A link that named a patient, or a choice already made, is not overruled by the roster's first.
    if (opened.current || !opensOn || touched.current) return;
    opened.current = true;
    setDirection("patient_to_trial");
    setCandidate(opensOn);
  }, [opensOn]);

  // Once per visit, where the newest work is: a reply's link to this page names a patient (`?object=`), and a link to the page alone lands on
  // whatever was judged last — a patient's trials or a protocol's people — unless the reader has already chosen something by then.
  const [params] = useSearchParams();
  const linked = params.get("object");
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current) return;
    landed.current = true;
    if (linked && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(linked)) { touched.current = true; setDirection("patient_to_trial"); setCandidate(linked); return; }
    // No cancel on cleanup: the guard above lets this run once, and a development remount (StrictMode) would otherwise cancel the only read.
    void getVcrJudgedLatest(studyId).then((latest) => {
      if (!latest || touched.current) return;
      if (latest.direction === "patient_to_trial") { setDirection("patient_to_trial"); setCandidate(latest.subjectKey); }
      else setProtocolVersionId(latest.protocolVersionId);
    }).catch(() => undefined);
  }, [studyId, linked]);

  // The judged page, once it is read, when it is about what the reader chose and something was judged, failed or asked for. Anything else is the earlier path's page.
  const judged = judgedLoad.state.kind === "ready" ? judgedLoad.state.data : null;
  const judgedAnswered = judged && judged.held && judged.direction === direction ? judged : null;
  // The rule assessments stand beside what the model judged, one chip away: judging one person does not hide what the rules said of everyone. A study with no record to read opens on them.
  const hasRuleRows = state.kind === "ready" && state.data.available !== false && ((state.data.candidates?.length ?? 0) > 0 || Boolean(state.data.people?.verdict));
  const onRules = hasRuleRows && (source === "rules" || (source === null && state.kind === "ready" && state.data.available !== false && state.data.evaluateBy === "rules"));
  const judgedHere = onRules ? null : judgedAnswered;
  // The job writes pairs while the page is open: the note's n of m follows it.
  const judging = judgedHere?.progress.state === "running" || judgedHere?.progress.state === "waiting_budget";
  const reloadJudged = judgedLoad.reload;
  useEffect(() => {
    if (!judging) return undefined;
    const timer = window.setInterval(reloadJudged, 5_000);
    return () => window.clearInterval(timer);
  }, [judging, reloadJudged]);

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
    judged: judgedHere !== null,
    onRules,
    onProtocol: (id) => { touched.current = true; setProtocolVersionId(id); setVerdict(null); setOffset(0); setPerson(null); setRuleVerdict(null); setRuleOffset(0); },
    onCandidate: pick,
    onReload: reloadAll,
  });

  // --- the band's one row: the views, the direction, the protocol and the patient, and what starts work ----------------------------
  const filters: ToolbarFilter[] = [
    ...(view === "matching"
      ? [{ kind: "chips" as const, label: "匹配方向", neutral: "trial_to_patient", value: direction, onChange: (next: string) => switchDirection(next as Direction), options: DIRECTIONS }]
      : []),
    ...(controls?.filters ?? []),
    ...(hasRuleRows && judgedAnswered ? [{ kind: "chips" as const, label: "结果来自", neutral: "judged", value: onRules ? "rules" : "judged",
      onChange: (next: string) => setSource(next as "judged" | "rules"), options: [{ value: "judged", label: "模型判定" }, { value: "rules", label: "规则筛选" }] }] : []),
    // The rule path's table, narrowed to one verdict the same way; its counts are the whole table's, whatever page is in view.
    ...(onRules && state.kind === "ready" && state.data.available !== false ? [{
      kind: "chips" as const, label: "结论", neutral: "all", value: ruleVerdict ?? "all",
      onChange: (next: string) => narrowRules(next === "all" ? null : next as RuleVerdict),
      options: [
        { value: "all", label: "全部", ...(state.data.funnel.find((step) => step.key === "candidates")?.count != null ? { count: state.data.funnel.find((step) => step.key === "candidates")!.count as number } : {}) },
        ...RULE_VERDICTS.map((entry) => ({ value: entry.key, label: entry.label, ...(state.data.funnel.find((step) => step.key === entry.key)?.count != null ? { count: state.data.funnel.find((step) => step.key === entry.key)!.count as number } : {}) })),
      ],
    }] : []),
    // The protocol's people, narrowed to one verdict: the band carries the filter, the table the page.
    ...(judgedHere?.direction === "trial_to_patient" ? [{
      kind: "chips" as const, label: "结论", neutral: "all", value: verdict ?? "all",
      onChange: (next: string) => narrowTo(next === "all" ? null : next as VcrVerdict),
      options: [
        // A count too small to show this reader is left off its chip, and off the total.
        { value: "all", label: "全部", ...(VCR_VERDICTS.some((key) => judgedHere.tallies[key] === null) ? {} : { count: VCR_VERDICTS.reduce((sum, key) => sum + (judgedHere.tallies[key] ?? 0), 0) }) },
        ...VCR_VERDICTS.map((key) => ({ value: key, label: VCR_TRIAL_VERDICT_LABELS_ZH[key], ...(judgedHere.tallies[key] === null ? {} : { count: judgedHere.tallies[key] as number }) })),
      ],
    }] : []),
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

  if (state.kind === "loading" || judgedLoad.state.kind === "loading") return <div className="flex flex-col gap-6">{aside}<VcrTabSkeleton /></div>;
  if (state.kind === "error") return <div className="flex flex-col gap-6">{aside}<VcrTabError message={state.message} onRetry={reload} /></div>;
  // What the model judged could not be read: that is said, with 重试. It is not "nothing was judged", and the earlier page does not stand in for it.
  if (judgedLoad.state.kind === "error") return <div className="flex flex-col gap-6">{aside}<VcrTabError message={judgedLoad.state.message} onRetry={judgedLoad.reload} /></div>;
  const data = state.data;
  if (data.available === false) {
    return (
      <div data-vcr-matching-unavailable="" className="flex flex-col gap-6">
        {aside}
        <EmptyState title="暂时无法进行患者匹配" action={<>
          {data.unavailable?.code !== "vcr_matching_unavailable" && <Button variant="secondary" onClick={reload}>重试读取匹配结果</Button>}
          {frame && <Button variant="secondary" onClick={() => frame.openPanel("intake")}>{INTAKE_LABEL}</Button>}
          {frame && <Button variant="text" actionKind="draft" onClick={() => frame.openChat("请先评估患者匹配需要的资料和证据，并说明目前缺失的信息。", { kind: "step", studyId, objectId: "matching" })}><PenLine size={16} aria-hidden="true" />{`${DRAFT_PREFIX}检查证据`}</Button>}
        </>} />
      </div>
    );
  }
  // 给患者找试验 is a page of its own: one patient's trials, most promising first, with the chosen trial's reasons and clauses.
  if (judgedHere?.direction === "patient_to_trial") {
    const owner = judgedHere.subjectKey;
    return (
      <div className="flex flex-col gap-6">
        {aside}
        {judgedHere.cutNote && <p data-vcr-judged-cut="" className="text-caption text-warn-strong">{judgedHere.cutNote}</p>}
        <PatientTrials studyId={studyId} study={study} judged={judgedHere} picked={trial} onPick={pickTrial} onChanged={judgedLoad.reload} />
        {timelineOwner(data) === owner && (
          <ClinicalTimeline studyId={studyId} data={data} subject={owner} mayReadOriginal={study.abilities.includes("read_patient_level")} />
        )}
      </div>
    );
  }
  // 给试验找患者: every person the model judged against the protocol, a page at a time, and what each clause did to them.
  if (judgedHere?.direction === "trial_to_patient") {
    return (
      <div className="flex flex-col gap-6">
        {aside}
        {judgedHere.cutNote && <p data-vcr-judged-cut="" className="text-caption text-warn-strong">{judgedHere.cutNote}</p>}
        <MatchingPeople
          studyId={studyId}
          study={study}
          judged={judgedHere}
          verdict={verdict}
          onVerdict={narrowTo}
          onPage={pageTo}
          picked={person}
          onPick={pickPerson}
          onPatient={(key) => { touched.current = true; setDirection("patient_to_trial"); setCandidate(key); setTrial(null); setPerson(null); }}
          onChanged={judgedLoad.reload}
        />
      </div>
    );
  }
  // The earlier path's page of one patient's trials: drawn as it always was for a patient the judgments have nothing on. It is taken only
  // where the server sent that page; a server that did not answers the direction with the protocol's page.
  if (view === "matching" && direction === "patient_to_trial" && data.patientTrials) {
    const owner = data.patientTrials.subject;
    return (
      <div className="flex flex-col gap-6">
        {aside}
        <PatientTrialsLegacy
          studyId={studyId}
          study={study}
          page={data.patientTrials}
          roster={data.candidateRoster ?? []}
          asked={candidate}
          picked={trial}
          facts={owner && timelineOwner(data) === owner ? data.timeline : undefined}
          onPick={(id) => pickTrial(id)}
          onSearched={reloadAll}
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
      {/* The sentence is about who was assessed. */}
      {view === "matching" && data.headline && <Headline parts={[data.headline]} />}
      {view === "matching" && (
        <MatchingView
          studyId={studyId}
          data={data}
          abilities={study.abilities}
          picked={candidate}
          onPick={pick}
          onDone={reload}
          onPage={pageRules}
          onClearVerdict={() => narrowRules(null)}
        />
      )}
      {view === "matching" && <ClinicalTimeline studyId={studyId} data={data} subject={timelineOwner(data)} mayReadOriginal={study.abilities.includes("read_patient_level")} />}
      {study.abilities.includes("export") && study.abilities.includes("read_patient_level") && <VcrCorrectionCasesActions key={studyId} studyId={studyId} />}
    </div>
  );
}

/**
 * Whether the page has nothing in any of its views. Every part counts: tallies with no candidate list are a study whose matching has
 * already run, and offering 「开始评估」 there would ask for work that is done.
 */
function emptyPage(data: MatchingData): boolean {
  // The funnel is the server's tally of the assessments that are stored; a page whose list is empty and whose tally is not has
  // results (they are all on people the list does not show), and 「尚未生成」 would say the opposite of what the study holds.
  return data.candidates.length === 0 && !data.funnel.some((step) => (step.count ?? 0) > 0)
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

function MatchingView({ studyId, data, abilities, picked, onPick, onDone, onPage, onClearVerdict }: {
  studyId: string;
  data: MatchingPage;
  abilities: readonly string[];
  /** The candidate asked for; the detail may still be the previous one while it loads. */
  picked: string | null;
  onPick: (id: string) => void;
  onDone: () => void;
  onPage: (offset: number) => void;
  onClearVerdict: () => void;
}) {
  const [judging, setJudging] = useState<VcrCriterionJudgement | null>(null);
  const selected = data.selected;
  const current = picked ?? selected?.candidate.id ?? null;
  // The rules of the panel are tagged from the facts of the panel's person: with another person's timeline under it, from none.
  const caveatFacts = selected && timelineOwner(data) === selected.candidate.id ? data.timeline : undefined;
  const applicable = selected ? selected.criteria.filter((row) => row.applicable !== false) : [];
  const allMet = applicable.length > 0 && applicable.every((row) => row.state === "satisfied");
  const assessmentId = selected?.assessmentId ?? null;
  const mayJudge = Boolean(assessmentId)
    && (abilities.includes("review_clinical") || abilities.includes("review_any"));

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data.funnel.map((step) => (
          <StatTile
            key={step.key}
            label={step.label}
            reading={measurement(step.count, "", step.label)}
            renderMeasured={reading => <span className={cn(step.tone === "attention" && "text-warn-strong", step.tone === "accent" && "text-accent")}>{numberText(reading.value, 0)}</span>}
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
          {(data.candidates.length > 0 || data.people?.verdict) && (
            <Section
              title="患者"
              count={data.people ? data.people.total : data.candidates.length}
              toolbar={<MatchingExport studyId={studyId} where={{ direction: "trial_to_patient", protocolVersionId: data.protocolVersionId }} abilities={abilities} source="rules" />}
            >
              {/* A section holds one shape of body: the table beside it is a div, and so is the list. */}
              <div>
                {data.candidates.length > 0
                  ? (
                    <>
                      <List label="患者名单">
                        {data.candidates.map((candidate) => (
                          <CandidateRow key={candidate.id} candidate={candidate} current={current === candidate.id} onPick={() => onPick(candidate.id)} />
                        ))}
                      </List>
                      {data.people && data.people.total > data.candidates.length && (
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <span className="text-caption tabular-nums text-text-3">{`第 ${data.people.offset + 1}–${data.people.offset + data.candidates.length} 位，共 ${data.people.total} 位`}</span>
                          <span className="flex items-center gap-1">
                            <IconButton icon={ChevronLeft} label="上一页" size="sm" disabled={data.people.offset === 0} onClick={() => onPage(Math.max(0, data.people!.offset - data.people!.limit))} />
                            <IconButton icon={ChevronRight} label="下一页" size="sm" disabled={!data.people.more} onClick={() => onPage(data.people!.offset + data.people!.limit)} />
                          </span>
                        </div>
                      )}
                    </>
                  )
                  : <EmptyState title="没有这个结论的患者" action={<Button variant="secondary" onClick={onClearVerdict}>看全部</Button>} />}
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

        </div>

        {selected && (
          <Card
            header={(
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-section font-semibold text-text">{selected.candidate.id}</h2>
                <span className="min-w-0 flex-1 text-ui text-text-2">{selected.candidate.summary}</span>
                {selected.candidate.basis === "withdrawn" && <Tag>已撤回</Tag>}
                {selected.candidate.basis === "updated" && <Tag>依据已更新</Tag>}
                {selected.candidate.olderRules && <Tag>旧版规则算的</Tag>}
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
                  <Button size="sm" variant="secondary" onClick={() => setJudging(row)}>改判</Button>
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
              {selected.reviewedBy && <span data-vcr-reviewed-by=""><Tag>{`已复核 · ${selected.reviewedByName ?? NO_VALUE}`}</Tag></span>}
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
          {candidate.eligibility === "ineligible" && <Tag>不符合</Tag>}
          {candidate.basis === "withdrawn" && <Tag>已撤回</Tag>}
          {candidate.basis === "updated" && <Tag>依据已更新</Tag>}
          {candidate.olderRules && <Tag>旧版规则算的</Tag>}
        </>
      )}
      meta={(
        <span className="flex flex-col gap-1">
          <span className="truncate text-caption text-text-2">{candidate.summary}</span>
          {(candidate.open.length > 0 || (candidate.failed?.length ?? 0) > 0) && (
            <span className="flex flex-wrap gap-1">
              {/* The rules this person fails first: a not-eligible person's row says which, and the row opens the evidence. */}
              {(candidate.failed ?? []).map((failed) => (
                <Tag key={`failed-${failed.code}`} tone="warn">{`${failed.code} ${criterionStateLabel(failed.state)}`}</Tag>
              ))}
              {candidate.open.map((open) => (
                <Tag key={open.code} tone="warn">
                  {`${open.code} ${criterionStateLabel(open.state)}${open.note ? ` ${open.note}` : ""}`}
                </Tag>
              ))}
            </span>
          )}
        </span>
      )}
    />
  );
}
