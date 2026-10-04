import { getVcrPopulation, type VcrCountKey, type VcrPopulationTab as PopulationData, type VcrQualityReport, type VcrStudy } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";
import { Tag } from "@/components/ui/Tag";
import { VcrCountsBand } from "../VcrCounts";
import { VcrAttritionChart, VcrFunnelBar, VcrSmdDot } from "../VcrDiagrams";
import { ReviewChip, SourceTag } from "../VcrMarks";
import { VcrNumber } from "../VcrNumber";
import { PartialResultNote, Stale, VcrStepFailed, VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { VcrDefinitionsSection } from "../VcrKnowledge";
import { useVcrLoad, VcrFacts, VcrHeadline, VcrSection, VcrTabError, VcrToolbar } from "../vcrTabKit";
import { countLabel, countText, numberText } from "../vcrText";

/**
 * 人群: what the study means by "these patients", how many survive each rule,
 * and how the survivors compare with the comparator's population.
 *
 * Three counts per rule, never one: **kept, excluded and undecidable are three
 * different facts**, and a platform that folds the third into the second
 * reports a cleaner cohort than it has. The right-hand column exists to
 * answer the question the middle one raises — *why* 612 people cannot be
 * judged — because that list is what turns into a request for evidence.
 *
 * Under them, the two things a population carries with it (plan §5.1): the
 * quality report of a synthetic population, which reports and never judges —
 * values under 保真度 / 可用性 / 泄露风险 and no word like 安全 or 合格 — and
 * two versions side by side, as each stored them. The page computes no
 * difference between the versions: a standardized difference is the
 * engine's number to send, not the browser's to make up.
 */
export function PopulationTab({ studyId, study, onStudyChanged }: { studyId: string; study: VcrStudy; onStudyChanged?: () => void }) {
  const { state, reload } = useVcrLoad(`${studyId}:population`, () => getVcrPopulation(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const failed = study.steps.population?.status === "failed";
  const nothing = !data.version && data.criteria.length === 0 && data.attrition.length === 0 && data.profile.length === 0
    && !data.outcome && !data.quality && !data.versionCompare;
  if (nothing) {
    return failed
      ? <VcrStepFailed studyId={studyId} study={study} step="population" partial={data.partial} />
      : <VcrStepPending studyId={studyId} study={study} step="population" />;
  }

  return (
    <div className="flex flex-col gap-6">
      <VcrToolbar summary={data.version}>
        {data.versions.map((version) => (
          <Tag key={version.id} className={cn(version.stale && "text-text-3")}>
            {version.stale ? `${version.label}（已过期）` : version.label}
          </Tag>
        ))}
      </VcrToolbar>

      {failed
        ? <VcrStepFailed studyId={studyId} study={study} step="population" partial={data.partial} />
        : data.partial && <PartialResultNote done={data.partial.done} missing={data.partial.missing} />}

      <Stale note={data.stale}>
        <div className="flex flex-col gap-6">
          {data.headline && <VcrHeadline>{data.headline}</VcrHeadline>}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)_minmax(0,22rem)]">
            <DefinitionCard data={data} />

            <Card title="逐条筛选">
              <VcrAttritionChart steps={data.attrition} />
              {data.outcome && (
                <div className="mt-4 border-t border-border pt-3">
                  <VcrFunnelBar
                    eligible={data.outcome.eligible}
                    insufficient={data.outcome.insufficient}
                    ineligible={data.outcome.ineligible}
                  />
                  <p data-vcr-outcome="" className="mt-2 flex flex-wrap gap-x-6 text-ui tabular-nums text-text">
                    <span><span className="font-semibold">{numberText(data.outcome.eligible, 0)}</span> 符合</span>
                    <span><span className="font-semibold text-warn-strong">{numberText(data.outcome.insufficient, 0)}</span> 可能符合</span>
                    <span className="text-text-3"><span className="font-semibold">{numberText(data.outcome.ineligible, 0)}</span> 不符合</span>
                  </p>
                </div>
              )}
            </Card>

            <div className="flex flex-col gap-4">
              {data.profile.length > 0 && <ProfileCard data={data} />}

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

          {(data.quality || data.versionCompare) && (
            <div className="grid gap-4 lg:grid-cols-2">
              {data.quality && <QualityCard quality={data.quality} />}
              {data.versionCompare && <VersionCompareCard compare={data.versionCompare} />}
            </div>
          )}

          <VcrCountsBand counts={data.counts} />
        </div>
      </Stale>

      <VcrDefinitionsSection
        studyId={studyId}
        knowledge={data.knowledge}
        canWrite={study.abilities.includes("write")}
        canRun={study.abilities.includes("run")}
        onChanged={() => { reload(); onStudyChanged?.(); }}
      />
    </div>
  );
}

/** The definition: time zero, the evidence window, the exit, and every rule with its three counts. */
function DefinitionCard({ data }: { data: PopulationData }) {
  const facts = data.definition
    ? [
      ...(data.definition.timeZero ? [{ label: "时间零点", value: data.definition.timeZero }] : []),
      ...(data.definition.evidenceWindow ? [{ label: "证据时效", value: data.definition.evidenceWindow }] : []),
      ...(data.definition.exit ? [{ label: "退出", value: data.definition.exit }] : []),
    ]
    : [];
  return (
    <Card title="定义">
      {facts.length > 0 && <VcrFacts rows={facts} />}
      {data.criteria.length > 0 && (
        <>
          <p className="mt-3 flex justify-end gap-2 text-meta text-text-3">
            <span>保留</span><span className="w-10 text-right">排除</span><span className="w-10 text-right">无法判断</span>
          </p>
          <ul className="mt-1 flex flex-col gap-2">
            {data.criteria.map((criterion) => (
              <li key={criterion.id} data-vcr-rule={criterion.code} className="rounded border border-border p-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="w-6 shrink-0 text-caption tabular-nums text-text-3">{criterion.code}</span>
                  <span className="min-w-0 flex-1 text-ui text-text">{criterion.name}</span>
                  <span className="flex shrink-0 items-baseline gap-2">
                    <span data-vcr-rule-kept="" className="text-caption tabular-nums text-text-2">{numberText(criterion.kept, 0)}</span>
                    <span data-vcr-rule-excluded="" className="w-10 text-right text-caption tabular-nums text-text-3">{numberText(criterion.excluded, 0)}</span>
                    <span
                      data-vcr-rule-unknown=""
                      className={cn("w-10 text-right text-caption tabular-nums", (criterion.unknown ?? 0) > 0 ? "font-medium text-warn-strong" : "text-text-3")}
                    >
                      {numberText(criterion.unknown, 0)}
                    </span>
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
        </>
      )}
    </Card>
  );
}

/** Ours against the comparator's population, row by row, with the balance floor drawn. */
function ProfileCard({ data }: { data: PopulationData }) {
  return (
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
            <tr key={row.key} data-vcr-profile={row.key} className={cn("border-b border-faint", row.flagged && "bg-warn-soft")}>
              <th scope="row" className="py-1.5 pr-2 text-left font-normal text-text">{row.label}</th>
              <td className="py-1.5 px-2 text-right tabular-nums text-text"><VcrNumber value={row.ours} label={`本人群 ${row.label}`} /></td>
              <td className="py-1.5 px-2 text-right tabular-nums text-text-2"><VcrNumber value={row.theirs} label={`对照 ${row.label}`} /></td>
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
  );
}

/**
 * 质量报告: the synthetic population's fixed metric set — fidelity, utility and
 * leakage risk — as values, with the generator's training-record count and
 * the number of copies it made (plan §5.1). It reports; it never says 安全,
 * 匿名 or 合格, because none of those is a number this report can hold.
 */
function QualityCard({ quality }: { quality: VcrQualityReport }) {
  const counts = [
    quality.trainingRecords != null ? `训练记录 ${countText(quality.trainingRecords)} 条` : null,
    quality.copies != null ? `合成 ${countText(quality.copies)} 份` : null,
  ].filter(Boolean);
  return (
    <Card
      header={(
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-ui font-semibold text-text">质量报告</h2>
          {quality.tag && <Tag>{quality.tag}</Tag>}
        </div>
      )}
    >
      <div data-vcr-quality="" className="grid gap-4 sm:grid-cols-3">
        {quality.groups.map((group) => (
          <section key={group.key} data-vcr-quality-group={group.key}>
            <h3 className="text-caption text-text-3">{group.label}</h3>
            <dl className="mt-1.5 flex flex-col gap-1.5">
              {group.rows.map((row) => (
                <div key={row.key} className="flex items-baseline justify-between gap-2">
                  <dt className="min-w-0 text-caption text-text-2">{row.label}</dt>
                  <dd className="shrink-0 text-ui tabular-nums text-text"><VcrNumber value={row.value} label={row.label} /></dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      {counts.length > 0 && <p className="mt-3 text-caption tabular-nums text-text-3">{counts.join(" · ")}</p>}
    </Card>
  );
}

const COUNT_KEYS: readonly VcrCountKey[] = Object.freeze([
  "realPatients", "events", "effectiveSampleSize", "generatedRecords", "priorEffectiveSampleSize", "reconstructedPseudoPatients",
]);

/**
 * Two versions side by side: their counts, then their composition where both
 * versions stored the row. A row only one side has is not a comparison, so it
 * is left out rather than drawn against a dash.
 */
function VersionCompareCard({ compare }: { compare: NonNullable<PopulationData["versionCompare"]> }) {
  const { left, right } = compare;
  const counted = COUNT_KEYS.filter((key) => typeof left.counts?.[key] === "number" || typeof right.counts?.[key] === "number");
  const rows = compare.rows.filter((row) => row.left && row.right);
  return (
    <Card title="版本对比">
      <table data-vcr-version-compare="" className="w-full border-collapse text-caption">
        <caption className="sr-only">{`${left.label} 与 ${right.label}`}</caption>
        <thead>
          <tr className="border-b border-border text-text-3">
            <th scope="col" className="py-1 pr-2 text-left font-normal"><span className="sr-only">项目</span></th>
            {[left, right].map((side, index) => (
              <th key={index} scope="col" className="py-1 pl-2 text-right font-normal">
                <span className="block text-text-2">{side.label}</span>
                {side.at && <span className="block text-meta">{side.at}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {counted.map((key) => (
            <tr key={key} data-vcr-version-count={key} className="border-b border-faint">
              <th scope="row" className="py-1.5 pr-2 text-left font-normal text-text-2">{countLabel(key)}</th>
              <td className="py-1.5 pl-2 text-right tabular-nums text-text">{countText(left.counts?.[key] ?? null)}</td>
              <td className="py-1.5 pl-2 text-right tabular-nums text-text">{countText(right.counts?.[key] ?? null)}</td>
            </tr>
          ))}
          {rows.map((row) => (
            <tr key={row.key} data-vcr-version-row={row.key} className="border-b border-faint">
              <th scope="row" className="py-1.5 pr-2 text-left font-normal text-text-2">{row.label}</th>
              <td className="py-1.5 pl-2 text-right tabular-nums text-text"><VcrNumber value={row.left} label={`${left.label} ${row.label}`} /></td>
              <td className="py-1.5 pl-2 text-right tabular-nums text-text"><VcrNumber value={row.right} label={`${right.label} ${row.label}`} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
