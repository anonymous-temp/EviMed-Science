import { useState } from "react";
import { cancelVcrJob, runVcrTrialSearch, startVcrJudge, type VcrJudgedPair, type VcrJudgedPatient, type VcrStudy } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { useWide } from "@/lib/useMediaQuery";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Drawer } from "@/components/ui/Drawer";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { EmptyState } from "@/components/cards/EmptyState";
import { useVcrRun } from "../useVcrRun";
import { VCR_TRIAL_SEARCH_FAILED } from "../vcrText";
import { FIND_TRIALS_LABEL } from "../vcrActionWords";
import { fitText, JudgedPairDetail, RegistryLink, statusLine, VerdictTag } from "./JudgedPair";
import { Note } from "@/components/ui/Note";
import { JudgedFailures, JudgedProgressNote, judgedCountLabel } from "./JudgedProgress";
import { MatchingExport } from "./MatchingExport";

/**
 * One trial in the patient's list. The row's name is a button that opens the trial's reasons and clauses; the registry address is a link
 * beside it, not inside it, because a link in a button is neither.
 */
function TrialRow({ trial, current, onPick }: { trial: VcrJudgedPair; current: boolean; onPick: () => void }) {
  const meta = [statusLine(trial), fitText(trial)].filter(Boolean).join(" · ");
  return (
    <li
      data-vcr-trial={trial.id}
      data-vcr-trial-kind={trial.kind}
      className={cn("rounded-card border border-border px-3 py-2.5", current ? "bg-accent-soft" : "bg-surface")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-5 shrink-0 text-caption tabular-nums text-text-3">{trial.rank}</span>
        {trial.kind === "protocol" ? <Tag>本研究方案</Tag> : <RegistryLink pair={trial} />}
        <span className="ml-auto"><VerdictTag pair={trial} /></span>
      </div>
      <button type="button" aria-current={current ? "true" : undefined} onClick={onPick} className="mt-1 block w-full rounded text-left">
        <span className="block text-ui font-semibold text-text">{trial.title}</span>
        {trial.why && <span className="block truncate text-ui text-text-2">{trial.why}</span>}
        {meta && <span className="block text-caption text-text-3">{meta}</span>}
        {trial.eligibilityNote && <span className="block text-caption text-text-3">{trial.eligibilityNote}</span>}
        {trial.clausesNote && <span className="block text-caption text-text-3">{trial.clausesNote}</span>}
        {trial.recordGap && <span className="block text-caption text-text-3">{trial.recordGap}</span>}
        {trial.basisChanged && <span data-vcr-basis-changed={trial.basisChanged.kind} className="block text-caption text-warn-strong">{trial.basisChanged.label}</span>}
      </button>
    </li>
  );
}

/**
 * 给患者找试验: one patient's trials as the judging job and the conversation saved them.
 *
 * The list fills in as trials are judged — most promising first by the model's fit score, the ones a stated condition rules out last — with the plain state
 * 「已完成 n / m」, and a run that failed or stopped short says so and offers the rest; it never reads as 「还没有找过」. A trial opens
 * into what the model made of it in three groups (what supports it, what rules it out, what is still to check) and then every clause
 * with the patient's own sentences and the way into the record at each.
 *
 * Hidden knowledge:
 *  - **The platform ranks, the page draws.** The order, every verdict and every count are the server's, from the saved rows; the match level
 *    is a word for the score and the confidence stays a step behind it. Nothing here is a probability.
 *  - **A pair that failed is its own row, with its reason in words**, under the list, with one action that judges only what is left.
 *  - **The detail is beside the list on a wide page and in a drawer on a narrow one**, so a phone never has to scroll past twenty rows to find it.
 *  - The study's own protocol, when it was judged for this patient, stands in the same list as the study's.
 */
export function PatientTrials({ studyId, study, judged, picked, onPick, onChanged }: {
  studyId: string;
  study: VcrStudy;
  judged: VcrJudgedPatient;
  /** The trial the reader chose; the server opens the first when none is. */
  picked: string | null;
  onPick: (id: string | null) => void;
  /** Something was started, stopped or searched: read the page again. */
  onChanged: () => void;
}) {
  const { run, busy: searching } = useVcrRun(study);
  const [working, setWorking] = useState(false);
  const wide = useWide();
  const mayRun = study.abilities.includes("run");
  const mayRead = study.abilities.includes("read_patient_level");
  const subject = judged.subjectKey;
  const { progress, trials, selected } = judged;
  const chosen = picked ?? selected?.id ?? null;

  const search = () => { void run(() => runVcrTrialSearch(studyId, subject), VCR_TRIAL_SEARCH_FAILED, onChanged); };
  const act = (work: () => Promise<unknown>, failure: string) => {
    if (working) return;
    setWorking(true);
    void work().then(onChanged).catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: failure }))).finally(() => setWorking(false));
  };
  // What was judged on a note the person has since added to.
  const olderNote = trials.filter((trial) => trial.basisChanged?.kind === "record").map((trial) => trial.id);
  const resume = () => act(() => startVcrJudge(studyId, { direction: "patient_to_trial", subjectKey: subject, resume: true }), "暂时无法继续判定，请稍后重试。");
  const stop = () => { if (progress.jobId) act(() => cancelVcrJob(studyId, progress.jobId!), "暂时无法停止，请稍后重试。"); };

  const detail = selected ? <JudgedPairDetail studyId={studyId} pair={selected} mayReadRecord={mayRead} subject={subject} /> : null;
  return (
    <Section
      title={`${judged.label} 的试验`}
      count={judgedCountLabel(progress)}
      toolbar={(
        <div className="flex flex-wrap items-center gap-2">
          <MatchingExport studyId={studyId} where={{ direction: "patient_to_trial", subjectKey: subject }} abilities={study.abilities} />
          {mayRun && <Button variant="secondary" size="sm" actionKind="start" loading={searching} onClick={search}>{FIND_TRIALS_LABEL}</Button>}
        </div>
      )}
    >
      <div className="flex flex-col gap-4">
        {judged.search && mayRun && (
          <div data-vcr-search-line="">
            <Note action={<Button variant="secondary" size="sm" actionKind="start" loading={searching} onClick={search}>再查一次</Button>}>{judged.search}</Note>
          </div>
        )}
        {judged.stale && (
          <div data-vcr-stale={judged.stale.count} className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface-2 px-3 py-2">
            <p className="min-w-0 flex-1 text-ui text-text-2">{judged.stale.label}（{judged.stale.count} 个试验）；原来的判定保留为历史。</p>
          </div>
        )}
        {olderNote.length > 0 && (
          <div data-vcr-older-note={olderNote.length} className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface-2 px-3 py-2">
            <div className="min-w-0 flex-1"><Note result={["病历在判定之后有更新：", { n: olderNote.length }, " 个试验的判定依据的是更新前的病历；原来的判定保留为历史。"]} /></div>
          </div>
        )}
        <JudgedProgressNote progress={progress} noun="个试验" mayRun={mayRun} busy={working} onResume={resume} onStop={stop} />
        <div data-vcr-patient-trials={subject} className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            {trials.length > 0
              ? (
                <ul aria-label={`${judged.label} 的试验名单`} className="flex flex-col gap-2">
                  {trials.map((trial) => <TrialRow key={trial.id} trial={trial} current={wide && chosen === trial.id} onPick={() => onPick(trial.id)} />)}
                </ul>
              )
              : <EmptyState title="还没有判完的试验" />}
            <JudgedFailures failures={judged.failed} noun="个试验" titled />
          </div>
          {wide && detail && <Card>{detail}</Card>}
        </div>
        {!wide && picked && selected?.id === picked && (
          <Drawer title={selected.title} onClose={() => onPick(null)} widthClassName="max-w-2xl">
            <JudgedPairDetail studyId={studyId} pair={selected} mayReadRecord={mayRead} subject={subject} showTitle={false} compact />
          </Drawer>
        )}
      </div>
    </Section>
  );
}
