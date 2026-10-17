import { useState } from "react";
import { CircleCheck, Download, TriangleAlert } from "lucide-react";
import {
  downloadVcrRecords, editVcrCard, getVcrPopulation,
  type VcrGeneratedRow, type VcrPopulationTab as PopulationData, type VcrProfileRow, type VcrQualityReport, type VcrStudy,
} from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { ChartCard } from "@/components/ui/ChartCard";
import { ChartGrid, type ChartGridCell } from "@/components/ui/ChartGrid";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Headline } from "@/components/ui/Headline";
import { BlockHeading, Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { VcrAttritionChart, VcrFunnelBar, VcrSmdDot } from "../VcrDiagrams";
import { VcrMiniHistogram } from "../VcrMiniHistogram";
import { SourceTag } from "../VcrMarks";
import { VcrNumber } from "../VcrNumber";
import { VcrSettingsDrawer } from "../VcrSettingsDrawer";
import { PartialResultNote, Stale, VcrStepFailed, VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { VcrDefinitionsSection } from "../VcrKnowledge";
import { VcrToolbarActions, type VcrToolbarAction } from "../VcrToolbarActions";
import { DistributionGrid } from "../patients/DistributionGrid";
import { boundsText, limitState } from "../patients/distribution";
import { PatientTable } from "../patients/PatientTable";
import { variableLabels } from "../patients/patientFilters";
import { useVcrToolbar } from "../studyFrameContext";
import { useVcrLoad, VcrTabError } from "../vcrTabKit";
import { countText, numberText } from "../vcrText";

/** The id the records table has on the page, so the headline's count can take the reader to it. */
const RECORDS_ID = "vcr-population-records";

/**
 * 人群: what the study means by "these patients" — and, for a population the engine generated, who they came out as.
 *
 * Two kinds of population share the tab, and each is one thing to look at (R19, plan §5.3; audit B §4.4):
 *
 *  - **A generated population** (a scenario, the literature, a synthetic copy of a real table) is a table of its variables: what the
 *    study set for each, what came out, its shape, and — in the row, as a mark — whether every record kept inside the limits the
 *    variable declared (✓ 限定 18–90 / ⚠ 违反 12 条). Under it the same shapes as small multiples against the declaration, and the
 *    first rows of the records themselves.
 *  - **A real cohort** is the rules that selected it and what each did to the count: kept, excluded and undecidable are three
 *    different facts, and a platform that folds the third into the second reports a cleaner cohort than it has. The list of why
 *    people cannot be judged is what turns into a request for evidence.
 *
 * Hidden knowledge:
 *  - **The controls are the band's.** Download, change the settings and generate again are the tab's toolbar (`useVcrToolbar`),
 *    above the content, and a reader who may not write is not offered what would be refused.
 *  - **How it was made and what it may be used for are not on the page.** The two cards that said so (and the grey line over them)
 *    are gone: the limits are enforced where the population is used (the comparator step, the export), the constraint a variable
 *    declared is a mark in its row, and the method is in the export and the operator's record.
 *  - **A population with no profile is described from its stored table by the server**; the page never asks for a regeneration to
 *    see one, and a table the server cannot read draws no half of one.
 *  - Under them, what a population carries with it (plan §5.1): the quality report of a synthetic population, which reports and
 *    never judges — values under 保真度 / 可用性 / 泄露风险 and no word like 安全 or 合格. Two versions of a definition are compared
 *    once, in 定义库, by the engine on a registered dataset: the page computes no difference between versions.
 */
export function PopulationTab({ studyId, study, onStudyChanged }: { studyId: string; study: VcrStudy; onStudyChanged?: () => void }) {
  const { state, reload } = useVcrLoad(`${studyId}:population`, () => getVcrPopulation(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  return <PopulationView studyId={studyId} study={study} data={state.data} reload={reload} onStudyChanged={onStudyChanged} />;
}

/** A population the engine generated: the server gave it a profile of its table, or the records it can be read from. */
export const isGenerated = (data: Pick<PopulationData, "profileKind" | "records" | "generated" | "download">): boolean =>
  data.profileKind === "generated" || data.records != null || data.generated.length > 0 || data.download != null;

function PopulationView({ studyId, study, data, reload, onStudyChanged }: {
  studyId: string;
  study: VcrStudy;
  data: PopulationData;
  reload: () => void;
  onStudyChanged?: () => void;
}) {
  const [editing, setEditing] = useState<"population" | "criteria" | null>(null);
  const [busy, setBusy] = useState<"download" | "regenerate" | null>(null);
  const failed = study.steps.population?.status === "failed";
  const nothing = !data.version && data.criteria.length === 0 && data.attrition.length === 0 && data.profile.length === 0
    && data.generated.length === 0 && !data.outcome && !data.quality && !data.records;
  // A generated population is read as a table of its variables; a real cohort as the rules that selected it and what each did to the count.
  const generated = isGenerated(data);
  const mayWrite = study.abilities.includes("write");
  const changed = () => { reload(); onStudyChanged?.(); };

  const download = () => {
    if (busy || !data.download) return;
    setBusy("download");
    void downloadVcrRecords(studyId, data.download.path)
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "记录暂时无法下载，请稍后重试。" })))
      .finally(() => setBusy(null));
  };
  // Generating again is a start like any other: the page stays, the strip says what goes on, and the table is read again when it is done.
  const regenerate = () => {
    if (busy) return;
    setBusy("regenerate");
    void editVcrCard(studyId, { kind: "population", regenerate: true })
      .then(changed)
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法重新生成，请稍后重试。" })))
      .finally(() => setBusy(null));
  };

  // --- the band's one row -----------------------------------------------------------------------------------------------
  const actions: VcrToolbarAction[] = [];
  if (!nothing) {
    if (generated) {
      if (data.download) actions.push({ key: "download", label: "下载记录", icon: Download, loading: busy === "download", onSelect: download });
      if (mayWrite) {
        actions.push({ key: "settings", label: "改设定", quiet: true, onSelect: () => setEditing("population") });
        actions.push({ key: "regenerate", label: "重新生成", loading: busy === "regenerate", onSelect: regenerate });
      }
    } else if (mayWrite && data.criteria.length > 0) {
      actions.push({ key: "criteria", label: "改入排数值", quiet: true, onSelect: () => setEditing("criteria") });
    }
  }
  const summary = [data.version, data.kind].filter(Boolean).join(" · ");
  useVcrToolbar(!nothing && (actions.length > 0 || summary)
    ? { label: "人群的操作", ...(summary ? { summary } : {}), ...(actions.length > 0 ? { actions: <VcrToolbarActions actions={actions} /> } : {}) }
    : null);

  if (nothing) {
    return failed
      ? <VcrStepFailed studyId={studyId} study={study} step="population" partial={data.partial} />
      : <VcrStepPending studyId={studyId} study={study} step="population" />;
  }

  return (
    <div className="flex flex-col gap-6">
      {failed
        ? <VcrStepFailed studyId={studyId} study={study} step="population" partial={data.partial} />
        : data.partial && <PartialResultNote sentence={data.partial.sentence} resume={{ studyId, study, step: "population" }} />}

      <Stale note={data.stale}>
        <div className="flex flex-col gap-6">
          {generated
            ? <GeneratedBody studyId={studyId} data={data} />
            : <CohortBody data={data} />}

          {data.quality && (data.quality.groups.length > 0 || data.quality.trainingRecords != null || data.quality.copies != null) && (
            <QualityCard quality={data.quality} />
          )}
        </div>
      </Stale>

      <VcrDefinitionsSection
        studyId={studyId}
        knowledge={data.knowledge}
        canWrite={mayWrite}
        canRun={study.abilities.includes("run")}
        onChanged={changed}
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

/* ------------------------------------------------------------------------- a generated population */

/** Where a count in the headline takes the reader: down to the thing it counts. */
const scrollTo = (id: string) => () => document.getElementById(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });

/**
 * The generated population: the sentence that says what it is and whether any record broke a limit, the variables (set → came out →
 * shape → limit), the same shapes against what was declared, and the first rows.
 */
function GeneratedBody({ studyId, data }: { studyId: string; data: PopulationData }) {
  const records = data.records?.rows ?? data.counts?.generatedRecords ?? data.download?.rows ?? null;
  const rows = data.generated;
  const broken = rows.filter((row) => limitState(row)?.ok === false).length;
  const labels = variableLabels(rows);
  const title = [data.version?.replace(/（.*）$/, ""), data.kind].filter(Boolean).join(" · ");
  const parts = [
    ...(title ? [`${title} · `] : []),
    ...(records !== null ? [{ n: numberText(records, 0), onOpen: scrollTo(RECORDS_ID), label: `${numberText(records, 0)} 条生成记录，看记录` }, " 条生成记录"] : []),
    ...(broken > 0 ? ["；", { n: numberText(broken, 0), onOpen: scrollTo("vcr-population-variables"), label: `${numberText(broken, 0)} 个变量有记录越出限定，看这些变量` }, " 个变量有记录越出设定的限定"] : []),
    ...data.constraints.filter((constraint) => constraint.violations > 0)
      .flatMap((constraint) => ["；", `${constraint.label} `, { n: numberText(constraint.violations, 0) }, " 条记录违反"]),
  ];
  const drawn = rows.filter((row) => row.histogram || (row.levels && row.levels.length > 0));
  const grid: ChartGridCell[][] = drawn.length > 0
    ? [[{
      key: "distributions",
      span: 2,
      node: <ChartCard title={broken > 0 ? "每个变量的分布，对照设定（有越出限定的）" : "每个变量的分布，对照设定"}><DistributionGrid rows={drawn} /></ChartCard>,
    }]]
    : [];
  return (
    <>
      {parts.length > 0 && <Headline parts={parts as Parameters<typeof Headline>[0]["parts"]} />}

      {rows.length > 0 && (
        <div id="vcr-population-variables" tabIndex={-1} className="outline-none">
          <Section title="变量" count={rows.length}>
            <DataTable
              label="每个变量设定的分布和生成的结果"
              columns={variableColumns()}
              rows={rows}
              rowKey={(row) => row.key}
              rowAttrs={(row) => ({ "data-vcr-variable": row.key })}
              minWidth="min-w-[40rem]"
            />
          </Section>
        </div>
      )}

      {grid.length > 0 && <ChartGrid rows={grid} />}

      {data.records && (
        <div id={RECORDS_ID} tabIndex={-1} className="outline-none">
          <PatientTable studyId={studyId} source="population" result={data.records.result} title="记录" labels={labels} pageSize={10} />
        </div>
      )}
    </>
  );
}

/** One variable per row: what was set, what came out, its shape, and whether any record broke its limits. */
function variableColumns(): Array<DataColumn<VcrGeneratedRow>> {
  return [
    { key: "variable", header: "变量", rowHeader: true, cell: (row) => <span className="text-text">{row.label}</span> },
    { key: "declared", header: "设定", isEmpty: (row) => !row.declared, cell: (row) => <span className="text-text-2">{row.declared ?? "—"}</span> },
    {
      key: "result",
      header: "生成",
      isEmpty: (row) => !row.result && !row.missing,
      cell: (row) => (
        <span className="tabular-nums text-text">
          {row.result ?? "—"}
          {row.missing && <span className="block text-caption text-text-3">{row.missing}</span>}
        </span>
      ),
    },
    {
      key: "shape",
      header: "分布",
      align: "right",
      isEmpty: (row) => !row.histogram,
      cell: (row) => (row.histogram ? <VcrMiniHistogram counts={row.histogram.counts} /> : null),
    },
    { key: "limit", header: "限定", isEmpty: (row) => limitState(row) === null && boundsText(row.declaredSpec) === null, cell: (row) => <LimitCell row={row} /> },
  ];
}

/** The engine's count of the limits a variable declared, as a mark and its words; nothing where nothing was declared. */
function LimitCell({ row }: { row: VcrGeneratedRow }) {
  const state = limitState(row);
  const bounds = boundsText(row.declaredSpec);
  if (!state) return bounds ? <span className="text-text-2">{bounds}</span> : null;
  return (
    <span data-vcr-limit={state.ok ? "ok" : "broken"} className={cn("inline-flex items-center gap-1", state.ok ? "text-ok" : "text-warn-strong")}>
      {state.ok ? <CircleCheck size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}
      {state.ok ? bounds ?? state.text : state.text}
    </span>
  );
}

/* ------------------------------------------------------------------------- a real cohort */

/** The definition, the rules with their three counts, what each did to the count, and how the cohort compares with the comparator's. */
function CohortBody({ data }: { data: PopulationData }) {
  const facts: Fact[] = data.definition
    ? [
      ...(data.definition.timeZero ? [{ label: "时间零点", value: data.definition.timeZero }] : []),
      ...(data.definition.evidenceWindow ? [{ label: "证据时效", value: data.definition.evidenceWindow }] : []),
      ...(data.definition.exit ? [{ label: "退出", value: data.definition.exit }] : []),
    ]
    : [];
  const row: ChartGridCell[] = [];
  if (data.attrition.length > 0) {
    row.push({
      key: "attrition",
      span: data.profile.length > 0 ? 1 : 2,
      node: (
        <ChartCard title="逐条筛选">
          <VcrAttritionChart steps={data.attrition} />
          {data.outcome && (
            <div className="mt-4 border-t border-border pt-3">
              <VcrFunnelBar eligible={data.outcome.eligible} insufficient={data.outcome.insufficient} ineligible={data.outcome.ineligible} />
              <p data-vcr-outcome="" className="mt-2 flex flex-wrap gap-x-6 text-ui tabular-nums text-text">
                <span><span className="font-semibold">{numberText(data.outcome.eligible, 0)}</span> 符合</span>
                <span><span className="font-semibold text-warn-strong">{numberText(data.outcome.insufficient, 0)}</span> 可能符合</span>
                <span className="text-text-3"><span className="font-semibold">{numberText(data.outcome.ineligible, 0)}</span> 不符合</span>
              </p>
            </div>
          )}
        </ChartCard>
      ),
    });
  }
  if (data.profile.length > 0) {
    row.push({ key: "profile", span: data.attrition.length > 0 ? 1 : 2, node: <ProfileCard rows={data.profile} /> });
  }
  return (
    <>
      {data.headline && <Headline parts={[data.headline]} />}

      {(facts.length > 0 || data.criteria.length > 0) && (
        <Section title="定义" count={data.criteria.length > 0 ? `${data.criteria.length} 条标准` : undefined}>
          {facts.length > 0 && <FactList rows={facts} />}
          {data.criteria.length > 0 && (
            <div className={cn(facts.length > 0 && "mt-4")}>
              <DataTable
                label="入排标准，每条保留、排除和无法判断的人数"
                columns={criteriaColumns()}
                rows={data.criteria}
                rowKey={(criterion) => criterion.id}
                rowAttrs={(criterion) => ({ "data-vcr-rule": criterion.code })}
                minWidth="min-w-[32rem]"
              />
            </div>
          )}
        </Section>
      )}

      {row.length > 0 && <ChartGrid rows={[row]} />}

      {(data.unknownReasons.length > 0 || data.blockers.length > 0) && (
        <div className="grid gap-x-6 gap-y-2 lg:grid-cols-2 [&>section]:mt-0">
          {data.unknownReasons.length > 0 && (
            <Section title="无法判断的原因" count={data.unknownReasons.length}>
              <DataTable
                label="无法判断的原因"
                columns={[
                  {
                    key: "reason",
                    header: "原因",
                    rowHeader: true,
                    cell: (reason) => (
                      <span className="flex flex-col">
                        <span className="text-text">{reason.label}</span>
                        {reason.detail && <span className="text-caption text-text-3">{reason.detail}</span>}
                      </span>
                    ),
                  },
                  { key: "count", header: "人数", align: "right", cell: (reason) => <span className="tabular-nums text-text">{numberText(reason.count, 0)}</span> },
                ]}
                rows={data.unknownReasons}
                rowKey={(reason) => reason.key}
                minWidth="min-w-0"
              />
            </Section>
          )}
          {data.blockers.length > 0 && (
            <Section title="最卡人的三条" count={data.blockers.length}>
              <DataTable
                label="最卡人的几条标准"
                columns={[
                  { key: "code", header: "编号", rowHeader: true, width: "w-16", cell: (blocker) => <span className="tabular-nums text-text-3">{blocker.code}</span> },
                  {
                    key: "label",
                    header: "标准",
                    cell: (blocker) => (
                      <span className="flex flex-col">
                        <span className="text-text">{blocker.label}</span>
                        {blocker.quote && <span className="text-caption text-text-3">{`“${blocker.quote}”`}</span>}
                      </span>
                    ),
                  },
                  {
                    key: "text",
                    header: "人数",
                    align: "right",
                    cell: (blocker) => <span className={cn("tabular-nums", blocker.tone === "attention" ? "font-medium text-warn-strong" : "text-text-2")}>{blocker.text}</span>,
                  },
                ]}
                rows={data.blockers}
                rowKey={(blocker) => blocker.code}
                minWidth="min-w-0"
              />
            </Section>
          )}
        </div>
      )}
    </>
  );
}

/** The rules, in order: each with the people kept, excluded and undecidable, and — as a mark, not a sentence — where it came from. */
function criteriaColumns(): Array<DataColumn<PopulationData["criteria"][number]>> {
  return [
    { key: "code", header: "编号", rowHeader: true, width: "w-14", cell: (criterion) => <span className="tabular-nums text-text-3">{criterion.code}</span> },
    {
      key: "rule",
      header: "标准",
      cell: (criterion) => (
        <span className="flex flex-col gap-0.5">
          <span className="text-text">{criterion.name}</span>
          {criterion.quote && <span className="text-caption text-text-3">{`“${criterion.quote}”`}</span>}
          {(criterion.source || criterion.changed) && (
            <span className="flex flex-wrap items-center gap-1.5">
              {criterion.changed && <Tag>{criterion.changed}</Tag>}
              {criterion.source && <SourceTag source={criterion.source} />}
            </span>
          )}
        </span>
      ),
    },
    { key: "kept", header: "保留", align: "right", cell: (criterion) => <span data-vcr-rule-kept="" className="tabular-nums text-text-2">{numberText(criterion.kept, 0)}</span> },
    { key: "excluded", header: "排除", align: "right", cell: (criterion) => <span data-vcr-rule-excluded="" className="tabular-nums text-text-3">{numberText(criterion.excluded, 0)}</span> },
    {
      key: "unknown",
      header: "无法判断",
      align: "right",
      cell: (criterion) => (
        <span data-vcr-rule-unknown="" className={cn("tabular-nums", (criterion.unknown ?? 0) > 0 ? "font-medium text-warn-strong" : "text-text-3")}>
          {numberText(criterion.unknown, 0)}
        </span>
      ),
    },
  ];
}

/** Ours against the comparator's population, row by row, with the balance floor drawn. */
function ProfileCard({ rows }: { rows: readonly VcrProfileRow[] }) {
  return (
    <ChartCard title="人群画像">
      <table className="w-full border-collapse text-caption">
        <caption className="sr-only">本人群与对照人群的基线比较</caption>
        <thead>
          <tr className="border-b border-border text-text-3">
            <th scope="col" className="py-1 pr-2 text-left font-normal">特征</th>
            <th scope="col" className="px-2 py-1 text-right font-normal">本人群</th>
            <th scope="col" className="px-2 py-1 text-right font-normal">对照</th>
            <th scope="col" className="py-1 pl-2 text-right font-normal">|SMD|</th>
            <th scope="col" className="w-20 py-1 pl-2 font-normal"><span className="sr-only">界值 0.1</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-vcr-profile={row.key} className={cn("border-b border-faint", row.flagged && "bg-warn-soft")}>
              <th scope="row" className="py-1.5 pr-2 text-left font-normal text-text">{row.label}</th>
              <td className="px-2 py-1.5 text-right tabular-nums text-text"><VcrNumber value={row.ours} label={`本人群 ${row.label}`} /></td>
              <td className="px-2 py-1.5 text-right tabular-nums text-text-2"><VcrNumber value={row.theirs} label={`对照 ${row.label}`} /></td>
              <td className={cn("py-1.5 pl-2 text-right tabular-nums", row.flagged ? "font-medium text-warn-strong" : "text-text-2")}>
                {row.smd != null ? row.smd.toFixed(2) : "—"}
              </td>
              <td className="py-1.5 pl-2"><VcrSmdDot smd={row.smd} label={row.label} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </ChartCard>
  );
}

/**
 * 质量报告: the synthetic population's fixed metric set — fidelity, utility and leakage risk — as values, with the generator's
 * training-record count and the number of copies it made (plan §5.1). It reports; it never says 安全, 匿名 or 合格, because none of
 * those is a number this report can hold.
 */
function QualityCard({ quality }: { quality: VcrQualityReport }) {
  const counts = [
    quality.trainingRecords != null ? `训练记录 ${countText(quality.trainingRecords)} 条` : null,
    quality.copies != null ? `合成 ${countText(quality.copies)} 份` : null,
  ].filter(Boolean);
  return (
    <ChartCard title="质量报告" meta={quality.tag ? <Tag>{quality.tag}</Tag> : undefined} footnote={counts.length > 0 ? <span className="tabular-nums">{counts.join(" · ")}</span> : undefined}>
      <div data-vcr-quality="" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {quality.groups.map((group) => (
          <section key={group.key} data-vcr-quality-group={group.key}>
            <BlockHeading className="text-caption text-text-3">{group.label}</BlockHeading>
            <dl className="mt-1.5 flex flex-col gap-1.5">
              {group.rows.map((metric) => (
                <div key={metric.key} className="flex items-baseline justify-between gap-2">
                  <dt className="min-w-0 text-caption text-text-2">{metric.label}</dt>
                  <dd className="shrink-0 text-ui tabular-nums text-text"><VcrNumber value={metric.value} label={metric.label} /></dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </ChartCard>
  );
}
