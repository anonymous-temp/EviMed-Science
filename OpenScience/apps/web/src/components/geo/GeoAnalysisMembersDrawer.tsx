import {GeoHistoryMember} from "./GeoHistoryMember";
import { OriginalJudgment, genericMentionsText } from "./GeoJudgmentView";
import { GeoFinanceMember } from "./GeoFinanceMember";
import { useOpenPublication } from "./spine/useOpenPublication";
import { useState } from "react";
import { Link, useLocation } from "react-router";
import {
  getGeoAnalysisMembers,
  type GeoAnalysisMembers,
  type GeoAnalysisMemberItem,
} from "@/lib/geoAnalysisClient";
import type { GeoProject } from "@/lib/geoClient";
import { SourceRelationship } from "./tabs/SourceRelationship";
import { GEO_SOURCE_RELATIONSHIP_LABELS_ZH, GEO_ARTICLE_CHANNEL_LABELS_ZH, GEO_OWNED_LINK_PLATFORM_LABELS_ZH } from "@evimed/domain";
import { geoSearchWithScope } from "@/lib/geoReadScope";
import { FactList } from "@/components/ui/FactList";
import { EmptyState } from "@/components/cards/EmptyState";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { Disclosure } from "@/components/ui/Disclosure";
import { useGeoLoad } from "./geoProjectData";
import { useGeoFrame } from "./geoFrame";
import { answerPath, severityWord, surfaceText, SNAPSHOT_STATUS_WORDS } from "./tabs/geoTabText";
import { useGeoPath } from "./useGeoPath";
import { engineName, claimConditionsText, GEO_ERROR_STATUS_WORDS, GEO_ERROR_TYPE_WORDS } from "./geoText";
const units: Record<string, string> = {
  business_events:"业务事件",history_answer_refs:"保留的样本关联",history_target_refs:"当时关联材料",ledger_entries:"账目记录",ledger_balance_readings:"项目余额读数",target_rows:"方案目标",frozen_metric_readings:"方案冻结实测",
  article_formats: "内容与文件格式配对", orders: "投放订单", order_events: "订单事件",
  error_records: "错误记录",
  statement_assessments: "陈述判定", finding_observations: "发现表达",
  claims: "结论", findings: "发现", articles: "内容", result_versions: "内容版本", publications: "发布记录", distinct_answered_questions: "已回答问题",
  answers: "回答",
  asks: "采集任务",
  questions: "问题",
  statements: "陈述",
  expressions: "表达",
  records: "记录",
  source_pairs: "回答与页面配对",
  source_pages: "页面",
  rounds: "轮次",
  observations: "观察",
};
/** What a sampled answer or a collection task is called by its state; a state nobody named is not printed. */
const MEMBER_STATUS_WORDS: Record<string, string> = {
  ...SNAPSHOT_STATUS_WORDS,
  queued: "等待采集",
  leased: "正在采集",
  done: "采集完成",
  skipped: "已跳过",
};

