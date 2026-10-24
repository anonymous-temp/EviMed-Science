import { ensureGeoConversationSession } from "./geoConversationSession";
import { useState } from "react";
import { Link, useLocation } from "react-router";
import { GEO_METRIC_LABELS_ZH } from "@evimed/domain";
import {
  getGeoAnalysis,
  type GeoAnalysisDescriptor,
  type GeoAnalysisRow,
  type GeoAnalysisId,
  type GeoAnalysisMembers,
} from "@/lib/geoAnalysisClient";
import {
  getGeoProject,
  stageGeoPlanContext,
  type GeoProject,
} from "@/lib/geoClient";
import { geoReadScopeQuery, type GeoMetricMembers } from "@/lib/geoReadScope";
import { geoSessionIdFromChatPath } from "@/lib/geoLocation";
import { webErrorMessage } from "@/lib/apiClient";
import { Section } from "@/components/ui/Section";
import { Disclosure } from "@/components/ui/Disclosure";
import { Toolbar } from "@/components/ui/Toolbar";
import { DataTable } from "@/components/ui/DataTable";
import { Button } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import { DocumentExportActions } from "@/components/document/DocumentExportActions";
import { useGeoReadScope, useGeoFrame } from "./geoFrame";
import { useGeoLoad } from "./geoProjectData";
import { useGeoPath } from "./useGeoPath";
import { useOpenGeoConversation } from "./useOpenGeoConversation";
import { GeoAnalysisMembersDrawer } from "./GeoAnalysisMembersDrawer";
import { GeoMetricMembersDrawer } from "./GeoMetricMembersDrawer";
import { formatGeoValue, geoCellWord } from "./GeoCellText";
import { metricUnit } from "./tabs/geoTabText";
import { GeoAnalysisVisual } from "./GeoAnalysisVisual";
import { engineName } from "./geoText";

