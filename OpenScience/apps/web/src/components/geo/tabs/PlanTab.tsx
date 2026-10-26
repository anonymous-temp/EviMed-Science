import { GeoAnalysisWorkbench } from "../GeoAnalysisWorkbench";
import { ensureGeoConversationSession } from "../geoConversationSession";
import { GEO_ARTICLE_CHANNEL_LABELS_ZH } from "@evimed/domain";
import { useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { getGeoProject, stageGeoPlanContext, type GeoImplementationAction, type GeoStrategyView, type GeoProject } from "@/lib/geoClient";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Outline, useOutline } from "@/components/ui/Outline";
import { Disclosure } from "@/components/ui/Disclosure";
import { Note } from "@/components/ui/Note";
import { FactList } from "@/components/ui/FactList";
import { Section } from "@/components/ui/Section";
import { geoSessionIdFromChatPath } from "@/lib/geoLocation";
import { webErrorMessage } from "@/lib/apiClient";
import { layerName } from "../geoText";
import { geoMayConverse, useGeoFrame } from "../geoFrame";
import { useGeoStrategy } from "../geoProjectData";
import { useGeoDestinationPath } from "../useGeoPath";
import { useOpenGeoConversation } from "../useOpenGeoConversation";
import { TabError, TabSkeleton } from "./geoTabKit";
import { yuan } from "./geoTabText";
import { Assumptions, Battlefield, ClientToDos, EnginePromises, Targets } from "./PlanStrategy";

/** Shared contextual plan composition, including the legacy plan destination. */
export function PlanTab({ geoId, project, sourceId, sourceUrl, selectionRef, embedded = false }: { geoId: string; project: GeoProject; sourceId?: string; sourceUrl?:string; selectionRef?:string; embedded?:boolean }) {
  const planBody = useRef<HTMLDivElement>(null);
  const [params] = useSearchParams();
  const location = useLocation();
  const requestedVersion = Number(params.get("strategyVersion"));
  const options = { ...(selectionRef ? {selectionRef} : {}), ...(sourceUrl ? {url:sourceUrl} : {}), ...(sourceId ? { sourceId } : {}), ...(requestedVersion > 0 ? {strategyVersion: requestedVersion} : {}) };
  const { state, reload } = useGeoStrategy(geoId, options);
  const frame = useGeoFrame();
  const open = useOpenGeoConversation();
  const destination = useGeoDestinationPath();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState<{signature:string;key:string} | null>(null);
  const outline = useOutline(planBody, { idPrefix: `geo-plan-${geoId}`, refresh: [state] });
  if (state.kind === "loading") return <TabSkeleton rows={4} />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const plan = state.data;
  const mayConverse = geoMayConverse(project);
  const handoff = async (action?: GeoImplementationAction) => {
    setBusy(true); setError(null);
    try {
      const current = await getGeoProject(geoId);
      const sessionId = await ensureGeoConversationSession(geoId, project.projectId,
        geoSessionIdFromChatPath(location.pathname) || params.get("session") || current.sessionId || project.sessionId);
      const signature = JSON.stringify([sessionId,plan.selection?.reference,plan.version,sourceId,sourceUrl,action?.key]);
      const key = retryKey?.signature === signature ? retryKey.key : crypto.randomUUID(); setRetryKey({signature,key});
      const context = await stageGeoPlanContext(geoId, { requestKey: key, sessionId, mode: action ? "content" : "strategy",
        ...(action && plan.version != null ? { strategyVersion: plan.version, actionKeys: [action.key], ...(action.group?.id ? {groupIds:[action.group.id]} : {}) } : {}),
        ...(!action && plan.selection?.reference ? {selectionRef:plan.selection.reference} : {}), ...(sourceId ? {sourceId} : {}), ...(sourceUrl ? {url:sourceUrl} : {}) });
      if (await open({ projectId: project.projectId, geoId, sessionId: context.sessionId, geoPlanContext: {referenceId:context.referenceId} }, context.draft)) setRetryKey(null);
    } catch (cause) { setError(webErrorMessage(cause, {fallback:"方案暂时无法打开，请刷新后重试。"})); }
    finally { setBusy(false); }
  };
  return (
    <div ref={planBody} id="implementation-plan" data-geo-tab="plan" className="flex flex-col gap-10">
      <Outline entries={outline.entries} active={outline.active} onSelect={outline.select} layout="folded" label="方案目录" />
      <Section title="实施方案" toolbar={mayConverse ? <Button variant={!embedded && plan.version == null ? "primary" : "secondary"} disabled={busy} onClick={() => void handoff()}>{plan.version == null ? "生成方案" : "调整方案"}</Button> : undefined}>
        {error && <Note tone="warn" action={<Button variant="text" size="sm" onClick={reload}>刷新方案</Button>}>{error}</Note>}
        {plan.freshness?.status === "needs_update" && <Note tone="warn" action={<Button variant="text" size="sm" onClick={reload}>刷新方案</Button>}>所选资料或目标已变化，当前方案保留原有依据，可在对话中更新。</Note>}
        {plan.freshness?.status === "unknown" && <Note action={<Button variant="text" size="sm" onClick={reload}>刷新方案</Button>}>部分依据暂时无法核实；金额与工作量未估时保留为空。</Note>}
        {plan.version != null && <p className="text-caption text-text-3">方案版本 {plan.version} · 目标为规划值</p>}
        {plan.version == null && <Note action={<Button variant="text" size="sm" onClick={reload}>刷新方案</Button>}>根据当前诊断范围制定内容、渠道和工作顺序；尚无引用信源也可以制定方案。</Note>}
        <Link to={destination(geoId, {tab:"actions",section:"budget"})} className={buttonClasses({variant:"text",size:"sm",className:"self-start"})}>查看实际投放预算</Link>
        {plan.basis?.capturedAt && <FactList rows={[{label:plan.readingsKind === "submitted_input" ? "本次方案依据" : "方案依据日期",value:plan.basis.capturedAt.slice(0,10)}]} />}
        {plan.summary && <FactList rows={[{label:"方案摘要",value:plan.summary}]} />}
        {(plan.implementation?.actions ?? []).map(action => <div key={action.key} className="flex flex-col gap-2">
          <h3 className="text-ui font-semibold">{action.sequence != null ? `${action.sequence}. ` : ""}{action.what.title || action.need.judgment || "内容行动"}</h3>
          <Disclosure summary="时间、工作量与费用依据"><PlanActionFacts action={action} basis={plan.basis} /></Disclosure>
          <FactList rows={[
            ...(action.need.judgment ? [{label:"行动判断",value:action.need.judgment}] : []),
            ...action.sources.map(source => ({label: source.url && plan.basis?.focus.url === source.url ? "所选引用页面" : "可选渠道", value: <>{source.url || source.domain || source.name}{source.why ? ` · ${source.why}` : ""}</>})),
          ]} />

          {mayConverse && <Button variant="text" size="sm" className="self-start" disabled={busy || plan.version == null} onClick={() => void handoff(action)}>用于内容</Button>}
        </div>)}
      </Section>
      <GeoAnalysisWorkbench key={`frozen-plan:${plan.version??"none"}`} geoId={geoId} project={project} initialView="V26" title="方案目标与实测分析" initialDescriptor={{viewId:"V26",...(plan.version!=null?{strategyVersion:plan.version}:{})}} embedded/>
      <Targets geoId={geoId} plan={plan} onChosen={() => { reload(); frame?.data.invalidate(); }} />
      <Battlefield geoId={geoId} plan={plan} />
      <EnginePromises plan={plan} />
      <ClientToDos geoId={geoId} plan={plan} onChanged={reload} />
      <Assumptions project={project} plan={plan} />
    </div>
  );
}