export function GeoAnalysisMembersDrawer({
  geoId,
  project,
  members,
  onClose,
}: {
  geoId: string;
  project?: GeoProject;
  members: GeoAnalysisMembers;
  onClose(): void;
}) {
  const openPublication = useOpenPublication(project ?? {projectId:""} as GeoProject);
  const frame = useGeoFrame(),
    [pagination,setPagination] = useState({key:"",offset:0});
  const originKey=JSON.stringify(members),[related,setRelated]=useState<{originKey:string;members:GeoAnalysisMembers}|null>(null);
  const activeMembers=related?.originKey===originKey?related.members:members;
  const memberKey=JSON.stringify(activeMembers),offset=pagination.key===memberKey?pagination.offset:0;
  const setOffset=(next:number)=>setPagination({key:memberKey,offset:next});
  const showVersions=(total:number)=>{setOffset(0);setRelated({originKey,members:{...activeMembers,columnKey:"resultVersions",unit:"result_versions",total}});};
  const { state, reload } = useGeoLoad(
    `analysis-members:${geoId}:${JSON.stringify(activeMembers)}:${offset}`,
    () => getGeoAnalysisMembers(geoId, activeMembers, offset),
  );
  const refresh = () => {
    frame?.refreshScope?.();
    onClose();
  };
  return (
    <Drawer title={`${units[activeMembers.unit] ?? "记录"}明细`} onClose={onClose}>
      {state.kind === "loading" ? (
        <FilesSkeleton />
      ) : state.kind === "error" ? (
        state.stale ? (
          <Note
            tone="warn"
            action={
              <Button size="sm" variant="secondary" onClick={refresh}>
                更新分析
              </Button>
            }
          >
            这批数据已有更新，请重新查看分析。
          </Note>
        ) : (
          <LoadError message={state.message} onRetry={reload} />
        )
      ) : (
        <div className="flex flex-col gap-4">
          {activeMembers!==members&&<Button size="sm" variant="text" onClick={()=>{setOffset(0);setRelated(null);}}>返回内容明细</Button>}
          <Note
            result={[
              "共 ",
              { n: state.data.total },
              ` 个${units[state.data.unit] ?? "记录"}，显示 `,
              { n: offset + 1 },
              " 至 ",
              { n: offset + state.data.items.length },
              " 个。",
            ]}
          />
          {state.data.items.length ? (
            state.data.items.map((item) => (
              <Member key={item.id} publicationContext={["V23","V24"].includes(activeMembers.view.viewId)} onShowVersions={showVersions} openPublication={project?openPublication:undefined} canEdit={!!project&&(!project.access||project.access.abilities.includes("edit"))} geoId={geoId} item={item} selectionRef={["V13","V15","V27","V16","V17","V18","V19","V22","V23","V24","V25","V26"].includes(activeMembers.view.viewId)||item.source||item.citingAnswers?activeMembers.selectionRef:undefined} />
            ))
          ) : (
            <EmptyState title="这个分类没有记录" />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一批
            </Button>
            {state.data.nextOffset !== null && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setOffset(state.data.nextOffset!)}
              >
                下一批
              </Button>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
function Member({
  publicationContext=false,
  onShowVersions,
  geoId,
  item,
  selectionRef,
  canEdit,
  openPublication,
}: {
  geoId: string;
  item: GeoAnalysisMemberItem;
  publicationContext?: boolean;
  onShowVersions?(total:number):void;
  selectionRef?: string;
  canEdit: boolean;
  openPublication?(version:string,digest:string):Promise<void>;
}) {
  const contextPath = useGeoPath();
  const location = useLocation(),
    question = item.question ?? item;
  const evidenceQuery=new URLSearchParams(location.search);evidenceQuery.delete("view");
  if(selectionRef)evidenceQuery.set("selectionRef",selectionRef);
  const evidenceReason = ({ source_update_needed: "来源已有变更，需更新依据", exact_card_revision_unavailable: "历史证据卡版本不可用",
    exact_claim_quote_unavailable: "缺少精确结论与引文关联", exact_source_identity_unavailable: "原始来源关联不明", source_unavailable: "来源原文不可用",
    quote_not_found: "引文未在所存原文中找到", no_quote: "未保留引文", author_excerpt_only: "仅有作者提供的摘录", claim_inactive: "结论当前不活跃",
    claim_expired: "结论适用期已过", claim_expiry_unknown: "结论适用期尚无法核实", card_withdrawn: "证据卡已撤回", preserved_claim_unavailable: "当时的结论依据未保留" } as Record<string,string>)[item.reason ?? ""];
  const changeWord = (kind: string) => ({ retraction: "撤稿", retracted: "撤稿", correction: "更正", corrected: "更正", concern: "关注声明", expression_of_concern: "关注声明", withdrawal: "撤回", update: "更新" } as Record<string,string>)[kind] ?? "来源变更";
  if(["business_events","history_answer_refs","history_target_refs"].includes(item.unit))return <GeoHistoryMember geoId={geoId} item={item} selectionRef={selectionRef} openPublication={openPublication}/>;
  if(["ledger_entries","ledger_balance_readings","target_rows","frozen_metric_readings"].includes(item.unit))return <GeoFinanceMember geoId={geoId} item={item} selectionRef={selectionRef}/>;
  if(publicationContext&&["articles","result_versions","article_formats","publications","orders","order_events"].includes(item.unit)){
    const url=item.url??item.publishedUrl;
    const orderId=item.orderId??(item.unit==="orders"?item.objectId:null);
    const contentQuery=new URLSearchParams(geoSearchWithScope(location.search,selectionRef?{selectionRef}:{}));
    contentQuery.set("step","content");for(const key of ["order","publication","action"])contentQuery.delete(key);
    const orderQuery=new URLSearchParams(geoSearchWithScope(location.search,selectionRef?{selectionRef}:{}));for(const key of ["publication","action"])orderQuery.delete(key);if(orderId){orderQuery.set("order",orderId);orderQuery.set("step","distribution");}
    const publicationQuery=new URLSearchParams(geoSearchWithScope(location.search,selectionRef?{selectionRef}:{}));for(const key of ["order","action"])publicationQuery.delete(key);if(item.objectId){publicationQuery.set("publication",item.objectId);publicationQuery.set("step","distribution");}
    return <article className="flex flex-col gap-2">
      <p className="text-ui">{item.title??({orders:"投放订单",order_events:"订单事件",publications:"登记发布",result_versions:"保留的内容版本",article_formats:"内容与文件格式"} as Record<string,string>)[item.unit]??"内容"}</p>
      <FactList rows={[
        {label:"关联依据",value:item.pinState==="exact"?"已匹配当时版本":item.pinState==="unknown"?"当时版本关联未知":item.temporalBasis==="current_unversioned_draft"?"当前未形成版本的草稿":"本范围保留的版本记录"},
        ...(item.format?[{label:"文件格式",value:item.format==="unknown"?"未知":item.format}]:[]),...(item.resultVersionCount!=null?[{label:"所选范围的内容版本",value:item.resultVersionCount}]:[]),
        ...(item.stateLabel?[{label:"当前记录状态",value:item.stateLabel}]:[]),...(item.unit==="order_events"?[{label:"事件",value:item.eventLabel??`${item.fromStateLabel??"未知"} → ${item.toStateLabel??"未知"}`}]:[]),
        ...(item.association?.channel?[{label:"版本中的预期渠道",value:(GEO_ARTICLE_CHANNEL_LABELS_ZH as Record<string,string>)[item.association.channel]??"未分类"}]:[]),...(item.platform||item.domain?[{label:"实际登记平台或域名",value:item.platform?((GEO_OWNED_LINK_PLATFORM_LABELS_ZH as Record<string,string>)[item.platform]??item.platform):item.domain!}]:[]),
        ...(item.at!==undefined?[{label:item.timeBasis==="user_reported_published_at"?"用户登记的发布时间":item.timeBasis==="order_created_at"?"订单创建时间":"记录时间",value:item.at??"未知"}]:[]),
        ...(item.publicationBasis==="user_reported"?[{label:"发布依据",value:"用户登记；未核对外部页面"}]:[])
      ]}/>
      {item.resultVersionCount!=null&&item.resultVersionCount>0&&item.rowResultVersionCount!=null&&onShowVersions&&<Button size="sm" variant="text" onClick={()=>onShowVersions(item.rowResultVersionCount!)}>查看本行内容版本明细</Button>}
      {item.resultVersionId&&item.digest&&openPublication&&<Button size="sm" variant="text" onClick={()=>void openPublication(item.resultVersionId!,item.digest!)}>打开当时内容版本</Button>}
      {url&&safeCitationUrl(url)&&<a className="text-accent" href={url} target="_blank" rel="noreferrer">查看发布页面</a>}
      {item.unit==="publications"&&item.objectId&&<Link className="text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/actions?${publicationQuery}#geo-distribution`)}>查看发布记录与更新登记</Link>}
      {orderId&&<Link className="text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/actions?${orderQuery}#geo-distribution`)}>查看订单与可执行操作</Link>}
      <Link className="text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/actions?${contentQuery}`)}>查看内容与版本</Link>
    </article>;
  }
  if(item.unit==="error_records"){
    const query=new URLSearchParams({error:item.fingerprint?.trim()||item.claimId?.trim()||item.id.trim()});if(selectionRef)query.set("selectionRef",selectionRef);
    return <article className="flex flex-col gap-2">
      <p className="text-ui">{item.errorStatement??"原始说法未保留"}</p>
      <FactList rows={[{label:"平台",value:engineName(item.engine??"")},{label:"错误类型",value:(GEO_ERROR_TYPE_WORDS as Record<string,string>)[item.errorType??""]??"未知"},
        {label:"严重程度",value:severityWord(item.severity)??"未知"},{label:"判定状态",value:item.judgmentState==="active"?"有效判定":item.judgmentState==="withdrawn"?"判定已撤回":"未知"},
        {label:"当前处置状态",value:(GEO_ERROR_STATUS_WORDS as Record<string,string>)[item.status??""]??"未知"},
        {label:"最初判定适用条件",value:claimConditionsText(item.applicability)},{label:"最初判定结论版本",value:item.claimVersion??"未知"},
        {label:"所选关联回答时间",value:item.askedAt??"未知"},{label:"依据原文",value:item.evidenceQuote??"未保留"}]}/>
      {item.currentClaim&&<Disclosure summary="当前结论信息"><FactList rows={[{label:"当前结论版本",value:item.currentClaim.version??"未知"},{label:"当前适用条件",value:claimConditionsText(item.currentClaim.applicability)}]}/></Disclosure>}
      <Link className="text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/accuracy?${query}`)}>查看说法的处置与历史</Link>
      {item.snapshotId&&<Link className="text-accent" to={contextPath(`${answerPath(geoId,item.snapshotId)}${selectionRef?`?${geoSearchWithScope(location.search,{selectionRef})}`:location.search}`)}>查看所选关联回答</Link>}
    </article>;
  }
  if (["claims","findings","articles","result_versions","publications","statement_assessments","finding_observations"].includes(item.unit)) return <article className="flex flex-col gap-2">
    <p className="text-ui">{item.claimStatement??item.finding?.statement??item.title??item.statement?.text??({claims:"关联结论",findings:"关联发现",articles:"关联内容",result_versions:"内容版本",publications:"发布记录",finding_observations:"原始发现定义未保留",statement_assessments:"结论依据未保留"} as Record<string,string>)[item.unit]}</p>
    <FactList rows={[{label:item.unit==="finding_observations"?"记录口径":"依据状态",value:item.unit==="finding_observations"?"回答对指定发现的表达；不代表医学来源核实":item.verification==="verified_preserved_quote"?"原文已核实；来源变更另行保留":item.reason === "source_update_needed" ? "来源已有变更，原文核实记录保留" : item.pinState==="exact"?"已匹配当时内容版本":item.pinState==="unknown"?"当时内容版本未知":"已关联、尚未核实"},
      ...(evidenceReason?[{label:"核实说明",value:evidenceReason}]:[]),
      ...(item.preservedQuoteVerification?.status === "verified" ? [{label:"原文核实记录",value:"所存历史原文已核实"}]:[]),
      ...(item.version != null || item.claimVersion != null ? [{label:"结论版本",value:item.version??item.claimVersion??"未知"}]:[]),...(item.quote?[{label:item.unit==="finding_observations"?"回答中的原文":"依据原文",value:item.quote}]:[]),...(item.sourceRef?[{label:"原始来源",value:item.sourceRef}]:[])]}/>
    {item.unit === "statement_assessments" && <FactList rows={[{label:"回答陈述",value:item.statement?.text??"未保留"},
      {label:"所存判定",value:({correct:"正确",wrong:"错误",unverifiable:"无法核实"} as Record<string,string>)[item.statement?.verdict??""]??"未知"},
      {label:"适用条件",value:claimConditionsText(item.applicability??item.statement?.applicability)},
      {label:"证据卡版本",value:item.cardRevision??"未知"},{label:"判定来源",value:item.temporalBasis==="current_assessment_of_selected_answer"?"当前对历史回答的判定":"已保存判定"},
      {label:"判定状态",value:({active:"有效",invalidated:"已失效",suspended:"暂停使用",excluded:"已排除",unrecorded:"历史状态未单独记录"} as Record<string,string>)[item.assessmentState??""]??"未知"},
      ...(item.assessmentReason?[{label:"判定限制",value:item.assessmentReason==="sample_not_returned"?"这次采样未取得可用回答":"未保留有效判定时间，不能计为已核实一致或冲突"}]:[]),
      {label:"采样时间",value:item.askedAt??"未知"},{label:"判定时间",value:item.judgedAt??"未知"}]}/>}
    {item.unit === "statement_assessments" && item.originalAssessment && <Disclosure summary="本回答首次保存的判定">
      <FactList rows={[{label:"首次判定时间",value:item.originalAssessment.assessment.judgedAt??"未知"}]}/>
      {item.originalAssessment.assessment.statements?.map((statement,index)=><FactList key={index} rows={[
        {label:"原始陈述",value:statement.text??"未保留"},
        {label:"首次判定",value:({correct:"正确",wrong:"错误",unverifiable:"无法核实"} as Record<string,string>)[statement.verdict??""]??"未知"},
        {label:"原始适用条件",value:claimConditionsText(statement.applicability)},
      ]}/>)}
    </Disclosure>}
    {item.unit === "finding_observations" && <FactList rows={[{label:"发现版本",value:item.basisVersion??"未知"},
      {label:"表达状态",value:({represented:"完整表达",partial:"部分表达",contradicted:"相反表达",not_addressed:"完整判定中未表达",not_applicable:"完整判定中不适用",uncertain:"尚无法确定"} as Record<string,string>)[item.status??""]??"未知"},
      {label:"判定覆盖",value:item.judgementCoverage?.status==="complete"?"完整":item.judgementCoverage?.status==="partial"?"部分":"未知"},
      {label:"采样时间",value:item.askedAt??"未知"},{label:"判定时间",value:item.judgedAt??"未知"}]}/>}
    {!!item.sourceChanges?.length && <p className="text-caption text-text-3">当前记录的来源变更</p>}
    {item.sourceChanges?.map((source, index) => <div key={`${source.identifier}:${index}`} className="flex flex-col gap-2">
      <FactList rows={[{label:"来源标识",value:source.identifier},{label:"最近检查时间",value:source.checkedAt??"未记录"}]}/>
      {source.changes.map((change, changeIndex) => <FactList key={changeIndex} rows={[{label:"变更类型",value:changeWord(change.kind)},
        {label:"来源通知日期",value:change.date??"未记录"},{label:"平台记录时间",value:change.recordedAt??"未记录"},
        ...(change.noticeIdentifier ? [{label:"通知标识",value:change.noticeIdentifier}]:[])]}/>)}
    </div>)}
    {item.sourcePublicationStatus?.kind && <FactList rows={[{label:"原始来源状态",value:changeWord(item.sourcePublicationStatus.kind)},
      ...(item.sourcePublicationStatus.notices??[]).map(notice=>({label:"来源通知标识",value:notice}))]}/>}
    {item.resultVersionId&&item.digest&&openPublication&&<Button size="sm" variant="text" onClick={()=>void openPublication(item.resultVersionId!,item.digest!)}>打开当时内容版本</Button>}
    {item.url&&safeCitationUrl(item.url)&&<a className="text-accent" href={item.url} target="_blank" rel="noreferrer">查看发布页面</a>}
    {item.snapshotId && <Link className="text-accent" to={contextPath(`${answerPath(geoId,item.snapshotId)}${selectionRef?`?${geoSearchWithScope(location.search,{selectionRef})}`:location.search}`)}>查看原始回答与依据</Link>}
    <Link className="text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/${["claims","findings","statement_assessments","finding_observations"].includes(item.unit)?`evidence${evidenceQuery.size?`?${evidenceQuery}`:""}`:`content${location.search}`}`)}>{["claims","findings","statement_assessments","finding_observations"].includes(item.unit)?"查看证据与关联":"查看内容与版本"}</Link>
  </article>;
  return (
    <article className="flex flex-col gap-2">
      <p className="text-ui">
        {item.expression?.quote ?? item.statement?.text ?? question.text ?? "采集任务"}
      </p>
      <p className="text-caption text-text-3">
        {[
          item.engine ? engineName(item.engine) : null,
          item.repeatIndex != null ? `第 ${item.repeatIndex + 1} 次` : null,
          item.askedAt ?? item.answer?.asked_at ?? "采样时间未知",
          item.status ? MEMBER_STATUS_WORDS[item.status] : null,
          ({ sampling_plan_unknown:"缺少完整采集计划", sampling_plan_incomplete:"采集计划缺少重复任务", scheduled_observation_missing:"计划中的重复采集尚无回答", sampling_scope_incomplete:"重复回答未完整落入所选范围" } as Record<string,string>)[item.reason??""],
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {(question.originalId != null || question.originalRow != null) && (
        <FactList
          rows={[
            { label: "原始编号", value: question.originalId ?? "未记录" },
            { label: "原始行", value: question.originalRow ?? "未记录" },
            { label: "原分类", value: question.originalGroup ?? "未分类" },
            {
              label: "客户标签",
              value: question.clientTags?.join("、") || "未标注",
            },
          ]}
        />
      )}
      {item.source && <Disclosure summary="完整来源页面与原始地址"><Note action={null}>错误与品牌提及仅表示共同出现，不能据此推断来源导致错误。部分判定保留原判定状态。</Note>{item.source.pages.map(page=><article key={page.sourceKey}><p className="text-caption text-text-2">{page.sourceKey}</p>{page.originalUrls.map(url=><a key={url} className="block text-accent" href={safeCitationUrl(url)?url:undefined} target="_blank" rel="noreferrer">{url}</a>)}{page.annotations?.length ? <SourceAnnotations geoId={geoId} annotations={page.annotations} canEdit={canEdit}/> : null}{page.preservedCitations?.map((citation,index)=><p key={index} className="text-caption text-text-2">{citation.marker!=null?`引用标记：${String(citation.marker)}`:""}{citation.position!=null?` · 保留位置：${String(citation.position)}`:""}</p>)}</article>)}</Disclosure>}
      {!!item.judgment && <Disclosure summary="原始判定"><OriginalJudgment judgment={item.judgment}/></Disclosure>}
      {item.citingAnswers?.map(answer=><Member key={answer.id} canEdit={canEdit} geoId={geoId} item={answer} selectionRef={selectionRef}/>)}
      {item.extraction && <Disclosure summary="实体提取依据"><FactList rows={[{label:"提取时间",value:item.extraction.judgedAt ?? "未知"},{label:"通用名提及",value:genericMentionsText(item.extraction.genericMentions)}]} /></Disclosure>}
      {item.expression && <FactList rows={[
        {label:"表达对象",value:item.expression.entity ?? "对象未保留"},
        {label:"分类",value:({recommended:"推荐",conditional:"条件性推荐",reasonable_nonrecommendation:"合理不推荐",mention_only:"仅提及",unknown:"尚未分类"} as Record<string,string>)[item.expression.state] ?? "未知"},
        {label:"原文条件",value:item.expression.conditionQuote ?? "未陈述"},
        {label:"分类说明",value:item.expression.rationale ?? "未记录"},
        {label:"明确推荐顺位",value:item.expression.explicitPosition ?? "未明确"},
        {label:"顺位原文",value:item.expression.positionQuote ?? "未陈述"},
        ...(item.expression.nonrecommendationBasis ? [
          {label:"不推荐的依据原文",value:item.expression.nonrecommendationBasis.evidenceQuote},
          {label:"条件的依据原文",value:item.expression.nonrecommendationBasis.evidenceConditionQuote ?? "未陈述"},
        ] : []),
        {label:"结论版本",value:item.expression.claimRefs.map(ref=>`第 ${ref.claimVersion} 版`).join("；") || "未提供"},
      ]} />}
      {item.statement && (
        <FactList
          rows={[
            {
              label: "判定",
              value:
                (
                  {
                    correct: "正确",
                    wrong: "错误",
                    unverifiable: "无法核实",
                  } as Record<string, string>
                )[item.statement.verdict] ?? "未知",
            },
            { label: "结论版本", value: item.statement.claimVersion ?? "未知" },
            {
              label: "临床条件",
              value: claimConditionsText(item.statement.applicability),
            },
            { label: "引文依据", value: item.statement.evidence ?? "未保留" },
          ]}
        />
      )}
      {item.unit === "asks" && item.roundId && (
        <Link
          className="text-accent"
          to={contextPath(
            `/app/geo/${encodeURIComponent(geoId)}/questions?diagnosisRound=${encodeURIComponent(item.roundId)}`,
          )}
        >
          查看采集进度与恢复选项
        </Link>
      )}
      {item.snapshotId && (
        <Link
          className="text-accent"
          to={`${answerPath(geoId, item.snapshotId)}${selectionRef?`?${geoSearchWithScope(location.search,{selectionRef})}`:location.search}`}
        >
          查看原始回答与依据
        </Link>
      )}
      {item.snapshotId && item.assessmentVersion && <Link className="text-accent" to={(() => {const query=new URLSearchParams(location.search);query.set("assessmentVersion",item.assessmentVersion!);return `${answerPath(geoId,item.snapshotId!)}?${query}#geo-judgment-history`;})()}>查看这条表达的判定历史</Link>}
      {item.answer && (
        <Disclosure summary="完整回答与引用">
          <p className="whitespace-pre-wrap text-ui">
            {item.answer.answer_text}
          </p>
          <FactList
            rows={[
              { label: "采样方式", value: surfaceText(item.answer.surface as Record<string, unknown> | null | undefined) ?? "未记录" },
            ]}
          />
          {item.answer.citations?.map((citation, index) =>
            safeCitationUrl(citation.url) ? (
              <a
                key={index}
                className="block text-accent"
                href={citation.url}
                target="_blank"
                rel="noreferrer"
              >
                {citation.url}
              </a>
            ) : null,
          )}
        </Disclosure>
      )}
    </article>
  );
}

function safeCitationUrl(value: string | undefined) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function SourceAnnotations({geoId,annotations,canEdit}:{geoId:string;annotations:NonNullable<GeoAnalysisMemberItem['source']>['pages'][number]['annotations'];canEdit:boolean}) {
  const [url,setUrl]=useState<string|null>(null);
  return <section aria-label="精确信源关系注释">
    {annotations?.map(annotation=><div key={annotation.url}>
      <p>{GEO_SOURCE_RELATIONSHIP_LABELS_ZH[annotation.relation as keyof typeof GEO_SOURCE_RELATIONSHIP_LABELS_ZH]??'未确认'} · {annotation.origin==='page'?'精确页面':annotation.origin==='domain'?'域名标记':'未标记'}</p>
      <p>{annotation.reference?.id??'没有注释记录'} · 修订 {annotation.reference?.revision??'未知'} · 注释日期 {annotation.reviewedAt??'未记录'}</p>
      <Button size="sm" variant="text" onClick={()=>setUrl(annotation.url)}>查看或修改此页面关系</Button>
    </div>)}
    {url&&<SourceRelationship geoId={geoId} target={{kind:'page',value:url}} canEdit={canEdit}/>}
  </section>;
}