export function GeoAnalysisWorkbench({
  geoId,
  project,
  initialView = "V01",
  embedded = false,
}: {
  geoId: string;
  project: GeoProject;
  initialView?: GeoAnalysisId;
  embedded?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (embedded)
    return (
      <div data-geo-analysis="">
        <Section
          title="所选数据分析"
          level={initialView === "V12" ? "section" : "sub"}
        >
          <AnalysisBody
            geoId={geoId}
            project={project}
            initialView={initialView}
          />
        </Section>
      </div>
    );
  return (
    <Disclosure summary="所选数据分析" onToggle={setExpanded}>
      {expanded && (
        <AnalysisBody
          geoId={geoId}
          project={project}
          initialView={initialView}
        />
      )}
    </Disclosure>
  );
}
function AnalysisBody({
  geoId,
  project,
  initialView,
}: {
  geoId: string;
  project: GeoProject;
  initialView: GeoAnalysisId;
}) {
  const scope = useGeoReadScope();
  const [view, setView] = useState<GeoAnalysisDescriptor>({
    viewId: initialView,
    dimension: initialView === "V05" ? "group" : ["V02", "V04"].includes(initialView) ? "engine" : "project",
  });
  const identity = JSON.stringify([geoId, geoReadScopeQuery(scope), view]);
  return (
    <AnalysisPage
      key={identity}
      geoId={geoId}
      project={project}
      view={view}
      setView={setView}
    />
  );
}
function AnalysisPage({
  geoId,
  project,
  view,
  setView,
}: {
  geoId: string;
  project: GeoProject;
  view: GeoAnalysisDescriptor;
  setView(view: GeoAnalysisDescriptor): void;
}) {
  const scope = useGeoReadScope(),
    frame = useGeoFrame();
  const contextPath = useGeoPath();
  const [page, setPage] = useState<{
    offset: number;
    reference: string;
    digest: string;
  } | null>(null);
  const [members, setMembers] = useState<
    GeoMetricMembers | GeoAnalysisMembers | null
  >(null);
  const location = useLocation(),
    open = useOpenGeoConversation();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { state, reload } = useGeoLoad(
    `analysis:${geoId}:${geoReadScopeQuery(scope)}:${JSON.stringify(view)}:${page?.offset ?? 0}`,
    () =>
      getGeoAnalysis(
        geoId,
        page ? { selectionRef: page.reference } : scope,
        view,
        page?.offset ?? 0,
        page?.digest,
      ),
  );
  const data = state.kind === "ready" ? state.data : null;
  const refresh = () => {
    setPage(null);
    if (state.kind === "error" && state.stale && frame?.refreshScope)
      frame.refreshScope();
    else reload();
  };
  const explain = async () => {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      const current = await getGeoProject(geoId);
      const sessionId = await ensureGeoConversationSession(
        project.projectId,
        geoSessionIdFromChatPath(location.pathname) ||
          new URLSearchParams(location.search).get("session") ||
          current.sessionId ||
          project.sessionId,
      );
      const context = await stageGeoPlanContext(geoId, {
        requestKey: crypto.randomUUID(),
        sessionId,
        mode: "analysis",
        selectionRef: data.selection.reference,
        view: data.view,
        expectedDigest: data.digest,
        intent: "explain",
      });
      await open(
        {
          projectId: project.projectId,
          geoId,
          sessionId: context.sessionId,
          geoPlanContext: { referenceId: context.referenceId },
        },
        context.draft,
      );
    } catch (cause) {
      setError(
        webErrorMessage(cause, {
          fallback: "分析暂时无法带入对话，请刷新后重试。",
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <Toolbar
        filters={[
          {
            kind: "select",
            label: "分析",
            value: view.viewId,
            options: [
              { value: "V01", label: "当前水平与目标" },
              { value: "V02", label: "指标趋势" },
              { value: "V04", label: "平台指标比较" },
              { value: "V05", label: "问题群与平台" },
              { value: "V06", label: "原始分类与平台" },
              { value: "V07", label: "逐题采集与判定" },
              { value: "V11", label: "采集与判定覆盖" },
              { value: "V12", label: "回答与陈述正确性" },
              { value: "V14", label: "临床主题与条件" },
            ],
            onChange: (value) =>
              setView({
                viewId: value as GeoAnalysisId,
                dimension: value === "V05" ? "group" : ["V02", "V04"].includes(value ?? "") ? "engine" : "project",
              }),
          },
          ...(view.viewId === "V01" || view.viewId === "V02"
            ? [
                {
                  kind: "select" as const,
                  label: "维度",
                  value: view.dimension ?? "project",
                  options: [
                    { value: "project", label: "整体" },
                    { value: "engine", label: "按平台" },
                    { value: "group", label: "按问题群" },
                  ],
                  onChange: (value: string | null) =>
                    setView({
                      ...view,
                      dimension:
                        value === "engine"
                          ? "engine"
                          : value === "group"
                            ? "group"
                            : "project",
                    }),
                },
              ]
            : []),
          ...(["V01", "V02", "V04", "V05", "V06"].includes(view.viewId) && view.entityKind !== "generic"
            ? [
                {
                  kind: "select" as const,
                  label: "指标",
                  value:
                    view.metricId ?? (["V02", "V04", "V05"].includes(view.viewId) ? "M-01" : null),
                  allLabel: view.viewId === "V01" ? "全部指标" : undefined,
                  options: Object.entries(GEO_METRIC_LABELS_ZH)
                    .filter(([id]) => id.startsWith("M-") && (!["V04", "V05"].includes(view.viewId) || !["M-16", "M-17", "M-18", "M-21"].includes(id)))
                    .map(([value, label]) => ({ value, label: String(label) })),
                  onChange: (value: string | null) =>
                    setView({ ...view, metricId: value }),
                },
              ]
            : []),
          ...(view.viewId === "V02" ? [{kind:"select" as const,label:"时间粒度",value:view.timeGrain ?? "day",options:[{value:"day",label:"按实测日期"},{value:"round",label:"按实际轮次"}],onChange:(value:string|null)=>setView({...view,timeGrain:value === "round"?"round":"day"})}] : []),
          ...(["V04","V05"].includes(view.viewId) ? [{kind:"select" as const,label:"实体",value:view.entityKind ?? "brand",options:[{value:"brand",label:"品牌指标"},...(project.product?.genericName?[{value:"generic",label:`通用名：${project.product.genericName}`}]:[])],onChange:(value:string|null)=>setView({...view,entityKind:value === "generic"?"generic":"brand",entityKey:value === "generic"?(project.product?.genericName ?? undefined):undefined,metricId:value === "generic"?null:"M-01"})}] : []),
          ...(view.viewId === "V06"
            ? [
                {
                  kind: "select" as const,
                  label: "原始分类",
                  value: view.categoryMode ?? "original_group",
                  options: [
                    { value: "original_group", label: "原始问题分类" },
                    { value: "client_tags", label: "客户标签" },
                  ],
                  onChange: (value: string | null) =>
                    setView({
                      ...view,
                      categoryMode:
                        value === "client_tags"
                          ? "client_tags"
                          : "original_group",
                    }),
                },
              ]
            : []),
        ]}
        actions={
          data ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={() => void explain()}
            >
              在对话中解释
            </Button>
          ) : undefined
        }
      />
      {data?.availability?.reasons?.length && (
        <Note
          action={
            data.availability.reasons.includes(
              "original_categories_missing",
            ) ? (
              <Link
                className="text-accent"
                to={contextPath(
                  `/app/geo/${encodeURIComponent(geoId)}/questions`,
                )}
              >
                补充原始分类
              </Link>
            ) : (
              <Button size="sm" variant="text" onClick={refresh}>
                刷新范围
              </Button>
            )
          }
        >
          {data.availability.reasons
            .map(
              (reason) =>
                ({
                  generic_observation_identity_only: "通用名提及是独立观测；缺少匹配的历史实体提取时保留未知，不代表未提及，也不归因到品牌或剂型。",
                  no_selected_readings: "这个范围尚无可用读数。",
                  original_categories_missing:
                    "所选问题尚未保留原始分类，可在问题导入中补充。",
                  unknown_sampling_time:
                    "部分记录缺少采样时间，未计入任何实测日期。",
                  scheduled_jobs_separate_from_observed:
                    "计划与缺失任务单列，未并入实测回答；采集与判定属于两个独立统计轴。",
                  statement_not_applicable_not_a_verdict:
                    "陈述保留正确、错误和无法核实三种判定；无临床陈述只适用于经过验证的完整回答。",
                  legacy_applicability_unknown:
                    "历史回答没有适用性评价时保留未知。",
                })[reason] ?? reason,
            )
            .join(" ")}
        </Note>
      )}
      {!!data?.selection.timeCoverage?.unknownTime && (
        <Note
          result={[
            "采样时间未知的记录有 ",
            { n: data.selection.timeCoverage.unknownTime },
            " 条；这些记录未被放入任何实测日期，日期筛选外的记录仅作为覆盖背景。",
          ]}
        />
      )}
      {error && (
        <Note
          tone="warn"
          action={
            <Button size="sm" variant="text" onClick={refresh}>
              刷新分析
            </Button>
          }
        >
          {error}
        </Note>
      )}
      {data && <GeoAnalysisVisual data={data} onSelect={cell => {
        if (cell.members) { setMembers(cell.members); return; }
        const row = data.rows.find(item => item.key === cell.rowKey);
        if (row?.values[cell.columnKey]?.members) setMembers(row.values[cell.columnKey].members);
        else setPage({offset: 0, reference: data.selection.reference, digest: data.digest});
      }} />}
      <DataTable<GeoAnalysisRow>
        label="所选分析数据"
        rows={data?.rows ?? []}
        rowKey={(row) => row.key}
        state={
          state.kind === "loading"
            ? "loading"
            : state.kind === "error"
              ? "error"
              : data?.rows.length
                ? "content"
                : "empty"
        }
        emptyText="这个范围尚无可用读数。"
        errorMessage={state.kind === "error" ? state.message : undefined}
        onRetry={refresh}
        columns={[
          {
            key: "label",
            header: "指标与区间",
            rowHeader: true,
            cell: (row) => (
              <>
                {row.label.replace(
                  row.dimensions.engine ?? "\u0000",
                  engineName(row.dimensions.engine ?? ""),
                )}
                {row.dimensions.period === "round"
                  ? ` · ${row.dimensions.date ?? "采样时间未知"} · ${row.dimensions.roundLabel ?? (row.dimensions.roundKind === "baseline" ? "基线轮" : "复测轮")}`
                  : row.dimensions.date
                  ? ` · ${row.dimensions.date}`
                  : row.dimensions.period === "comparison"
                    ? " · 对照区间"
                    : row.dimensions.period
                      ? " · 所选区间"
                      : ""}
              </>
            ),
          },
          ...(data?.columns ?? []).map((column) => ({
            key: column.key,
            header: column.label,
            align: "right" as const,
            cell: (row: GeoAnalysisRow) => {
              const value = row.values[column.key];
              const word =
                value.state === "known" && value.value !== null
                  ? value.metric
                    ? formatGeoValue(value.value, metricUnit(row.metricId ?? undefined))
                    : value.unit
                      ? `${value.value} ${unitWord(value.unit)}`
                      : formatGeoValue(value.value, metricUnit(row.metricId ?? undefined))
                  : value.metric
                    ? geoCellWord(value.metric)
                    : "未测";
              return (
                <span className="inline-flex flex-col items-end">
                  {value.members ? (
                    <Button
                      size="sm"
                      variant="text"
                      onClick={() => setMembers(value.members)}
                    >
                      {word}
                    </Button>
                  ) : (
                    word
                  )}
                  {value.metric?.denominator != null && (
                    <span className="text-caption text-text-3">
                      {value.metric.numerator ?? "—"} /{" "}
                      {value.metric.denominator}
                    </span>
                  )}
                </span>
              );
            },
          })),
        ]}
        footnote="实测、对照与当前目标分别显示；空白不计为零。趋势图和导出均包含全部所选数据。"
      />
      {data && (
        <>
          <Note
            result={[
              "共 ",
              { n: data.page.total },
              " 行，当前显示 ",
              { n: data.page.shown },
              " 行。",
            ]}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!page}
              onClick={() => setPage(null)}
            >
              首批数据
            </Button>
            {data.page.nextOffset !== null && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  setPage({
                    offset: data.page.nextOffset!,
                    reference: data.selection.reference,
                    digest: data.digest,
                  })
                }
              >
                下一批数据
              </Button>
            )}
          </div>
          <DocumentExportActions
            source={{
              geoId,
              selectionRef: data.selection.reference,
              view: data.view,
              expectedDigest: data.digest,
            }}
            groupLabel="导出所选数据"
          />
        </>
      )}
      {members &&
        ("rowKey" in members ? (
          <GeoAnalysisMembersDrawer
            geoId={geoId}
            members={members}
            onClose={() => setMembers(null)}
          />
        ) : (
          <GeoMetricMembersDrawer
            geoId={geoId}
            members={members}
            onClose={() => setMembers(null)}
          />
        ))}
    </div>
  );
}

function unitWord(unit: string) {
  return (
    (
      {
        answers: "回答",
        asks: "任务",
        questions: "问题",
        statements: "陈述",
        records: "记录",
      } as Record<string, string>
    )[unit] ?? unit
  );
}
