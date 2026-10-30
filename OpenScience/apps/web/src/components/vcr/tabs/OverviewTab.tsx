import { VcrResearchProgress } from "../VcrResearchProgress";
import { resumeVcrStep } from "../vcrConversationActions";
import { Link } from "react-router";
import { VCR_STEPS, VCR_STEP_STATUS_LABELS_ZH } from "@evimed/domain";
import { type VcrAttention, type VcrCountKey, type VcrStepKey, type VcrStudy, type VcrTabKey } from "@/lib/vcrClient";
import { columnTime } from "@/lib/runPresentation";
import { AllowanceTopUp } from "@/components/runs/AllowanceTopUp";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Headline } from "@/components/ui/Headline";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { RailMark, type RailState } from "@/components/ui/ProgressRail";
import { Section } from "@/components/ui/Section";
import { VcrCountsBand } from "../VcrCounts";
import { VcrNoDefinition } from "../VcrStates";
import { useStudyFrame } from "../studyFrameContext";
import { VCR_STEP_TABS, vcrTabPath } from "../vcrTabs";
import { stepName } from "../vcrActivity";

/**
 * 总览: where the study is, in the order a reader asks.
 *
 *  1. **One sentence** — what the study has found, or, before it has found anything, what it asks.
 *  2. **The numbers it has** — real patients, events, effective sample size, generated records: only those that exist, each opening
 *     what it counts. At T0 that is one.
 *  3. **What needs the reader** — one `Note` per line, each with the thing to do about it, and only while there is one.
 *  4. **The seven steps** — one row each: its state, the one number it found, when it last moved, and a way to its tab. It replaces
 *     the band of four cells that were three placeholders and a number.
 *  5. **The deliverables** — what the study has produced that can be opened; drafts folded under one line.
 *
 * There is no button for the next step here: it is in the header of every tab, where it is whichever tab the reader is on
 * (`StudyFrame`), and while work goes on the strip under the header says what is happening. A study nobody has described has none
 * of the above, and says what is missing: the first sentence, said in its conversation.
 * Component: OverviewTab; owner: VCR; rules: show facts backed by study records.
 * Anatomy: Headline, progress, counts, attention, steps and deliverables.
 * Variants: Empty study and populated study.
 * States: Progress distinguishes input, definition and result states.
 * Hit area: Links and buttons retain shared component sizing.
 * Keyboard: Native links and buttons remain focusable.
 * Long content: Fact rows wrap.
 * Theme: Shared sections and semantic tokens.
 * Responsive: Sections stack.
 * Verification: OverviewTab.test.tsx and VcrResearchProgress.test.tsx.
 */
export function OverviewTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { headline, counts, attention, deliverables } = study.overview;
  if (!study.question?.trim() && !headline && !counts && deliverables.length === 0 && study.overview.researchProgress?.definition !== "saved") return <VcrNoDefinition study={study} />;
  const sentence = headline ?? study.question;
  return (
    <div className="flex flex-col gap-6">
      {sentence && <Headline parts={[sentence]} className={headline ? undefined : "text-text-2"} />}

      <VcrResearchProgress progress={study.overview.researchProgress} studyId={studyId} />

      <VcrCountsBand counts={counts} tabOf={(key) => countTab(key, study, studyId)} />

      <Attention items={attention} study={study} studyId={studyId} />

      <StepList study={study} studyId={studyId} />

      <Deliverables items={deliverables} studyId={studyId} />
    </div>
  );
}

/** The tab that holds what a count counts. */
function countTab(key: VcrCountKey, study: VcrStudy, studyId: string): string {
  const designs = study.overview.designs.length > 0;
  const tab: VcrTabKey = key === "realPatients" ? "population"
    : key === "events" ? "trial"
      : key === "effectiveSampleSize" || key === "priorEffectiveSampleSize" ? "comparator"
        : key === "reconstructedPseudoPatients" ? "data"
          // The generated records are those of the headline result: a design's when there is one, else the virtual patients'.
          : designs ? "trial" : study.stepSummaries.patients ? "patients" : "population";
  return vcrTabPath(studyId, tab);
}

/* ------------------------------------------------------------------------- the steps */

const RAIL: Record<string, RailState> = {
  done: "done", minimal: "done", running: "active", queued: "waiting", failed: "attention", stale: "attention", none: "todo",
};

/** The first step the study was asked to do and did not finish, to tell one 「这一步没有做完」 line from the next. */
function failedSteps(study: Pick<VcrStudy, "steps">): VcrStepKey[] {
  return (VCR_STEPS as readonly VcrStepKey[]).filter((step) => study.steps[step]?.status === "failed");
}

