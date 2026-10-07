import { CircleCheck, CircleDashed } from "lucide-react";
import { getVcrPatients, type VcrModelCard, type VcrPatientsTab as PatientsData, type VcrStudy } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";
import { ChartCard } from "@/components/ui/ChartCard";
import { Tag } from "@/components/ui/Tag";
import { VcrSeriesLegend, VcrTrajectoryChart } from "../VcrCharts";
import { VcrTornadoChart } from "../VcrDiagrams";
import { SourceTag } from "../VcrMarks";
import { VcrModelAssessments } from "../VcrModelAssessments";
import { VcrNumber } from "../VcrNumber";
import { NotApplicableCard, PartialResultNote, Stale, VcrStepFailed, VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useVcrLoad, VcrHeadline, VcrTabError, VcrToolbar } from "../vcrTabKit";
import { intervalText, modelTierLabel, intendedUseLabel } from "../vcrText";

/**
 * What two scenarios of one virtual patient are, said every time they are
 * drawn (plan §5.2): the same random numbers under two assumptions, and an
 * individual whose two outcomes nobody could ever observe together. It is a
 * constant on purpose — a sentence the server might forget to send is not
 * one the page may drop.
 */
export const VCR_COUNTERFACTUAL_SENTENCE = "同一虚拟患者在两种假设下的推演，个体的两个结局不可能同时被观察到。";

/**
 * 虚拟患者: what this kind of patient might do, under a named model and a
 * stated scenario — and never a claim about anybody real.
 *
 * Three things on this page are load-bearing.
 *
 *  - The model's chip carries its credibility tier and **the highest intended
 *    use it can carry** (plan §8.2): a literature model's output may support
 *    a design and may not support a submission.
 *  - Beside it, the label its output has **earned** — 「基线条件化预测」 until
 *    the model shows individual conditioning, updating, calibration and
 *    validation, and never 「数字孪生」 because the page would like it to be.
 *    The label is the server's; the page only prints it.
 *  - The tornado's reference line is the model's own base case, sent with the
 *    result. Without one there is no line, and no 「基准」 at all.
 */
