import { CircleCheck, ExternalLink, TriangleAlert } from "lucide-react";
import {
  runVcrTrialSearch,
  type VcrClinicalTimelineEntry,
  type VcrPatientTrial,
  type VcrPatientTrials,
  type VcrStudy,
} from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Tag, type TagTone } from "@/components/ui/Tag";
import { CriterionTable } from "../ClinicalMatchingDetails";
import { useVcrRun } from "../useVcrRun";
import { VcrSection } from "../vcrTabKit";
import {
  eligibilityLabel,
  patientTrialsNoneSentence,
  VCR_PATIENT_TRIALS_CHOOSE,
  VCR_PATIENT_TRIALS_NOBODY,
  VCR_PATIENT_TRIALS_OFF,
  VCR_TRIAL_SEARCH_FAILED,
} from "../vcrText";

/** The eligibility chip's tone: the ones still to settle are the ones a coordinator acts on. */
const ELIGIBILITY_TONE: Record<string, TagTone> = { eligible: "accent", insufficient_evidence: "warn", pending: "warn" };

/** The registry, phase and status line a trial's row and card share; whatever the registry did not say is left out, never filled in. */
function phaseAndStatus(trial: VcrPatientTrial): string {
  return [trial.phase, trial.status].filter(Boolean).join(" · ");
}

/** The conditions and the sites of a registry trial, as the registry's record has them; nothing for the study's own protocol. */
function placeAndConditions(trial: VcrPatientTrial): string {
  const sites = trial.sites;
  const where = sites
    ? [sites.total != null ? `${sites.total} 个中心` : null, sites.countries.length ? sites.countries.join("、") : null].filter(Boolean).join(" · ")
    : "";
  return [trial.conditions.join("、"), where].filter(Boolean).join(" · ");
}

