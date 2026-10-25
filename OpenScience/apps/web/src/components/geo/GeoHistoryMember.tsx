import {useState} from "react";
import {Link,useLocation} from "react-router";
import {Button} from "@/components/ui/Button";
import {FactList} from "@/components/ui/FactList";
import {geoSearchWithScope} from "@/lib/geoReadScope";
import {engineName} from "./geoText";
import {useGeoPath} from "./useGeoPath";

interface PreservedHistoryAnswer {
  snapshotId:string;
  preservedQuestion?:{text?:string};
  preservedAnswer?:{text?:string};
  facts?:{statements?:Array<{text:string;verdict?:string}>};
}
export interface GeoHistoryMemberItem {
  questionVersion?:number;
  receipt?:{kind?:string;snapshotId?:string;previousAssessmentVersion?:string|null;assessmentVersion?:string|null;claimVersion?:number|null;changedAt?:string;recordedAt?:string;previousStatus?:string};
  unit?:string;side?:string;preservedSelectionRef?:string|null;preservedQuestion?:{text?:string};preservedAnswer?:{text?:string};facts?:{statements?:Array<{text:string;verdict?:string}>};
  type?:string;label?:string|null;materialVersion?:string|number|null;preservedMemberLinks?:{before:number;after:number;targets:number};
  id:string;kind?:string;eventLabel?:string;title?:string|null;at?:string|null;recordedAt?:string|null;detectedAt?:string|null;
  currentStatus?:string|null;currentJudgmentState?:string|null;currentDisposition?:string|null;currentExecutionState?:string|null;
  executionState?:string;publicationBasis?:string;timeBasis?:string;signalId?:string;errorId?:string|null;fingerprint?:string|null;snapshotId?:string;
  orderId?:string|null;publicationId?:string;linkId?:string;resultVersionId?:string|null;digest?:string|null;basisDigest?:string;
  cohorts?:{before?:PreservedHistoryAnswer[];after?:PreservedHistoryAnswer[]};
  previousRoundId?:string;roundId?:string;before?:string|null;after?:string|null;
  beforeContract?:{samplingMode?:string;repeats?:number;engines?:string[]}|null;afterContract?:{samplingMode?:string;repeats?:number;engines?:string[]}|null;
  targets?:Array<{type:string;id:string;label?:string|null;version?:number|string|null}>;
}
const stateWords:Readonly<Record<string,string>>={open:"待处理",acting:"处理中",awaiting_remeasure:"等待再次观察",closed:"已关闭",active:"有效",withdrawn:"已撤回",ignored:"已忽略",pending:"待处理",started:"已开始",processing:"处理中",completed:"任务完成",failed_recoverable:"可继续处理",unknown:"未知"};

