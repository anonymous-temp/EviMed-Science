import { Link } from "react-router";
import { CircleDashed, Download, History, Sparkles } from "lucide-react";
import { runVcrStep, type VcrAttention, type VcrStepKey, type VcrStudy, type VcrTabKey } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { AllowanceTopUp } from "@/components/runs/AllowanceTopUp";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Tag";
import { VcrCountsBand } from "../VcrCounts";
import { VcrNoDefinition } from "../VcrStates";
import { useVcrRun } from "../useVcrRun";
import { VcrHeadline, VcrSection } from "../vcrTabKit";
import { hasDefinition, VCR_RAIL_STEPS, vcrTabPath } from "../vcrTabs";
import { stepLabel, VCR_NEXT_STEP_WORDS } from "../vcrText";

/**
 * 总览: four things, and nothing a reader has to scroll past to reach them.
 *
 *  1. **One sentence** — what the study has found, or, before it has found anything, what it asks.
 *  2. **The next step** — one primary button, 「让 AI 做下一步：…」, that starts the first step nothing has started.
 *  3. **The four numbers** — real patients, events, effective sample size, generated records — here and on no other tab: a band
 *     repeated on five tabs was the same four numbers read five times.
 *  4. **The deliverables** — what the study has produced that can be opened.
 *
 * 「需要关注」 is a fifth only while it is not empty. The key-number tiles, the trade-off chart, the change log and the disease pack
 * that used to follow are each on the tab or in the menu where a reader goes for them: the designs on 试验, the cards on 定义与证据,
 * the record under 「变更记录」.
 *
 * A study nobody has described has none of it, and says what is missing: the first sentence, said in the conversation.
 */
export function OverviewTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { headline, counts, attention, deliverables } = study.overview;
  if (!hasDefinition(study) && !headline && deliverables.length === 0) return <VcrNoDefinition study={study} />;
  const sentence = headline ?? study.question;
  return (
    <div className="flex flex-col gap-6">
      {sentence && <VcrHeadline className={headline ? undefined : "text-text-2"}>{sentence}</VcrHeadline>}

      <NextStep studyId={studyId} study={study} />

      <VcrCountsBand counts={counts} />

      {attention.length > 0 && <AttentionCard items={attention} studyId={studyId} />}

      {/* Not drawn while there is none: a heading over 「还没有交付物」 is a title over an empty box. */}
      {deliverables.length > 0 && (
        <VcrSection title="交付物">
          <ul className="divide-y divide-faint">
            {deliverables.map((item) => (
              <li key={item.id} className="relative flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-ui text-text">
                    {/* The package opens in the reader on this page (`?package=`), which is one address rather than a route
                        of its own; the file itself is one click further, inside it. */}
                    <Link
                      to={`${vcrTabPath(studyId, "overview")}?package=${encodeURIComponent(item.id)}`}
                      className="min-w-0 truncate after:absolute after:inset-0 after:rounded after:content-['']"
                    >
                      {item.title}
                    </Link>
                    {item.draft && <Tag>草稿</Tag>}
                  </p>
                  {item.meta && <p className="truncate text-caption tabular-nums text-text-3">{item.meta}</p>}
                </div>
                <Download size={16} aria-hidden="true" className="shrink-0 text-text-3" />
              </li>
            ))}
          </ul>
        </VcrSection>
      )}
    </div>
  );
}

/**
 * The first step the programme has not started, which is the one 「让 AI 做下一步」 asks for. A step already under way is said,
 * and there is no button to press for it; a study with nothing left to start has no button at all. Starting a step is `run`'s: a
 * reader who cannot start one is shown the sentence and not a button that would be refused.
 */
export function nextStepOf(study: Pick<VcrStudy, "steps">): VcrStepKey | null {
  for (const { key } of VCR_RAIL_STEPS) {
    if (key === "definition") continue;
    const status = study.steps[key]?.status;
    if (status === undefined || status === "none") return key;
  }
  return null;
}

function NextStep({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { run, busy } = useVcrRun(study);
  // Nothing can be started for a study nobody has described: the sentence that says so is on the empty tabs.
  const next = hasDefinition(study) ? nextStepOf(study) : null;
  const underway = VCR_RAIL_STEPS.find(({ key }) => study.steps[key]?.status === "running" || study.steps[key]?.status === "queued");
  const mayRun = study.abilities.includes("run");
  if (!next) {
    return underway ? <p data-vcr-next="underway" className="text-ui text-text-3">{`正在进行：${stepLabel(underway.key)}`}</p> : null;
  }
  const word = VCR_NEXT_STEP_WORDS[next] ?? stepLabel(next);
  return (
    <div data-vcr-next={next} className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {mayRun && (
        <Button onClick={() => run(() => runVcrStep(studyId, next), "这一步无法开始，请稍后重试。")} loading={busy}>
          {`让 AI 做下一步：${word}`}
        </Button>
      )}
      {underway && <span className="text-caption text-text-3">{`正在进行：${stepLabel(underway.key)}`}</span>}
    </div>
  );
}

const TONE_ICON = {
  attention: Sparkles,
  stale: History,
  neutral: CircleDashed,
} as const;

/**
 * Where a line's link goes: the tab the server named, and nowhere it did not.
 * A computation waiting on its budget has no tab — the study page's own
 * budget dialog is where that is confirmed — so it gets no link here.
 */
function attentionTarget(item: VcrAttention): VcrTabKey | null {
  if (!item.action || item.kind === "budget_confirm") return null;
  return item.action.tab ?? item.tab ?? null;
}

/**
 * 需要关注: what the reader has to look at, and nothing else. It is not drawn at all while there is nothing — a card that
 * says 「现在没有需要你处理的事」 is a card explaining its own absence.
 */
function AttentionCard({ items, studyId }: { items: readonly VcrAttention[]; studyId: string }) {
  return (
    <section data-vcr-attention="" className="rounded-card border border-border bg-surface p-4">
      <h2 className="text-section font-semibold text-text">需要关注</h2>
      <ol className="mt-2 divide-y divide-faint">
        {items.map((item, index) => {
          const Icon = TONE_ICON[item.tone ?? "neutral"];
          const target = attentionTarget(item);
          return (
            <li key={`${item.kind}-${index}`} className="py-3">
              <div className="flex items-start gap-2">
                <Icon
                  size={16}
                  aria-hidden="true"
                  className={cn("mt-0.5 shrink-0", item.tone === "attention" ? "text-warn" : "text-text-3")}
                />
                <p className="min-w-0 flex-1 text-ui text-text">{item.text}</p>
                {item.kind === "allowance_waiting" && item.waiting && <AllowanceTopUp waiting={item.waiting} className="shrink-0 text-caption text-link hover:underline" />}
                {item.action && target && (
                  <Link to={vcrTabPath(studyId, target)} className="shrink-0 text-caption text-link hover:underline">
                    {item.action.label}
                  </Link>
                )}
              </div>
              {item.items && item.items.length > 0 && (
                <ul className="ml-6 mt-2 flex flex-wrap gap-1.5">
                  {item.items.map((name) => <li key={name}><Tag>{name}</Tag></li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
