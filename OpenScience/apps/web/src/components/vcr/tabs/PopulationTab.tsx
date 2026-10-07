import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import {
  downloadVcrRecords, editVcrCard, getVcrPopulation,
  type VcrGeneratedRow, type VcrPopulationTab as PopulationData, type VcrQualityReport, type VcrStudy,
} from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Tag } from "@/components/ui/Tag";
import { VcrAttritionChart, VcrFunnelBar, VcrSmdDot } from "../VcrDiagrams";
import { VcrMiniHistogram } from "../VcrMiniHistogram";
import { ReviewChip, SourceTag } from "../VcrMarks";
import { VcrNumber } from "../VcrNumber";
import { VcrSettingsDrawer } from "../VcrSettingsDrawer";
import { PartialResultNote, Stale, VcrStepFailed, VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { VcrDefinitionsSection } from "../VcrKnowledge";
import { useVcrLoad, VcrFacts, VcrHeadline, VcrSection, VcrTabError, VcrToolbar } from "../vcrTabKit";
import { countText, numberText } from "../vcrText";

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
 * Under them, what a population carries with it (plan §5.1): the quality
 * report of a synthetic population, which reports and never judges — values
 * under 保真度 / 可用性 / 泄露风险 and no word like 安全 or 合格. Two versions
 * of a definition are compared once, in 定义库, by the engine on a registered
 * dataset: the page computes no difference between versions, and it keeps no
 * second comparison of what each version stored beside the engine's.
 */
export function PopulationTab({ studyId, study, onStudyChanged }: { studyId: string; study: VcrStudy; onStudyChanged?: () => void }) {
  const { state, reload } = useVcrLoad(`${studyId}:population`, () => getVcrPopulation(studyId));
  const [editing, setEditing] = useState<"population" | "criteria" | null>(null);
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const failed = study.steps.population?.status === "failed";
  const nothing = !data.version && data.criteria.length === 0 && data.attrition.length === 0 && data.profile.length === 0
    && !data.outcome && !data.quality;
  if (nothing) {
    return failed
      ? <VcrStepFailed studyId={studyId} study={study} step="population" partial={data.partial} />
      : <VcrStepPending studyId={studyId} study={study} step="population" />;
  }

  // A generated population (scenario, literature, empirical synthetic) is read as a table of its variables; a real cohort as the
  // rules that selected it and what each did to the count.
  const generated = Boolean(data.method);
  const mayWrite = study.abilities.includes("write");
  const changed = () => { reload(); onStudyChanged?.(); };

  return (
    <div className="flex flex-col gap-6">
      {generated
        ? <GeneratedHeader studyId={studyId} data={data} mayWrite={mayWrite} onEdit={() => setEditing("population")} onChanged={changed} />
        : (
          <VcrToolbar summary={data.version}>
            {data.versions.map((version) => (
              <Tag key={version.id} className={cn(version.stale && "text-text-3")}>
                {version.stale ? `${version.label}（已过期）` : version.label}
              </Tag>
            ))}
          </VcrToolbar>
        )}

      {failed
        ? <VcrStepFailed studyId={studyId} study={study} step="population" partial={data.partial} />
        : data.partial && <PartialResultNote sentence={data.partial.sentence} resume={{ studyId, study, step: "population" }} />}

      <Stale note={data.stale}>
        <div className="flex flex-col gap-6">
          {generated && <GeneratedProfile data={data} />}

          {!generated && data.headline && <VcrHeadline>{data.headline}</VcrHeadline>}

          {!generated && (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)_minmax(0,22rem)]">
            <DefinitionCard data={data} onEdit={mayWrite && data.criteria.length > 0 ? () => setEditing("criteria") : null} />

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
          )}

          {!generated && data.blockers.length > 0 && (
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

          {data.quality && (data.quality.groups.length > 0 || data.quality.trainingRecords != null || data.quality.copies != null) && (
            <div className="grid gap-4 lg:grid-cols-2">
              <QualityCard quality={data.quality} />
            </div>
          )}

        </div>
      </Stale>

      <VcrDefinitionsSection
        studyId={studyId}
        knowledge={data.knowledge}
        canWrite={study.abilities.includes("write")}
        canRun={study.abilities.includes("run")}
        onChanged={() => { reload(); onStudyChanged?.(); }}
      />

      {editing && (
        <VcrSettingsDrawer
          studyId={studyId}
          kind={editing}
          title={editing === "population" ? "改人群设定" : "改入排条件的数值"}
          onClose={() => setEditing(null)}
          onSaved={changed}
        />
      )}
    </div>
  );
}

/**
 * The generated population's header: what it is — 「人群 v1 · 情景人群 · 1,000 条生成记录」 —, what it may be used for, and the three
 * things done with it: download the records, generate it again, change its numbers. A population is a result, and the result comes
 * first: the title says what there is, the buttons say what can be done with it.
 */
function GeneratedHeader({ studyId, data, mayWrite, onEdit, onChanged }: {
  studyId: string;
  data: PopulationData;
  mayWrite: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"download" | "regenerate" | null>(null);
  const records = data.counts?.generatedRecords ?? null;
  const title = [data.version?.replace(/（.*）$/, ""), data.kind, records !== null ? `${numberText(records, 0)} 条生成记录` : null].filter(Boolean).join(" · ");
  const uses = data.allowedUses.map((use) => use.label);

  const download = () => {
    if (busy || !data.download) return;
    setBusy("download");
    void downloadVcrRecords(studyId, data.download.path)
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "记录暂时无法下载，请稍后重试。" })))
      .finally(() => setBusy(null));
  };
  const regenerate = () => {
    if (busy) return;
    setBusy("regenerate");
    void editVcrCard(studyId, { kind: "population", regenerate: true })
      .then(() => { toast.success("已重新生成，结果算好后会显示在这里。"); onChanged(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法重新生成，请稍后重试。" })))
      .finally(() => setBusy(null));
  };

  return (
    <div data-vcr-population-header="" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="min-w-0 text-section font-semibold text-text">{title}</h2>
      {uses.length > 0 && <Tag>{`仅用于${uses.join("、")}`}</Tag>}
      <span className="flex-1" />
      {data.download && (
        <Button variant="secondary" loading={busy === "download"} disabled={busy !== null} onClick={download}>
          <Download size={16} aria-hidden="true" />下载记录（CSV）
        </Button>
      )}
      {mayWrite && (
        <>
          <Button variant="text" onClick={onEdit} disabled={busy !== null}>改设定</Button>
          <Button variant="secondary" loading={busy === "regenerate"} disabled={busy !== null} onClick={regenerate}>
            <RefreshCw size={16} aria-hidden="true" />重新生成
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * What came out, variable by variable, set beside what the study set for it — and, at its side, how it was made and what it may be
 * used for. A generated table with no profile (it was generated before the engine described its own tables) says so in one sentence
 * and offers 「重新生成」; it never shows half a table.
 */
function GeneratedProfile({ data }: { data: PopulationData }) {
  const how = [
    `${data.method}。`,
    ...data.constraints.map((constraint) => `约束“${constraint.label}”${constraint.violations === 0 ? "没有记录违反" : `有 ${numberText(constraint.violations, 0)} 条记录违反`}。`),
  ].join("");
  const uses = data.allowedUses.map((use) => use.label);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      {data.generated.length > 0
        ? (
          <Card>
            <table data-vcr-generated="" className="w-full border-collapse text-ui">
              <caption className="sr-only">每个变量设定的分布和生成的结果</caption>
              <thead>
                <tr className="border-b border-border text-caption text-text-3">
                  <th scope="col" className="py-2 pr-3 text-left font-normal">变量</th>
                  <th scope="col" className="px-3 py-2 text-left font-normal">设定的分布</th>
                  <th scope="col" className="px-3 py-2 text-right font-normal">生成结果</th>
                  <th scope="col" className="py-2 pl-3 text-right font-normal">分布</th>
                </tr>
              </thead>
              <tbody>
                {data.generated.map((row) => <GeneratedRow key={row.key} row={row} />)}
              </tbody>
            </table>
          </Card>
        )
        : (
          <Card>
            <p data-vcr-profile-missing="" className="py-4 text-ui text-text-2">
              {data.profileNote ?? "这个人群还没有画像：重新生成一次，就能看到每个变量的分布。"}
            </p>
          </Card>
        )}
      <div className="flex flex-col gap-4">
        <Card title="怎么生成的"><p className="text-ui text-text-2">{how}</p></Card>
        <Card title="能用来做什么">
          <p className="text-ui text-text-2">
            {uses.length > 0 ? `可用于${uses.join("、")}。` : ""}它不是真实患者，不能当作外部对照或疗效证据。
          </p>
        </Card>
      </div>
    </div>
  );
}

/** One variable: what was set (a distribution, or nothing for a table made from real data), what came out, and its shape. */
function GeneratedRow({ row }: { row: VcrGeneratedRow }) {
  return (
    <tr data-vcr-variable={row.key} className="border-b border-faint align-middle">
      <th scope="row" className="py-2.5 pr-3 text-left font-normal text-text">{row.label}</th>
      <td className="px-3 py-2.5 text-text-2">{row.declared ?? <span className="text-text-3">按真实数据合成，没有设定的分布</span>}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-text">
        {row.result ?? "—"}
        {row.missing && <span className="block text-caption text-text-3">{row.missing}</span>}
      </td>
      <td className="py-2.5 pl-3 text-right">{row.histogram ? <VcrMiniHistogram counts={row.histogram.counts} /> : null}</td>
    </tr>
  );
}

/** The definition: time zero, the evidence window, the exit, and every rule with its three counts. */
function DefinitionCard({ data, onEdit }: { data: PopulationData; onEdit: (() => void) | null }) {
  const facts = data.definition
    ? [
      ...(data.definition.timeZero ? [{ label: "时间零点", value: data.definition.timeZero }] : []),
      ...(data.definition.evidenceWindow ? [{ label: "证据时效", value: data.definition.evidenceWindow }] : []),
      ...(data.definition.exit ? [{ label: "退出", value: data.definition.exit }] : []),
    ]
    : [];
  return (
    <Card
      header={(
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-section font-semibold text-text">定义</h2>
          {onEdit && <Button size="sm" variant="text" onClick={onEdit}>改数值</Button>}
        </div>
      )}
    >
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