/** The trial's page on its registry, when the server sent an address for it. */
function RegistryLink({ trial }: { trial: VcrPatientTrial }) {
  if (!trial.registryId) return null;
  if (!trial.url) return <span className="text-caption tabular-nums text-text-2">{trial.registryId}</span>;
  return (
    <a
      href={trial.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-caption tabular-nums text-accent hover:underline"
    >
      {trial.registryId}
      <ExternalLink size={16} aria-hidden="true" />
    </a>
  );
}

/**
 * One trial in the patient's list. The row's name is a button that opens the trial's criteria; the registry address is a link beside it,
 * not inside it, because a link in a button is neither.
 */
function TrialRow({ trial, current, onPick }: { trial: VcrPatientTrial; current: boolean; onPick: () => void }) {
  const line = phaseAndStatus(trial);
  return (
    <li
      data-vcr-trial={trial.id}
      data-vcr-trial-kind={trial.kind}
      className={cn("rounded-card border border-border px-3 py-2.5", current ? "bg-accent-soft" : "bg-surface")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-5 shrink-0 text-caption tabular-nums text-text-3">{trial.rank}</span>
        {trial.kind === "protocol" ? <Tag>本研究方案</Tag> : <RegistryLink trial={trial} />}
        {trial.eligibility && (
          <span className="ml-auto">
            <Tag tone={ELIGIBILITY_TONE[trial.eligibility] ?? "neutral"}>{eligibilityLabel(trial.eligibility)}</Tag>
          </span>
        )}
      </div>
      <button type="button" aria-current={current ? "true" : undefined} onClick={onPick} className="mt-1 block w-full rounded text-left">
        <span className="block text-ui font-medium text-text">{trial.title}</span>
        {line && <span className="block text-caption text-text-2">{line}</span>}
        <span className="block text-caption text-text-3">{trial.summary}</span>
      </button>
    </li>
  );
}

/**
 * 给患者找试验: the page of one patient's trials.
 *
 * The server ranks the list and judges every criterion in code; this draws what it sent, in the order it sent it. The study's own protocol
 * versions that have judged the patient stand in the same list, as the study's, and a registry trial a run found stands with the address of
 * its page. Choosing a trial re-reads the page with `trial=`, so the criteria drawn are always the server's for that pair of patient and
 * trial.
 *
 * Hidden knowledge:
 *  - **The one action is a run.** 为该患者找试验 asks for a run of the matching capability for this patient through the same path as 让 AI 做:
 *    the study's conversation opens when it starts, and a run that has to wait for the one before it stays here with a sentence.
 *    The trials the study already holds are judged for the patient in the same request, so a deferred one still has an answer to show.
 *  - **A heading names whose trials these are from the page, not from the select.** While the next patient's page is being read, the old
 *    one stays on screen, dimmed, under its own patient's name.
 *  - The study's own protocol has no 改判 here: a person's hand on a rule belongs to the protocol's page, where the assessment it is
 *    addressed to is shown.
 */
export function PatientTrials({ studyId, study, page, roster, asked, picked, facts, onPick, onSearched }: {
  studyId: string;
  study: VcrStudy;
  page: VcrPatientTrials;
  /** The patients the study holds — the ones the select offers. */
  roster: readonly string[];
  /** The patient the reader asked for; the page may still be the one before. */
  asked: string | null;
  /** The trial the reader chose; the page may still be the one before. */
  picked: string | null;
  /** The facts of the page's patient, when the tab holds them: the rows are tagged by what has been through their evidence. */
  facts?: readonly VcrClinicalTimelineEntry[];
  /** Choose a trial. */
  onPick: (id: string) => void;
  /** A request that stayed on the page was made: read it again. */
  onSearched: () => void;
}) {
  const { run, busy } = useVcrRun(study);
  const subject = page.subject;
  // Starting a run is `run`'s: a reader who cannot start one is not offered the button the route would refuse.
  const mayRun = study.abilities.includes("run");

  if (!page.available) {
    return <p data-vcr-patient-trials-unavailable="" className="py-12 text-center text-ui text-text-3">{VCR_PATIENT_TRIALS_OFF}</p>;
  }

  const ask = () => {
    if (!subject) return;
    void run(() => runVcrTrialSearch(studyId, subject), VCR_TRIAL_SEARCH_FAILED, onSearched);
  };

  if (!subject) {
    // Nobody is chosen — or the study holds nobody to choose. The button is there and says, by the sentence beside it, why it cannot be pressed.
    return (
      <div data-vcr-patient-trials-empty="nobody" className="flex flex-col items-center gap-4 py-12 text-center">
        <p id="vcr-patient-trials-ask" className="max-w-measure text-ui text-text-2">
          {roster.length > 0 ? VCR_PATIENT_TRIALS_CHOOSE : VCR_PATIENT_TRIALS_NOBODY}
        </p>
        {mayRun && <Button disabled aria-describedby="vcr-patient-trials-ask">为该患者找试验</Button>}
      </div>
    );
  }

  if (page.trials.length === 0) {
    return (
      <div data-vcr-patient-trials-empty="none" className="flex flex-col items-center gap-4 py-12 text-center">
        <p className="max-w-measure text-ui text-text-2">{patientTrialsNoneSentence(subject)}</p>
        {mayRun && <Button loading={busy} onClick={ask}>为该患者找试验</Button>}
      </div>
    );
  }

  const selected = page.selected;
  const chosen = page.trials.find((trial) => trial.id === (picked ?? selected?.id)) ?? null;
  const shownTrial = selected ? page.trials.find((trial) => trial.id === selected.id) ?? null : null;
  // The next page is being read: what is on screen is the previous one, and says so by its look.
  const staleList = asked !== subject;
  const staleDetail = staleList || (picked !== null && selected?.id !== picked);
  const eligible = shownTrial?.eligibility === "eligible";
  const where = shownTrial ? placeAndConditions(shownTrial) : "";

  return (
    <VcrSection
      title={`${subject} 的试验`}
      meta={(
        <span className="inline-flex items-center gap-3">
          <span>{`${page.trials.length} 项`}</span>
          {mayRun && <Button variant="secondary" loading={busy} onClick={ask}>为该患者找试验</Button>}
        </span>
      )}
    >
      <div data-vcr-patient-trials={subject} className="grid gap-4 xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <ul aria-busy={staleList || undefined} className={cn("flex flex-col gap-2", staleList && "opacity-60")}>
          {page.trials.map((trial) => (
            <TrialRow key={trial.id} trial={trial} current={chosen?.id === trial.id} onPick={() => onPick(trial.id)} />
          ))}
        </ul>

        {selected && shownTrial && (
          <div aria-busy={staleDetail || undefined} className={cn(staleDetail && "opacity-60")}>
            <Card
              header={(
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="min-w-0 text-ui font-medium text-text">{shownTrial.title}</h3>
                  <RegistryLink trial={shownTrial} />
                  {selected.assessedAt && <span className="ml-auto text-caption text-text-3">{`评估于 ${selected.assessedAt}`}</span>}
                </div>
              )}
            >
              {(phaseAndStatus(shownTrial) || where) && (
                <p className="mb-4 text-caption text-text-2">{[phaseAndStatus(shownTrial), where].filter(Boolean).join(" · ")}</p>
              )}
              <CriterionTable
                label={`${shownTrial.registryId ?? shownTrial.title} 的逐条判定`}
                rows={selected.criteria}
                facts={facts}
              />
              {selected.verdict && (
                <p
                  data-vcr-eligibility=""
                  className={cn("mt-4 flex min-w-0 items-center gap-2 border-t border-border pt-3 text-ui", eligible ? "text-ok" : "text-warn-strong")}
                >
                  {eligible
                    ? <CircleCheck size={16} aria-hidden="true" className="shrink-0" />
                    : <TriangleAlert size={16} aria-hidden="true" className="shrink-0" />}
                  <span className="font-medium">{selected.verdict.text}</span>
                  {selected.verdict.note && <span className="text-text-3">{selected.verdict.note}</span>}
                </p>
              )}
            </Card>
          </div>
        )}
      </div>
    </VcrSection>
  );
}
