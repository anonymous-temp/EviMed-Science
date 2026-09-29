import { getVcrPopulation, type VcrStudy } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";
import { Tag } from "@/components/ui/Tag";
import { VcrCountsBand } from "../VcrCounts";
import { VcrAttritionChart, VcrFunnelBar, VcrSmdDot } from "../VcrDiagrams";
import { ReviewChip, SourceTag } from "../VcrMarks";
import { VcrValueText } from "../VcrNumber";
import { Stale, VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useVcrLoad, VcrFacts, VcrHeadline, VcrSection, VcrTabError, VcrToolbar } from "../vcrTabKit";
import { numberText } from "../vcrText";

/**
 * 人群: what the study means by "these patients", how many survive each rule,
 * and how the survivors compare with the comparator's population.
 *
 * Three counts per rule, never one: **kept, excluded and undecidable are three
 * different facts**, and a platform that folds the third into the second
 * reports a cleaner cohort than it has. The whole right-hand column exists to
 * answer the question the middle one raises — *why* 612 people cannot be
 * judged — because that list is what turns into a request for evidence.
 */
export function PopulationTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { state, reload } = useVcrLoad(`${studyId}:population`, () => getVcrPopulation(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const nothing = data.criteria.length === 0 && data.attrition.length === 0 && data.profile.length === 0;
  if (nothing) return <VcrStepPending studyId={studyId} study={study} step="population" />;

  return (
    <div className="flex flex-col gap-6">
      <VcrToolbar summary={data.version}>
        {data.versions?.map((version) => (
          <Tag key={version.id} className={cn(version.stale && "text-text-3")}>
            {version.stale ? `${version.label}（已过期）` : version.label}
          </Tag>
        ))}
      </VcrToolbar>

      {data.headline && <VcrHeadline>{data.headline}</VcrHeadline>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)_minmax(0,22rem)]">
        <Card title="定义">
          {data.definition && (
            <VcrFacts
              rows={[
                ...(data.definition.timeZero ? [{ label: "时间零点", value: data.definition.timeZero }] : []),
                ...(data.definition.evidenceWindow ? [{ label: "证据时效", value: data.definition.evidenceWindow }] : []),
                ...(data.definition.exit ? [{ label: "退出", value: data.definition.exit }] : []),
              ]}
            />
          )}
          <ul className="mt-3 flex flex-col gap-2">
            {data.criteria.map((criterion) => (
              <li key={criterion.id} className="rounded border border-border p-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="w-6 shrink-0 text-caption tabular-nums text-text-3">{criterion.code}</span>
                  <span className="min-w-0 flex-1 text-ui text-text">{criterion.name}</span>
                  <span className="shrink-0 text-caption tabular-nums text-text-2">{numberText(criterion.kept, 0)}</span>
                  <span className="w-10 shrink-0 text-right text-caption tabular-nums text-text-3">{numberText(criterion.excluded, 0)}</span>
                  <span className={cn("w-10 shrink-0 text-right text-caption tabular-nums", (criterion.unknown ?? 0) > 0 ? "font-medium text-warn-strong" : "text-text-3")}>
                    {numberText(criterion.unknown, 0)}
                  </span>
                </div>
                {criterion.quote && (
                  <p className="ml-8 mt-1 text-caption text-text-3">{`“${criterion.quote}”`}</p>
                )}
                {(criterion.source || criterion.review || criterion.changed) && (
                  <p className="ml-8 mt-1.5 flex flex-wrap items-center gap-1.5">
                    {criterion.changed && <Tag>{criterion.changed}</Tag>}
                    {criterion.source && <SourceTag source={criterion.source} />}
                    <ReviewChip state={criterion.review} />
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p aria-hidden="true" className="mt-2 flex justify-end gap-2 text-meta text-text-3">
            <span>保留</span><span>排除</span><span>无法判断</span>
          </p>
        </Card>

        <Card title="逐条筛选">
          <Stale stale={data.versions?.some((version) => version.stale && version.label === data.version) ?? false}>
            <VcrAttritionChart steps={data.attrition} />
          </Stale>
          {data.outcome && (
            <div className="mt-4 border-t border-border pt-3">
              <VcrFunnelBar
                eligible={data.outcome.eligible}
                insufficient={data.outcome.insufficient}
                ineligible={data.outcome.ineligible}
              />
              <p className="mt-2 flex flex-wrap gap-x-6 text-ui tabular-nums text-text">
                <span><span className="font-semibold">{numberText(data.outcome.eligible, 0)}</span> 符合</span>
                <span><span className="font-semibold text-warn-strong">{numberText(data.outcome.insufficient, 0)}</span> 可能符合</span>
                <span className="text-text-3"><span className="font-semibold">{numberText(data.outcome.ineligible, 0)}</span> 不符合</span>
              </p>
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="人群画像">
            <table className="w-full border-collapse text-caption">
              <caption className="sr-only">本人群与对照人群的基线比较</caption>
              <thead>
                <tr className="border-b border-border text-text-3">
                  <th scope="col" className="py-1 pr-2 text-left font-normal">特征</th>
                  <th scope="col" className="py-1 px-2 text-right font-normal">本人群</th>
                  <th scope="col" className="py-1 px-2 text-right font-normal">对照</th>
                  <th scope="col" className="py-1 pl-2 text-right font-normal">|SMD|</th>
                  <th scope="col" className="w-20 py-1 pl-2 font-normal"><span className="sr-only">界值 0.1</span></th>
                </tr>
              </thead>
              <tbody>
                {data.profile.map((row) => (
                  <tr key={row.key} className={cn("border-b border-faint", row.flagged && "bg-warn-soft")}>
                    <th scope="row" className="py-1.5 pr-2 text-left font-normal text-text">{row.label}</th>
                    <td className="py-1.5 px-2 text-right tabular-nums text-text"><VcrValueText value={row.ours} /></td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-text-2"><VcrValueText value={row.theirs} /></td>
                    <td className={cn("py-1.5 pl-2 text-right tabular-nums", row.flagged ? "font-medium text-warn-strong" : "text-text-2")}>
                      {row.smd != null ? row.smd.toFixed(2) : "—"}
                    </td>
                    <td className="py-1.5 pl-2"><VcrSmdDot smd={row.smd} label={row.label} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.profileNote && <p className="mt-2 text-caption text-text-3">{data.profileNote}</p>}
          </Card>

          {data.unknownReasons.length > 0 && (
            <Card title="无法判断的原因">
              <ul className="flex flex-col gap-2.5">
                {data.unknownReasons.map((reason) => (
                  <li key={reason.key} className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui text-text">{reason.label}</span>
                      {reason.detail && <span className="block truncate text-caption text-text-3">{reason.detail}</span>}
                    </span>
                    <span className="shrink-0 text-ui tabular-nums text-text">{numberText(reason.count, 0)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {data.blockers.length > 0 && (
        <VcrSection title="最卡人的三条">
          <ul className="flex flex-col gap-2">
            {data.blockers.map((blocker) => (
              <li key={blocker.code} className="flex items-baseline gap-3 text-ui">
                <span className="w-8 shrink-0 tabular-nums text-text-3">{blocker.code}</span>
                <span className="min-w-0 flex-1 text-text">{blocker.label}</span>
                <span className={cn("shrink-0 tabular-nums", blocker.tone === "attention" ? "font-medium text-warn-strong" : "text-text-2")}>
                  {blocker.text}
                </span>
              </li>
            ))}
          </ul>
        </VcrSection>
      )}

      <VcrCountsBand counts={data.counts} />
    </div>
  );
}