/** Historical material is rendered from this exact member response, not reloaded from current content. */
export function GeoHistoryMember({geoId,item,selectionRef,openPublication}:{geoId:string;item:GeoHistoryMemberItem;selectionRef?:string;openPublication?(version:string,digest:string):Promise<void>}) {
  const location=useLocation(),contextPath=useGeoPath();
  const link=(tab:string,selectors:Record<string,string>,exactQuestionVersion?:number)=>{
    const query=new URLSearchParams(geoSearchWithScope(location.search,exactQuestionVersion!=null?{questionVersion:exactQuestionVersion}:(item.preservedSelectionRef??selectionRef)?{selectionRef:item.preservedSelectionRef??selectionRef}:{}));
    for(const key of ["step","order","publication","signal","signals","action","error","view","diagnosisRound","cluster","session"])query.delete(key);
    for(const [key,value] of Object.entries(selectors))query.set(key,value);
    const destination=contextPath(`/app/geo/${encodeURIComponent(geoId)}/${tab}?${query}`);
    if(exactQuestionVersion==null)return destination;
    // The existing context helper retains a chat's session, but an exact historical version replaces its observation filters.
    const target=new URL(destination,"https://geo.invalid");
    return `${target.pathname}?${geoSearchWithScope(target.search,{questionVersion:exactQuestionVersion})}${target.hash}`;
  };
  const rows=[{label:"事件",value:item.eventLabel??"保留的业务记录"},{label:item.timeBasis==="user_reported_published_at"?"用户登记的发布时间":"发生时间",value:item.at??"未保留"}];
  if(item.recordedAt)rows.push({label:"平台记录时间",value:item.recordedAt});
  if(item.detectedAt)rows.push({label:"线索发现时间",value:item.detectedAt});
  if(item.currentStatus)rows.push({label:"当前问题处置",value:stateWords[item.currentStatus]??"未知"});
  if(item.currentJudgmentState)rows.push({label:"当前判定状态",value:stateWords[item.currentJudgmentState]??"未知"});
  if(item.currentDisposition)rows.push({label:"当前线索处置",value:stateWords[item.currentDisposition]??"未知"});
  if(["question_set_created","question_set_locked"].includes(item.kind??""))rows.push({label:"事件关联问题集",value:item.questionVersion==null?"版本未保留":`第 ${item.questionVersion} 版`});
  if(item.receipt){
    const historical=({legacy_identity_promoted:"历史错误记录已归并",legacy_identity_duplicate:"重复历史记录已归并",legacy_identity_unresolved:"历史记录身份仍待核对",assessment_correction:"原错误判定已修正",judgment_reactivated:"原错误判定重新生效",resolution_basis_withdrawn:"原关闭依据已撤回",assessment_superseded_unknown:"原判定被无法核实的结果替代",legacy_identity_residual_wrong:"按历史身份重新确认仍有错误",wrong_occurrence_time_unknown:"记录了发生时间未知的错误观察"} as Record<string,string>)[item.receipt.kind??""];
    rows.push({label:"当时记录的变化",value:historical??"保留了历史记录，未计为新的医学判定"});
    if(item.kind==="judgment_changed"){
      rows.push({label:"变更前判定版本",value:item.receipt.previousAssessmentVersion??"未保留"});
      rows.push({label:"变更后判定版本",value:item.receipt.assessmentVersion??"未保留"});
      rows.push({label:"当时主张版本",value:item.receipt.claimVersion==null?"未保留":String(item.receipt.claimVersion)});
    }
  }
  if(item.kind==="sampling_mode_changed"){
    const describe=(contract:GeoHistoryMemberItem["beforeContract"],surface:string|null|undefined)=>[
      ({one_shot:"单次采样",recurring:"重复采样"} as Record<string,string>)[contract?.samplingMode??""]??"采样约定未保留",
      contract?.repeats!=null?"每题 "+contract.repeats+" 次":null,
      surface==="web"?"网页端":surface==="raw"?"接口端":null,
      contract?.engines?.map(engineName).join("、")
    ].filter(Boolean).join(" · ");
    rows.push({label:"前一轮保留的约定",value:describe(item.beforeContract,item.before)});
    rows.push({label:"本轮保留的约定",value:describe(item.afterContract,item.after)});
  }
  if(item.preservedMemberLinks){
    if(item.preservedMemberLinks.before)rows.push({label:"变化前样本关联",value:String(item.preservedMemberLinks.before)});
    if(item.preservedMemberLinks.after)rows.push({label:"变化后样本关联",value:String(item.preservedMemberLinks.after)});
    if(item.preservedMemberLinks.targets)rows.push({label:"当时关联材料",value:String(item.preservedMemberLinks.targets)});
  }
  if(item.unit==="history_target_refs"){
    rows.push({label:"关联材料",value:item.label??({article:"内容",claim:"主张",finding:"发现"} as Record<string,string>)[item.type??""]??"保留材料"});
    rows.push({label:"当时版本",value:item.materialVersion==null?"未保留":String(item.materialVersion)});
  }
  const execution=item.currentExecutionState??item.executionState;
  if(execution)rows.push({label:"当前任务执行",value:stateWords[execution]??"未知"});
  return <article className="flex min-w-0 flex-col gap-2">
    {item.title&&<p className="text-ui">{item.title}</p>}
    <FactList rows={rows}/>
    {item.kind==="task_attempt"&&<p className="text-caption text-text-2">任务执行结果单独记录；是否仍有错误需查看后续观察。</p>}
    {item.kind==="sampling_mode_changed"&&<p className="text-caption text-text-2">标记使用本轮完成时间，表示两轮记录的采样约定不同；设置切换的准确时刻未单独记录。</p>}
    {item.kind==="sampling_mode_changed"&&item.roundId&&<Link className="text-accent" to={link("questions",{diagnosisRound:item.roundId})}>查看本轮采集设置与记录</Link>}
    {["question_set_created","question_set_locked"].includes(item.kind??"")&&item.questionVersion!=null&&<Link className="text-accent" to={link("questions",{},item.questionVersion)}>查看事件关联的问题集版本</Link>}
    {item.publicationBasis&&<p className="text-caption text-text-2">这是用户登记的线上版本，未由本分析核验外部页面。</p>}
    {item.resultVersionId&&item.digest&&openPublication&&<Button size="sm" variant="text" onClick={()=>void openPublication(item.resultVersionId!,item.digest!)}>打开事件关联的内容版本</Button>}
    {item.signalId&&<Link className="text-accent" to={link("overview",{signal:item.signalId})}>查看线索与处理记录</Link>}
    {item.errorId&&<Link className="text-accent" to={link("accuracy",{error:item.fingerprint?.trim()||item.errorId})}>查看此错误的当前处置</Link>}
    {item.snapshotId&&<Link className="text-accent" to={link("answers/"+encodeURIComponent(item.snapshotId),{})}>查看这次观察的原始回答</Link>}
    {item.orderId&&<Link className="text-accent" to={link("actions",{step:"distribution",order:item.orderId})}>查看事件关联订单</Link>}
    {(item.publicationId||item.linkId)&&<Link className="text-accent" to={link("actions",{step:"distribution",publication:item.publicationId??item.linkId!})}>查看登记发布的版本历史</Link>}
    {item.unit==="history_answer_refs"&&item.snapshotId&&<PreservedCohort label={item.side==="before"?"变化前保留的样本":"变化后保留的样本"} answers={[{snapshotId:item.snapshotId,preservedQuestion:item.preservedQuestion,preservedAnswer:item.preservedAnswer,facts:item.facts}]}/>}
    {item.cohorts&&(["before","after"] as const).map(side=><PreservedCohort key={item.id+":"+item.basisDigest+":"+side} label={side==="before"?"变化前保留的样本":"变化后保留的样本"} answers={item.cohorts?.[side]??[]}/>)}
    {!!item.targets?.length&&<PreservedTargets key={item.id+":"+item.basisDigest} targets={item.targets}/>}
  </article>;
}
function PreservedCohort({label,answers}:{label:string;answers:PreservedHistoryAnswer[]}) {
  const [offset,setOffset]=useState(0);
  return <section aria-label={label} className="flex flex-col gap-2"><p className="text-ui">{label} · {answers.length} 条</p>
    {answers.slice(offset,offset+20).map(answer=><details key={answer.snapshotId}><summary className="cursor-pointer text-ui">{answer.preservedQuestion?.text??"原始问题未保留"}</summary>
      <p className="whitespace-pre-wrap break-words text-ui">{answer.preservedAnswer?.text??"原始回答未保留"}</p>
      {answer.facts?.statements?.map((statement,index)=><p key={index} className="text-caption text-text-2">所存判定：{statement.text} · {({correct:"正确",wrong:"错误",unverifiable:"无法核实"} as Record<string,string>)[statement.verdict??""]??"未知"}</p>)}
    </details>)}
    {answers.length>20&&<div className="flex gap-2"><Button size="sm" variant="text" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>{label}上一页</Button><Button size="sm" variant="text" disabled={offset+20>=answers.length} onClick={()=>setOffset(offset+20)}>{label}下一页</Button></div>}
  </section>;
}
function PreservedTargets({targets}:{targets:NonNullable<GeoHistoryMemberItem["targets"]>}) {
  const [offset,setOffset]=useState(0);
  return <section aria-label="事件记录的关联材料" className="flex flex-col gap-2">
    <p className="text-ui">当时关联的材料 · {targets.length} 项</p>
    <ul>{targets.slice(offset,offset+20).map((target,index)=><li key={target.type+":"+target.id+":"+index} className="text-caption text-text-2">{target.label??({article:"内容",claim:"主张",finding:"发现"} as Record<string,string>)[target.type]??"关联材料"} · {target.version==null?"版本未保留":"版本 "+target.version}</li>)}</ul>
    {targets.length>20&&<div className="flex gap-2"><Button size="sm" variant="text" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>关联材料上一页</Button><Button size="sm" variant="text" disabled={offset+20>=targets.length} onClick={()=>setOffset(offset+20)}>关联材料下一页</Button></div>}
  </section>;
}