function PlanActionFacts({action,basis}:{action:GeoImplementationAction;basis:GeoStrategyView["basis"]}) {
  const audiences:Record<string,string> = {patient:"患者",physician:"医生",caregiver:"照护者",pharmacist:"药师",institution:"机构",other:"其他"};
  const channel = action.what.channel ? (GEO_ARTICLE_CHANNEL_LABELS_ZH as Record<string,string>)[action.what.channel] : null;
  const timing = action.timing;
  const estimate = action.estimate;
  const effort = action.effort;
  const references = estimate?.basis.map(ref => {
    const source = basis?.priceReferences?.find(saved=>saved.id===ref.id);
    return [ref.kind === "source_price" ? "渠道价格" : "客户报价",source?.name || source?.domain || "已保存的报价资料"].join("：");
  }).join("；");
  return <FactList rows={[
    {label:"处理方式",value:action.work?.mode === "modify_existing" ? "修改已有内容" : action.work?.mode === "new" ? "新增内容" : "待明确"},
    {label:"对象与层次",value:[action.work?.audience ? audiences[action.work.audience] : null,layerName(action.what.layer),channel].filter(Boolean).join(" · ")},
    {label:"产出",value:action.work?.outputs?.join("、") || "产出待明确"},
    {label:"预计时间",value:timing ? <>{timing.durationDays ? `${timing.durationDays.low}–${timing.durationDays.high}天` : ""}{timing.earliest || timing.latest ? ` ${timing.earliest || "开始待定"} 至 ${timing.latest || "结束待定"}` : ""} · 依据：{timing.basis}</> : "时间未估"},
    {label:"预计工作量",value:effort ? <>{effort.low}–{effort.high}{effort.unit === "hours" ? "小时" : "天"} · 估计依据：{effort.basis}</> : "工作量未估"},
    {label:"预计费用",value:estimate ? <>{estimate.low.toLocaleString("zh-CN")}–{yuan(estimate.high)} · 费用依据：{references}{estimate.assumption ? ` · 假设：${estimate.assumption}` : ""}{estimate.observedAt ? ` · 报价日期：${estimate.observedAt.slice(0,10)}` : ""}</> : "金额未估"},
  ]} />;
}