export function PatientsTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { state, reload } = useVcrLoad(`${studyId}:patients`, () => getVcrPatients(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const failed = study.steps.patients?.status === "failed";
  const nothing = !data.model && !data.trajectories && !data.example && data.panels.length === 0 && !data.sensitivity
    && data.assessments.records.length === 0;
  if (nothing) {
    return failed
      ? <VcrStepFailed studyId={studyId} study={study} step="patients" partial={data.partial} />
      : <VcrStepPending studyId={studyId} study={study} step="patients" />;
  }
  const twin = data.twin ?? (data.model?.twinLabel ? { label: data.model.twinLabel, reason: data.model.twinReason ?? null } : null);

  return (
    <div className="flex flex-col gap-6">
      {failed
        ? <VcrStepFailed studyId={studyId} study={study} step="patients" partial={data.partial} />
        : data.partial && <PartialResultNote sentence={data.partial.sentence} resume={{ studyId, study, step: "patients" }} />}

      <Stale note={data.stale}>
        <div className="flex flex-col gap-6">
          {data.headline && <VcrHeadline>{data.headline}</VcrHeadline>}

          {(data.trajectories || data.example) && (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
              {data.trajectories && (
                <ChartCard
                  title="两种情景下的推演，以及个体之间的差异"
                  legend={<VcrSeriesLegend series={data.trajectories.series} />}
                  footnote={data.trajectories.series.some((series) => (series.individuals ?? []).length > 0)
                    ? "细线是个体轨迹，不是观察记录。"
                    : undefined}
                >
                  <VcrTrajectoryChart
                    series={data.trajectories.series}
                    xLabels={data.trajectories.ticks}
                    xLabel={data.trajectories.xLabel}
                    yLabel={data.trajectories.yLabel}
                  />
                </ChartCard>
              )}

              {data.example && <ExampleCard example={data.example} />}
            </div>
          )}

          {(data.panels.length > 0 || (data.sensitivity && data.sensitivity.rows.length > 0)) && (
            <div className="grid gap-4 lg:grid-cols-3">
              {data.panels.map((panel) => (
                <Card key={panel.key} title={panel.title}>
                  {panel.note && <p className="mb-3"><Tag>{panel.note}</Tag></p>}
                  {panel.rows && panel.rows.length > 0 && (
                    <ul className="flex flex-col gap-2.5">
                      {panel.rows.map((row) => (
                        <li key={row.label} data-vcr-panel-row={row.label}>
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="text-ui text-text-2">{row.label}</span>
                            <span className="text-ui font-medium tabular-nums text-text"><VcrNumber value={row.value} label={`${panel.title} ${row.label}`} /></span>
                          </div>
                          {row.value.interval && (
                            <p className="text-right text-caption tabular-nums text-text-3">{intervalText(row.value.interval, row.value.precision)}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {panel.series && panel.series.length > 0 && (
                    <>
                      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1"><VcrSeriesLegend series={panel.series} /></div>
                      <VcrTrajectoryChart series={panel.series} height={150} />
                    </>
                  )}
                  {panel.footnote && <p className="mt-2 text-caption text-text-3">{panel.footnote}</p>}
                </Card>
              ))}

              {data.sensitivity && data.sensitivity.rows.length > 0 && (
                <Card title="哪些假设影响最大">
                  {data.sensitivity.measure && <p className="mb-3 text-caption text-text-3">{data.sensitivity.measure}</p>}
                  <VcrTornadoChart
                    rows={data.sensitivity.rows}
                    centre={data.sensitivity.base?.value ?? null}
                    centreLabel={data.sensitivity.base ? <VcrNumber value={data.sensitivity.base} label="基准" /> : undefined}
                  />
                </Card>
              )}
            </div>
          )}

          {!data.model && (
            <NotApplicableCard
              title="还没有选定模型"
              reason="没有声明适用范围的模型，就没有能承载预期用途的推演。"
              options={["换一个适用范围覆盖本人群的模型", "先用文献模型或情景模型，并把结论标到对应用途", "提一个数据需求，用授权数据拟合"]}
            />
          )}

        </div>
      </Stale>

      {/* The result is above; what it was made with — the model, the sets it was made for and the model's assessment — follows it. */}
      {data.sets && data.sets.length > 0 && (
        <VcrToolbar>
          {data.sets.map((set) => (
            <Tag key={set.id} className={cn(set.stale && "text-text-3")}>{set.stale ? `${set.label}（已过期）` : set.label}</Tag>
          ))}
        </VcrToolbar>
      )}
      {data.model && <ModelChipRow model={data.model} twin={twin} />}
      <VcrModelAssessments studyId={studyId} assessments={data.assessments} canEdit={study.abilities.includes("manage_study")} onSaved={reload} />
    </div>
  );
}

/** One virtual patient: its baseline with where each value came from, and the same patient under two assumptions. */
function ExampleCard({ example }: { example: NonNullable<PatientsData["example"]> }) {
  const scenarios = example.scenarios && example.scenarios.series.length > 0 ? example.scenarios : null;
  // The server's own note is printed unless it is the sentence the page
  // already prints under the two scenarios.
  const note = example.note && !(scenarios && example.note.trim() === VCR_COUNTERFACTUAL_SENTENCE) ? example.note : null;
  return (
    <Card
      header={(
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-section font-semibold text-text">{example.id}</h2>
          <SourceTag source={example.source} />
        </div>
      )}
    >
      {example.origin && <p className="text-caption text-text-3">{example.origin}</p>}
      {example.baseline.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
          {example.baseline.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-2 border-b border-faint pb-1.5">
              <dt className="shrink-0 text-caption text-text-3">{row.label}</dt>
              <dd className="flex min-w-0 items-baseline gap-1.5 text-ui tabular-nums text-text">
                {row.value}
                <SourceTag source={row.source} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {example.inScope && (
        <p className={cn("mt-3 flex items-center gap-1.5 text-caption", example.inScope.ok ? "text-ok" : "text-warn-strong")}>
          {example.inScope.ok ? <CircleCheck size={16} aria-hidden="true" /> : <CircleDashed size={16} aria-hidden="true" />}
          {example.inScope.text}
        </p>
      )}
      {scenarios && (
        <div data-vcr-scenarios="" className="mt-4 rounded-card border border-border bg-surface-1 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-ui font-medium text-text">{scenarios.note ?? "同一组随机数，两种假设"}</p>
            {scenarios.difference && <p className="text-caption tabular-nums text-text-3">{scenarios.difference}</p>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1"><VcrSeriesLegend series={scenarios.series} /></div>
          <VcrTrajectoryChart series={scenarios.series} height={160} />
          <p data-vcr-counterfactual="" className="mt-2 text-caption text-text-2">{VCR_COUNTERFACTUAL_SENTENCE}</p>
        </div>
      )}
      {note && <p className="mt-3 text-caption text-text-3">{note}</p>}
    </Card>
  );
}

/**
 * The model's line above the charts: which model, what it covers, the label
 * its output has earned, and how far that output may be carried.
 */
function ModelChipRow({ model, twin }: { model: VcrModelCard; twin: PatientsData["twin"] }) {
  return (
    <div data-vcr-model="" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-border bg-surface px-4 py-2.5">
      <span className="flex items-center gap-2 text-ui font-medium text-text">
        <Tag tone="accent">{modelTierLabel(model.tier)}</Tag>
        {model.name}
      </span>
      {twin && (
        <span data-vcr-twin="">
          <Tag title={twin.reason ?? undefined}>{twin.label}</Tag>
        </span>
      )}
      {model.scope && <span className="min-w-0 flex-1 truncate text-caption text-text-3">{model.scope}</span>}
      <span className="shrink-0 text-caption text-text-2">
        预期用途上限
        <span className="ml-1.5 font-medium text-text">{intendedUseLabel(model.useCeiling)}</span>
      </span>
    </div>
  );
}
