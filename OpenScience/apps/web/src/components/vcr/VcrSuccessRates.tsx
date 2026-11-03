import { useState } from "react";
import type { VcrSuccessRate, VcrSuccessRateFigure, VcrSuccessRates } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { Disclosure } from "@/components/ui/Disclosure";
import { Select } from "@/components/ui/Input";
import { BlockHeading } from "@/components/ui/Section";
import { numberText } from "./vcrText";

type Source = VcrSuccessRates["sources"][number];

/** What each figure counts to, in the order a development runs. */
const FIGURES: ReadonlyArray<readonly [VcrSuccessRateFigure, string]> = [
  ["toNext", "进入下一期"],
  ["toFiling", "到提交申报"],
  ["toApproval", "到获批"],
];
/** What the number under a figure counts, which each source counts differently. */
const COUNTED: Readonly<Record<Source["key"], string>> = { bio: "次阶段转换", wong: "条研发路径" };
const NOT_IN_SOURCE = "这个来源没有这一栏";
const DEFAULT_PHASE = "phase3";
const DEFAULT_AREA = "all";

function Figure({ label, rate, counted }: { label: string; rate: VcrSuccessRate | null; counted: string }) {
  return (
    <div data-vcr-success-figure={label} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-faint py-2 last:border-b-0">
      <dt className="text-ui text-text-2">{label}</dt>
      <dd className="text-ui tabular-nums text-text">
        {rate
          ? (
            <>
              <span data-vcr-success-rate="">{rate.text}</span>
              {rate.n != null && <span data-vcr-success-n="" className="ml-2 text-meta font-normal text-text-3">{`基于 ${numberText(rate.n, 0)} ${counted}`}</span>}
            </>
          )
          : <span data-vcr-success-missing="" className="text-text-3">{NOT_IN_SOURCE}</span>}
      </dd>
    </div>
  );
}

/**
 * The historical success rates of a development phase, beside the assurance a design computed: what share of past programmes got through
 * the phase. Each source has its own column because the two count differently (to the filing or to the approval, by transition or by
 * path); a figure a source does not have is said to be missing and is never taken from the other. It is a reference, never this trial's
 * probability, and the page does not pick a figure.
 */
export function VcrSuccessRates({ rates }: { rates: VcrSuccessRates | null | undefined }) {
  const [phase, setPhase] = useState(DEFAULT_PHASE);
  const [area, setArea] = useState(DEFAULT_AREA);
  if (!rates) return null;
  // A choice the payload does not offer falls back to the default, and to the first when the default is not offered either.
  const phaseId = rates.phases.some((entry) => entry.id === phase) ? phase : (rates.phases.find((entry) => entry.id === DEFAULT_PHASE) ?? rates.phases[0]).id;
  const chosen = rates.areas.find((entry) => entry.id === area) ?? rates.areas.find((entry) => entry.id === DEFAULT_AREA) ?? rates.areas[0];
  const block = chosen.phases[phaseId] ?? null;
  const figuresOf = (source: Source) => block?.[source.key] ?? null;
  // The rows are the figures some source has; a source that lacks one says so in its own column.
  const shown = FIGURES.filter(([figure]) => rates.sources.some((source) => figuresOf(source)?.[figure]));
  return (
    <div data-vcr-success-rates="" className="min-w-0">
      <ChartCard title={rates.title}>
        <div className="flex flex-col gap-4">
          {rates.note && <p data-vcr-success-note="" className="text-caption text-text-3">{rates.note}</p>}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select label="阶段" value={phaseId} onChange={(event) => setPhase(event.target.value)}>
              {rates.phases.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </Select>
            <Select label="适应症" value={chosen.id} onChange={(event) => setArea(event.target.value)}>
              {rates.areas.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {rates.sources.map((source) => {
              const figures = figuresOf(source);
              return (
                <div key={source.id} data-vcr-success-source={source.key} className="flex min-w-0 flex-col gap-2">
                  <BlockHeading className="text-ui font-semibold text-text">{source.label}</BlockHeading>
                  {source.key === "wong" && chosen.wongGroup && chosen.wongGroup !== chosen.label && (
                    <p data-vcr-success-group="" className="text-caption text-text-3">{`该来源按“${chosen.wongGroup}”统计`}</p>
                  )}
                  {figures && shown.length > 0
                    ? (
                      <dl>
                        {shown.map(([figure, label]) => <Figure key={figure} label={label} rate={figures[figure] ?? null} counted={COUNTED[source.key]} />)}
                      </dl>
                    )
                    : <p data-vcr-success-missing="" className="py-2 text-ui text-text-3">{NOT_IN_SOURCE}</p>}
                  {(source.endpoint || source.method) && (
                    <Disclosure summary="怎么统计的">
                      <div data-vcr-success-method="" className="flex flex-col gap-1 text-caption text-text-3">
                        {source.endpoint && <p>{source.endpoint}</p>}
                        {source.method && <p>{source.method}</p>}
                      </div>
                    </Disclosure>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </ChartCard>
    </div>
  );
}
