import { ensureGeoConversationSession } from "./geoConversationSession";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { GEO_METRIC_LABELS_ZH, GEO_SOURCE_KIND_LABELS_ZH } from "@evimed/domain";
import {
  getGeoAnalysis,
  type GeoAnalysisDescriptor,
  type GeoAnalysisRow,
  type GeoAnalysisView,
  type GeoAnalysisId,
  type GeoAnalysisMembers,
} from "@/lib/geoAnalysisClient";
import {
  getGeoProject,
  stageGeoPlanContext,
  type GeoProject,
} from "@/lib/geoClient";
import { geoReadScopeQuery, geoSearchWithScope, type GeoMetricMembers } from "@/lib/geoReadScope";
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
import { metricUnit, roundKindWord, surfaceText } from "./tabs/geoTabText";
import { GeoAnalysisVisual } from "./GeoAnalysisVisual";
import { useOpenPublication } from "./spine/useOpenPublication";
import { SourceRelationship } from "./tabs/SourceRelationship";
import { engineName, claimConditionsText, GEO_ARTICLE_STATUS_WORDS } from "./geoText";

/** How long the source search waits after the last keystroke before it asks for a new analysis. */
const SEARCH_DEBOUNCE_MS = 300;

export function GeoAnalysisWorkbench({
  geoId,
  project,
  initialView = "V01",
  embedded = false,
  initialDescriptor,
}: {
  geoId: string;
  project: GeoProject;
  initialView?: GeoAnalysisId;
  embedded?: boolean;
  initialDescriptor?: GeoAnalysisDescriptor;
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
            initialDescriptor={initialDescriptor}
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
          initialDescriptor={initialDescriptor}
        />
      )}
    </Disclosure>
  );
}
function AnalysisBody({
  geoId,
  project,
  initialView,
  initialDescriptor,
}: {
  geoId: string;
  project: GeoProject;
  initialView: GeoAnalysisId;
  initialDescriptor?: GeoAnalysisDescriptor;
}) {
  const scope = useGeoReadScope();
  const [view, setView] = useState<GeoAnalysisDescriptor>(initialDescriptor ?? {
    viewId: initialView,
    dimension: initialView === "V05" ? "group" : ["V02", "V03", "V04"].includes(initialView) ? "engine" : "project",
  });
  const identity = JSON.stringify([geoId, geoReadScopeQuery(scope), {...view,sourceSearch:undefined}]);
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
  const openPublication = useOpenPublication(project);
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
  const [relationshipUrl, setRelationshipUrl] = useState<string | null>(null);
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
  // While the next read is in flight the rows already on screen stay (a new search term must not flip the table back to its skeleton);
  // a failed read still shows its error.
  const lastData = useRef<GeoAnalysisView | null>(null);
  if (state.kind === "ready") lastData.current = state.data;
  const data = state.kind === "ready" ? state.data : state.kind === "loading" ? lastData.current : null;
  const refreshing = state.kind === "loading" && data !== null;
  // The box shows every keystroke at once; the source search is asked for once the person pauses.
  const [searchText, setSearchText] = useState(view.sourceSearch ?? "");
  const latestView = useRef(view);
  latestView.current = view;
  const searchTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(searchTimer.current), []);
  const applySearch = (text: string, wait: number) => {
    window.clearTimeout(searchTimer.current);
    const apply = () => { setPage(null); setView({ ...latestView.current, sourceSearch: text || undefined }); };
    if (wait > 0) searchTimer.current = window.setTimeout(apply, wait);
    else apply();
  };
  const refresh = () => {
    setPage(null);
    if (state.kind === "error" && state.stale && frame?.refreshScope)
      frame.refreshScope();
    else reload();
  };
  const sourceActionPath=(changes:Record<string,string>)=>{
    const query=new URLSearchParams(geoSearchWithScope(location.search,{selectionRef:data!.selection.reference}));
    for(const [key,value] of Object.entries(changes))query.set(key,value);
    return `/app/geo/${encodeURIComponent(geoId)}/sources?${query}`;
  };
  const explain = async (focus?: {rowKey:string;columnKey:string}) => {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      const current = await getGeoProject(geoId);
      const sessionId = await ensureGeoConversationSession(
        geoId, project.projectId,
        geoSessionIdFromChatPath(location.pathname) ||
          new URLSearchParams(location.search).get("session") ||
          current.sessionId ||
          project.sessionId,
      );
      const context = await stageGeoPlanContext(geoId, {
        requestKey: crypto.randomUUID(),
        sessionId,
        mode: focus && data.view.viewId === "V21" ? "strategy" : "analysis",
        selectionRef: data.selection.reference,
        view: data.view,
        expectedDigest: data.digest,
        intent: focus ? "next_steps" : "explain",
        ...(focus ? {focus} : {}),
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
    <div className="flex flex-col gap-4" aria-busy={refreshing || undefined}>
      <Toolbar
        filters={[
          {
            kind: "select",
            label: "分析",
            value: view.viewId,
            options: [
              { value: "V01", label: "当前水平与目标" },
              { value: "V02", label: "指标趋势" },
              { value: "V03", label: "可比变化排序" },
              { value: "V10", label: "旅程与需求覆盖" },
              { value: "V16", label: "结论条件与来源依据" },
              { value: "V13", label: "讲错类型与严重程度" },
              { value: "V23", label: "内容与发布覆盖" },
              { value: "V24", label: "投放与发布状态" },
              { value: "V25", label: "预算、结算与退款" },
              { value: "V26", label: "方案冻结实测与规划目标" },
              { value: "V15", label: "错误观察与处理历史" },
              { value: "V27", label: "事件与采样观察" },
              { value: "V09", label: "推荐表达与条件" },
              { value: "V08", label: "已登记竞品与趋势" },
              { value: "V04", label: "平台指标比较" },
              { value: "V05", label: "问题群与平台" },
              { value: "V06", label: "原始分类与平台" },
              { value: "V07", label: "逐题采集与判定" },
              { value: "V11", label: "采集与判定覆盖" },
              { value: "V12", label: "回答与陈述正确性" },
              { value: "V14", label: "临床主题与条件" },
              { value: "V17", label: "来源类型覆盖" },
              { value: "V18", label: "域名与页面排名" },
              { value: "V19", label: "来源与平台或问题群" },
              { value: "V20", label: "已确认信源关系" },
              { value: "V21", label: "问题群提及与自有引用" },
              { value: "V22", label: "页面引用观察历史" },
            ],
            onChange: (value) =>
              setView({
                viewId: value as GeoAnalysisId,
                dimension: value === "V05" ? "group" : ["V02", "V03", "V04"].includes(value ?? "") ? "engine" : "project",
              }),
          },
          ...(["V17","V18","V19","V20","V22"].includes(view.viewId)?[
            {kind:"select" as const,label:"来源类型",value:view.sourceType??null,allLabel:"全部类型",options:[...Object.entries({...GEO_SOURCE_KIND_LABELS_ZH,...Object.fromEntries((data?.definition?.sourceTypes??[]).filter(type=>type!=="unknown"&&!(type in GEO_SOURCE_KIND_LABELS_ZH)).map(type=>[type,type]))}).map(([value,label])=>({value,label:String(label)})),{value:"unknown",label:"类型未知"}],onChange:(value:string|null)=>setView({...view,sourceType:value??undefined})},
            {kind:"select" as const,label:"共同出现",value:view.sourceRelationship??"all",options:[{value:"all",label:"全部引用回答"},{value:"wrong",label:"共同出现我方错误"},{value:"mentions",label:"共同出现品牌提及"}],onChange:(value:string|null)=>setView({...view,sourceRelationship:value==="wrong"?"wrong":value==="mentions"?"mentions":"all"})},
            ...(["V18","V19"].includes(view.viewId)?[{kind:"select" as const,label:"排名对象",value:view.sourceLevel??"domain",options:[{value:"domain",label:"域名"},{value:"page",label:"页面"}],onChange:(value:string|null)=>setView({...view,sourceLevel:value==="page"?"page":"domain"})}]:[]),
            ...(view.viewId==="V19"?[{kind:"select" as const,label:"来源交叉维度",value:view.sourceFacet??"engine",options:[{value:"engine",label:"平台"},{value:"group",label:"版本化问题群"}],onChange:(value:string|null)=>setView({...view,sourceFacet:value==="group"?"group":"engine"})}]:[]),
            {kind:"select" as const,label:"图表显示",value:String(view.topN??15),options:[5,15,30,50].map(value=>({value:String(value),label:`前 ${value} 项及其余`})),onChange:(value:string|null)=>setView({...view,topN:Number(value??15)})},
          ]:[]),
          ...(view.viewId === "V25" ? [{kind:"select" as const,label:"收支维度",value:view.financeFacet??"ledger",options:[{value:"ledger",label:"逐条账目与余额"},{value:"group",label:"明确关联的问题群"}],onChange:(value:string|null)=>setView({...view,financeFacet:value==="group"?"group":"ledger"})}] : []),
          ...(view.viewId === "V26" ? [{kind:"select" as const,label:"方案版本",value:view.strategyVersion!=null?String(view.strategyVersion):null,allLabel:"所选范围最新方案",options:data?.view.strategyVersion?[{value:String(data.view.strategyVersion),label:`方案版本 ${data.view.strategyVersion}`}]:[],onChange:(value:string|null)=>setView({...view,strategyVersion:value?Number(value):undefined,targetVersion:undefined})}] : []),
          ...(view.viewId === "V23" ? [{kind:"select" as const,label:"内容覆盖维度",value:view.publicationFacet??"group",options:[{value:"group",label:"问题群"},{value:"audience",label:"面向人群"},{value:"channel",label:"预期渠道"}],onChange:(value:string|null)=>setView({...view,publicationFacet:value==="audience"?"audience":value==="channel"?"channel":"group"})}] : []),
          ...(view.viewId === "V13" ? [
            {kind:"select" as const,label:"错误维度",value:view.errorFacet??"type",options:[{value:"type",label:"错误类型"},{value:"severity",label:"严重程度"}],onChange:(value:string|null)=>setView({...view,errorFacet:value==="severity"?"severity":"type"})},
            {kind:"select" as const,label:"判定状态",value:view.errorView??"active",options:[{value:"active",label:"当前有效判定"},{value:"withdrawn",label:"已撤回判定"},{value:"all",label:"全部判定"}],onChange:(value:string|null)=>setView({...view,errorView:value==="all"?"all":value==="withdrawn"?"withdrawn":"active"})},
          ] : []),
          ...(view.viewId === "V16" ? [{kind:"select" as const,label:"证据视角",value:view.evidenceKind??"claims",options:[{value:"claims",label:"结论与来源"},{value:"findings",label:"发现表达"}],onChange:(value:string|null)=>setView({...view,evidenceKind:value==="findings"?"findings":"claims"})}] : []),
          ...(view.viewId === "V21" ? [{kind:"select" as const,label:"自有引用口径",value:view.ownedMetricId??"M-08",options:[{value:"M-08",label:"M-08 · 可追溯检索"},{value:"M-08S",label:"M-08S · 全部合资格回答"}],onChange:(value:string|null)=>setView({...view,ownedMetricId:value==="M-08S"?"M-08S":"M-08"})}] : []),
          ...(["V01", "V02", "V03"].includes(view.viewId)
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
          ...(["V01", "V02", "V03", "V04", "V05", "V06", "V08", "V27"].includes(view.viewId) && view.entityKind !== "generic"
            ? [
                {
                  kind: "select" as const,
                  label: "指标",
                  value:
                    view.metricId ?? (view.viewId === "V08" ? "M-16" : ["V02", "V03", "V04", "V05", "V27"].includes(view.viewId) ? "M-01" : null),
                  allLabel: view.viewId === "V01" ? "全部指标" : undefined,
                  options: Object.entries(GEO_METRIC_LABELS_ZH)
                    .filter(([id]) => id.startsWith("M-") && (view.viewId !== "V08" || ["M-16","M-17"].includes(id)) && (!["V04", "V05", "V27"].includes(view.viewId) || !["M-16", "M-17", "M-18", "M-21"].includes(id)))
                    .map(([value, label]) => ({ value, label: String(label) })),
                  onChange: (value: string | null) =>
                    setView({ ...view, metricId: value }),
                },
              ]
            : []),
          ...(["V02","V08"].includes(view.viewId) ? [{kind:"select" as const,label:"时间粒度",value:view.timeGrain ?? "day",options:[{value:"day",label:"按实测日期"},{value:"round",label:"按实际轮次"}],onChange:(value:string|null)=>setView({...view,timeGrain:value === "round"?"round":"day"})}] : []),
          ...(["V04","V05"].includes(view.viewId) ? [{kind:"select" as const,label:"实体",value:view.entityKind ?? "brand",options:[{value:"brand",label:"品牌指标"},...(project.product?.genericName?[{value:"generic",label:`当前配置通用名：${project.product.genericName}`}]:[])],onChange:(value:string|null)=>setView({...view,entityKind:value === "generic"?"generic":"brand",entityKey:value === "generic"?(project.product?.genericName ?? undefined):undefined,metricId:value === "generic"?null:"M-01"})}] : []),
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
        search={["V17","V18","V19","V20","V22"].includes(view.viewId)?{label:"搜索引用来源",value:searchText,maxLength:300,onChange:value=>{setSearchText(value);applySearch(value,SEARCH_DEBOUNCE_MS);},onClear:()=>{setSearchText("");applySearch("",0);}}:undefined}
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
      {!!data?.availability?.reasons?.length && (
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
              <Button size="sm" variant="text" onClick={data.availability.reasons.includes("comparison_not_selected") ? () => frame?.openAnalysisScope?.() : refresh}>
                {data.availability.reasons.includes("comparison_not_selected") ? "选择对照区间" : "刷新范围"}
              </Button>
            )
          }
        >
          {availabilityText(data.availability.reasons)}
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
          state.kind === "loading" && !data
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
                {row.dimensions.kind === "history_reading" && <p className="text-caption text-text-2">观察区间：{row.dimensions.observedFrom??"未知"} 至 {row.dimensions.observedTo??"未知"}{row.dimensions.unknownTimes?`；另有 ${row.dimensions.unknownTimes} 条时间未保留`:""}</p>}
                {row.dimensions.kind === "error_history" && <p className="text-caption text-text-2">当前处置：{({open:"待处理",acting:"正在处理",awaiting_remeasure:"等待再次观察",closed:"已关闭"} as Record<string,string>)[row.dimensions.currentStatus??""]??"未知"}；当前判定：{row.dimensions.currentJudgmentState==="withdrawn"?"已撤回":row.dimensions.currentJudgmentState==="active"?"有效":"未知"}</p>}
                {row.dimensions.kind === "frozen_plan_target" && <Link className="block text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/plan${geoReadScopeQuery({selectionRef:data!.selection.reference})}&strategyVersion=${row.dimensions.strategyVersion}`)}>查看此版本方案与调整费用目标</Link>}
                {row.dimensions.kind === "journey_need" && <Button size="sm" variant="text" disabled={!!project.access&&!project.access.abilities.includes("edit")} loading={busy} onClick={()=>void explain({rowKey:row.key,columnKey:"questions"})}>按此需求补充问题与内容</Button>}
                {row.dimensions.kind === "journey_need" && <Link className="block text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/questions${geoReadScopeQuery({selectionRef:data!.selection.reference})}&group=${encodeURIComponent(row.dimensions.groupId??"")}`)}>查看问题与采集</Link>}
                {row.dimensions.kind === "journey_unmapped" && <Link className="block text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/evidence`)}>补充证据与需求关联</Link>}
                {row.dimensions.kind === "clinical_source_support" && <><p className="text-caption text-text-2">适用条件：{claimConditionsText(row.dimensions.applicability)} · 证据级别：{row.dimensions.evidenceLevel??"未知"}</p><Link className="text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/evidence${geoReadScopeQuery({selectionRef:data!.selection.reference})}`)}>查看或更新证据</Link></>}
                {row.dimensions.kind === "finding_expression" && <p className="text-caption text-text-2">发现版本 {row.dimensions.basisVersion??"未知"} · {row.dimensions.definitionState==="known"?"已保留原始定义":"原始定义未保留"}</p>}
                {row.dimensions.groupState && <p className="text-caption text-text-2">{row.dimensions.groupName} · 问题版本 {row.dimensions.setVersion??"未知"} · {row.dimensions.groupState==="known"?"已映射":row.dimensions.groupState==="unmapped"?"未映射":"未知"}</p>}
                {row.dimensions.kind !== "journey_need" && row.dimensions.groupState === "known" && row.dimensions.groupId && <Link className="text-accent" to={sourceActionPath({group:row.dimensions.groupId})}>查看问题群与行动</Link>}
                {row.dimensions.kind === "source_relationship" && <Disclosure summary="当前关系注释与编辑">{row.dimensions.annotationContext?.pages.slice(0,10).map(annotation=><p key={annotation.url}><Button size="sm" variant="text" onClick={()=>setRelationshipUrl(annotation.url)}>{annotation.url} · {row.dimensions.annotationContext?.records[annotation.recordIndex].origin??"未知"} · 修订 {row.dimensions.annotationContext?.records[annotation.recordIndex].reference?.revision??"未标记"}</Button></p>)}</Disclosure>}
                {row.dimensions.kind === "opportunity" && <>
                  <Button size="sm" variant="text" disabled={!!project.access&&!project.access.abilities.includes("edit")} loading={busy} onClick={()=>void explain({rowKey:row.key,columnKey:"owned"})}>按此问题群拟定方案</Button>
                  {row.values.owned?.reason === "owned_not_registered" && <Link className="block text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/actions`)}>登记自有发布地址</Link>}
                  {row.dimensions.gaps && <OpportunityLinks gaps={row.dimensions.gaps} openPublication={openPublication}/>}
                </>}
                {row.dimensions.kind === "source_history" && <p className="text-caption text-text-2">{row.dimensions.roundLabel} · 问题版本 {row.dimensions.setVersion??"未知"} · {surfaceText({ mode: row.dimensions.mode }) ?? "采样方式未知"}</p>}
                {row.dimensions.sourceType && <p className="text-caption text-text-2">{GEO_SOURCE_KIND_LABELS_ZH[row.dimensions.sourceType as keyof typeof GEO_SOURCE_KIND_LABELS_ZH] ?? (row.dimensions.sourceType === "unknown" ? "类型未知" : row.dimensions.sourceType)} · 所选范围内首次 {row.dimensions.firstObserved??"采样时间未知"} · 最近 {row.dimensions.lastObserved??"采样时间未知"}</p>}
                {row.dimensions.originalUrls && <Disclosure summary="原始引用地址与所选轮次"><ul>{row.dimensions.originalUrls.map(url=><li key={url}>{url}</li>)}</ul>{row.dimensions.history?.map(round=><p key={round.roundId}>{roundKindWord(round.kind) ?? "测量轮次"} · {round.citedAnswers} 个引用回答</p>)}{row.dimensions.sourceId&&<Link className="text-accent" to={sourceActionPath({source:row.dimensions.sourceId})}>查看来源与行动</Link>}{row.dimensions.sourceKey&&row.dimensions.originalUrls[0]&&<Link className="block text-accent" to={sourceActionPath({planUrl:row.dimensions.originalUrls[0]})}>将此页面用于方案</Link>}</Disclosure>}
                {row.dimensions.kind === "expression" && <p className="text-caption text-text-2">条件：{row.dimensions.conditionQuote ?? "未陈述"} · 推荐顺位：{row.dimensions.explicitPosition ?? "未明确"}</p>}
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
                value.state === "partial" && value.knownSubtotal != null ? `${value.knownSubtotal}（已核实小计）`
                : value.state === "known" && value.value !== null
                  ? typeof value.value === "string" ? sourceObservationWord(value.value) : value.metric
                    ? formatGeoValue(value.value, metricUnit(row.metricId ?? undefined))
                    : value.unit
                      ? `${value.value} ${unitWord(value.unit)}`
                      : formatGeoValue(value.value, metricUnit(row.metricId ?? undefined))
                  : value.metric
                    ? geoCellWord(value.metric)
                    : value.reason ? analysisReason(value.reason) : "未测";
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
                  {value.reason && value.state !== "known" && <span className="text-caption text-text-3">{analysisReason(value.reason)}</span>}
                  {(value.denominator ?? value.metric?.denominator) != null && (
                    <span className="text-caption text-text-3">
                      {value.numerator ?? value.metric?.numerator ?? "—"} /{" "}
                      {value.denominator ?? value.metric?.denominator}
                    </span>
                  )}
                </span>
              );
            },
          })),
        ]}
        footnote={["V15","V27"].includes(view.viewId)?"事件、任务与样本关联分别计数；样本可被多个事件引用，不是新增采样。采样读数保留实际观察区间，未知不补为零。":view.viewId==="V25"?"金额为人民币；历史余额使用完整项目账目前缀与当时预算，预留和退款不重复计为支出。":view.viewId==="V26"?"冻结实测、登记基线、当前实测与规划目标分别显示；费用为规划估计，未知不计为零。":["V17","V18","V19","V20","V22"].includes(view.viewId)?"所有来源先按所选范围与筛选聚合，再分页。数值可打开完整成员；类型覆盖可重叠，错误共同出现不代表因果。":"实测、对照与当前目标分别显示；空白不计为零。趋势图和导出均包含全部所选数据。"}
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
      {relationshipUrl && <SourceRelationship geoId={geoId} target={{kind:"page",value:relationshipUrl}} canEdit={!project.access || project.access.abilities.includes('edit')} onChanged={refresh}/> }
      {members &&
        ("rowKey" in members ? (
          <GeoAnalysisMembersDrawer
            geoId={geoId}
            members={members}
            project={project}
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

/** The reader's sentence for each reason a view can be only partly available; a reason this table does not know is never printed. */
const AVAILABILITY_REASON_WORDS: Record<string, string> = {
  finance_attribution_or_time_unknown:"部分金额缺少当前问题群资料、历史范围关联或记账日期，仍保留原始金额与已知历史关联；项目整体预算不分摊到问题群。",
  no_selected_business_events:"这个范围暂无匹配的已保留业务事件。",
  error_history_is_retained_observations:"只展示已保留的首见、最近及明确的历史记录；中间未保留的观察不作推测。",
  handling_context_unavailable:"处理任务的当前记录暂不可用；已保留事件仍可查看。",
  observation_time_unknown:"部分指标成员的观察时间未知，保留读数而不定位到时间轴。",
  group_history_scope_unavailable:"完整问题群的历史变化不代表这个更窄的筛选范围，已从本次事件计数中排除。",
  no_selected_ledger_entries:"这个范围暂无账目记录。",
  matching_plan_unavailable:"这个所选范围尚无匹配方案，可在现有方案中制定。",
  frozen_plan_basis_unavailable:"该历史方案未保留冻结依据，保持未知。",
  frozen_targets_unavailable:"该方案未保留规划目标。",
  plan_reading_or_estimate_unknown:"部分历史读数、费用或工作量未保留，保持未知；当前数据不补齐旧值。",
  publication_mapping_incomplete: "部分记录尚未关联到具体问题群或内容版本，已单独保留；这些记录不代表已经覆盖所选问题群。",
  content_format_unknown: "部分版本未保留可识别的文件格式，未知格式仍保留在明细中。",
  business_time_unknown: "部分业务记录未保留明确时间，已单独保留，不按采样时间补齐。",
  no_selected_publication_records: "这个范围尚无内容或发布记录。",
  verification_basis_incomplete: "部分结论缺少核实依据；已核实小计与待核实数量分别保留，未知不计为零。",
  registered_metric_not_manual_relationship: "登记自有指标按现有域名与地址规则匹配；人工页面关系单独保留，不能互换。",
  opportunity_denominators: "两条指标的合资格分母与样本要求可能不同。气泡面积仅表示实际回答样本；缺少关联对象不等于对象不存在。",
  owned_not_registered: "尚未登记自有信源，Y 保留未知。可从现有行动登记自主发布地址。",
  citation_history_selected_scope: "首次仅指所选范围内首次观察；变化只在同一可比问题及采集范围内解释。",
  citation_completeness_required: "可观测未引用需要完整采集计划、每次重复的有效回答及采集端记录的引用列表完整性；缺少声明、无链接、失败、拒答或未采样均为未知，不代表已穷尽全网或模型信息。",
  preserved_citations_partial_judgement: "来源分析保留部分判定回答的可用引用，不能据此声称回答已完成医学准确性判定。",
  source_relationship_cooccurrence_only: "错误和品牌提及为共同出现，不能据此归因到引用来源。",
  unlinked_citations_unobservable: "未保留可用链接的引用与检索能力不可观测，未计为零。",
  comparison_not_selected: "选择对照区间后，可按相同问题、平台和采样方式比较变化。",
  rival_history_unknown: "部分历史回答缺少登记实体依据，保持未知；阳性提及和合资格分母分别列出。",
  generic_observation_identity_only: "通用名来自当前配置，不代表所选历史轮次的登记名称。通用名提及是独立观测；缺少匹配的历史实体提取时保留未知，不代表未提及，也不归因到品牌或剂型。",
  no_selected_readings: "这个范围尚无可用读数。",
  no_preserved_evidence_observations: "这个范围尚无已保存的陈述判定或发现表达记录。",
  finding_definition_unavailable: "部分记录未保留当时的发现定义；保留版本与表达记录，不用最新定义补齐。",
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
  no_selected_records: "这个范围暂无可用记录。",
  no_linked_error_records: "这个范围暂无与之关联的错误记录。",
  recommendation_coverage_incomplete: "部分回答没有明确的推荐表达，推荐覆盖不完整，缺口不计为零。",
};
const AVAILABILITY_UNKNOWN_WORD = "部分数据暂不可用";

/** The reasons as one text: an unknown code reads as one neutral sentence, said once. */
function availabilityText(reasons: readonly string[]): string {
  return [...new Set(reasons.map((reason) => AVAILABILITY_REASON_WORDS[reason] ?? AVAILABILITY_UNKNOWN_WORD))].join(" ");
}

function unitWord(unit: string) {
  return (
    (
      {
        business_events:"事件",history_answer_refs:"样本关联",history_target_refs:"关联材料",CNY:"元",weeks:"周",placements:"次",ledger_entries:"账目记录",ledger_balance_readings:"余额读数",target_rows:"规划目标",frozen_metric_readings:"冻结实测",
        percentage_points: "个百分点",
        rank: "名",
        percent: "%",
        index: "分",
        answers: "回答",
        asks: "任务",
        questions: "问题",
        distinct_answered_questions: "已回答问题",
        claims: "结论", findings: "发现", articles: "内容", result_versions: "内容版本", publications: "发布记录", article_formats: "内容文件格式", orders: "订单", order_events: "订单事件", error_records: "错误记录",
        statements: "陈述",
  expressions: "表达",
        records: "记录",
        source_pairs: "配对",
        source_pages: "页面",
        rounds: "轮次",
      } as Record<string, string>
    )[unit] ?? unit
  );
}

function sourceObservationWord(value:string):string {
 return ({present:"已观察引用",absent:"可观测未引用",first_observed_in_scope:"所选范围内首次",new_appearance:"新出现",no_longer_observed:"同一可比范围内未再观察到"} as Record<string,string>)[value]??value;
}

function analysisReason(reason: string): string {
 if (reason === "verification_basis_incomplete") return "部分依据缺失，另见待核实结论";
 if (reason === "verification_basis_unavailable") return "核实依据缺失，保持未知";
 return ({frozen_reading_unavailable:"历史冻结读数未保留",not_recorded:"未记录或未估",association_context_unavailable:"关联依据未知",linked_not_verified:"已关联、尚未核实",owned_not_registered:"尚未登记自有信源",group_metric_unavailable:"该问题群没有适用的指标读数",sampling_plan_unknown:"缺少完整采集计划，未引用保持未知",sampling_plan_incomplete:"采集计划缺少重复任务，未引用保持未知",scheduled_observation_missing:"计划中的重复采集尚无回答",sampling_scope_incomplete:"重复回答未完整落入所选范围",citation_completeness_unknown:"采集端未记录完整引用列表",citations_without_links:"引用缺少可核对链接",answer_not_returned:"失败或拒答，无法观察未引用",no_sampling:"未采样，保持未知",comparison_cohort_unknown:"可比问题或采集范围未知",sampling_time_unknown:"采样时间未知",sampling_order_unknown:"采样顺序未知",comparison_not_selected:"请选择对照区间",measurement_method_changed:"测量方法已变化",measurement_contract_changed:"测量约定已变化",comparison_basis_changed:"组成指标或权重已变化",metric_members_changed:"合资格成员已变化",no_common_cohort:"没有共同问题与平台",separate_cohorts:"分别呈现，不排序",previous_metric_absent:"缺少对照读数",insufficient_sample:"样本不足，不排序",rival_history_unknown:"历史登记依据未知",own_brand_not_registered:"该范围未登记本品品牌，通用名独立观测",share_agreement_missing:"该轮未约定此声量指标或登记集合",generic_observation_identity_only:"通用名独立观测"} as Record<string,string>)[reason] ?? "暂无可用读数";
}

/** What a linked claim's state is called; a state nobody named is not printed. */
const CLAIM_STATE_WORDS: Record<string, string> = { active: "在用", expired: "已过期", retired: "已停用" };
const articleStateWord = (status: string | undefined) => (status && status in GEO_ARTICLE_STATUS_WORDS ? GEO_ARTICLE_STATUS_WORDS[status as keyof typeof GEO_ARTICLE_STATUS_WORDS] : null);

function OpportunityLinks({gaps,openPublication}:{gaps:NonNullable<GeoAnalysisRow['dimensions']['gaps']>;openPublication(version:string,pin:string):Promise<void>}) {
  return <Disclosure summary="依据、信源与内容关联">
    {(['evidence','source','content'] as const).map(kind=><div key={kind}>
      <p>{({evidence:'依据',source:'信源',content:'内容'})[kind]} · {gaps[kind].items.length} 个显式关联 · {gaps[kind].state==='no_explicit_links'?'尚无显式关联':gaps[kind].state==='unobservable'?'无法观测':'已关联'}</p>
      {gaps[kind].items.slice(0,10).map((item,index)=><div key={item.id??item.url??index}>
        {item.url?<a className="text-accent" href={item.url} target="_blank" rel="noreferrer">{item.url}</a>
          :kind==='content'&&item.resultVersionId&&item.digest?<Button size="sm" variant="text" onClick={()=>void openPublication(item.resultVersionId!,item.digest!)}>稿件 {index+1} · 查看发布版本{articleStateWord(item.status)?` · ${articleStateWord(item.status)}`:''}</Button>
          :kind==='evidence'?<Disclosure summary={`依据 ${index+1}${item.version!=null?` · 第 ${item.version} 版`:''}`}><p>{item.statement??'结论文字未提供'}</p><blockquote>{item.quote??'引文未提供'}</blockquote><p>来源：{item.sourceRef??'未提供'} · 核对时间：{item.verifiedAt??'未记录'}{item.status&&CLAIM_STATE_WORDS[item.status]?` · ${CLAIM_STATE_WORDS[item.status]}`:''}</p></Disclosure>
          :<p>稿件 {index+1}{articleStateWord(item.status)?` · ${articleStateWord(item.status)}`:''}</p>}
      </div>)}
    </div>)}
  </Disclosure>;
}