/** The seven steps, in order, each a row that opens the tab that holds it. */
function StepList({ study, studyId }: { study: VcrStudy; studyId: string }) {
  const started = (VCR_STEPS as readonly VcrStepKey[]).filter(step => study.steps[step]?.requested === true || study.steps[step]?.status && study.steps[step]?.status !== "none");
  if (!started.length) return null;
  return (
    <Section title="研究记录">
      <List label="已开展的任务" divided>
        {started.map((step) => {
          const record = study.steps[step];
          const status = record?.status ?? "none";
          const state = RAIL[status] ?? "todo";
          const note = study.stepSummaries[step]?.note ?? null;
          // A step nobody has started or that is only in line has no time of its own: the row of the study's creation would read as news.
          const moved = record?.updatedAt && status !== "none" && status !== "queued" ? Date.parse(record.updatedAt) : Number.NaN;
          return (
            <ListRow
              key={step}
              title={stepName(step)}
              to={`${vcrTabPath(studyId, VCR_STEP_TABS[step])}${step === "patients" ? "?level=individual" : ""}`}
              titleProps={{ "data-vcr-step-row": step }}
              leading={<RailMark state={state} />}
              trailing={(
                <>
                  <span data-vcr-step-state={status} className="w-14 shrink-0 text-text-2">{(VCR_STEP_STATUS_LABELS_ZH as Record<string, string>)[status] ?? "未开始"}</span>
                  <span className="min-w-20 text-right tabular-nums text-text sm:min-w-28">{note ?? ""}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums max-sm:hidden">{Number.isFinite(moved) ? columnTime(moved) : ""}</span>
                </>
              )}
            />
          );
        })}
      </List>
    </Section>
  );
}

/* ------------------------------------------------------------------------- what needs the reader */

/** Where a line's link goes: the tab the server named, and nowhere it did not. */
function attentionTab(item: VcrAttention): VcrTabKey | null {
  if (!item.action) return null;
  return item.action.tab ?? item.tab ?? null;
}

/**
 * 需要关注: what the reader has to look at, and nothing else — one `Note` per line, each with the one thing to do about it. It is not
 * drawn at all while there is nothing: a card that says 「现在没有需要你处理的事」 is a card explaining its own absence.
 *
 * A line the reader has nothing to do about (a step they may not run) is not a sentence without an action: the step's dot says it
 * needs a look, and the line that waits on the budget is the frame's (it is the same on every tab).
 */
function Attention({ items, study, studyId }: { items: readonly VcrAttention[]; study: VcrStudy; studyId: string }) {
  const frame = useStudyFrame();
  const mayRun = study.abilities.includes("run");
  const failed = failedSteps(study);
  let failedAt = 0;
  const notes = items.flatMap((item, index) => {
    const text = item.items && item.items.length > 0 ? `${item.text}：${item.items.join("、")}` : item.text;
    const tone = item.tone === "attention" ? "warn" as const : "default" as const;
    // The line that waits on the budget is on every tab, from the frame.
    if (item.kind === "budget_confirm") return [];
    let action: React.ReactNode = null;
    if (item.kind === "allowance_waiting" && item.waiting) action = <AllowanceTopUp waiting={item.waiting} />;
    else if (item.kind === "step_failed") {
      const step = failed[failedAt++];
      if (step && mayRun) {
        action = <Button size="sm" variant="secondary" onClick={() => resumeVcrStep(frame, studyId, step)}>在对话中继续</Button>;
      }
    } else if (item.kind === "stale") {
      action = <Button size="sm" variant="text" onClick={() => frame?.openPanel("changes")}>看变更记录</Button>;
    } else if (item.kind === "export_failed") {
      if (study.abilities.includes("export")) action = <Button size="sm" variant="secondary" onClick={() => frame?.openPanel("export")}>重新导出</Button>;
    } else {
      const tab = attentionTab(item);
      if (tab && item.action) action = <Link to={vcrTabPath(studyId, tab)} className="shrink-0 rounded text-ui text-link hover:underline">{item.action.label}</Link>;
    }
    return action ? [<Note key={`${item.kind}-${index}`} tone={tone} action={action}>{text}</Note>] : [];
  });
  if (notes.length === 0) return null;
  return <section data-vcr-attention="" aria-label="需要关注" className="flex flex-col gap-2">{notes}</section>;
}

/* ------------------------------------------------------------------------- the deliverables */

function Deliverables({ items, studyId }: { items: VcrStudy["overview"]["deliverables"]; studyId: string }) {
  // Listed when finished; a draft (nothing was written, or it is not final) is folded under one line — unless nothing is finished, when the
  // drafts are the list: a section that is a heading and a fold is a shape of its own, and the owner's study had one (the walk's
  // `section>div+details` was the page's fourth kind of section against a budget of three).
  const finished = items.filter((item) => !item.draft);
  const drafts = items.filter((item) => item.draft);
  if (items.length === 0) return null;
  const rows = (list: typeof items) => (
    <List label="交付物" divided>
      {list.map((item) => (
        <ListRow
          key={item.id}
          title={item.title}
          // The package opens in the reader on this page (`?package=`), which is one address rather than a route of its own.
          to={`${vcrTabPath(studyId, "overview")}?package=${encodeURIComponent(item.id)}`}
          meta={item.meta ?? (item.draft ? "草稿" : undefined)}
        />
      ))}
    </List>
  );
  return (
    <Section title="交付物" count={finished.length > 0 ? finished.length : drafts.length}>
      {finished.length > 0 ? rows(finished) : rows(drafts)}
      {finished.length > 0 && drafts.length > 0 && (
        <Disclosure summary={`草稿 ${drafts.length}`} className="mt-3">
          {rows(drafts)}
        </Disclosure>
      )}
    </Section>
  );
}
