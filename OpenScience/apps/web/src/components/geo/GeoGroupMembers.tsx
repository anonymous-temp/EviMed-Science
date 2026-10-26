import {useState} from 'react';
import {getGeoSignalMembers} from '@/lib/geoSignalsClient';
import {Button} from '@/components/ui/Button';
import {LoadError} from '@/components/cards/LoadError';
import {useGeoLoad} from './geoProjectData';
import {engineName} from './geoText';

/** Frozen samples have their own pager; opening them never refreshes the live observation selection. */
export function GeoGroupMembers({geoId,signalId,side,basisDigest}:{geoId:string;signalId:string;side:'before'|'after';basisDigest:string}){
 const [offset,setOffset]=useState(0),label=side==='before'?'前次':'本次';
 const {state,reload}=useGeoLoad(`group-members:${geoId}:${signalId}:${basisDigest}:${side}:${offset}`,async()=>{
  const page=await getGeoSignalMembers(geoId,signalId,{side,offset,limit:20,expectedBasisDigest:basisDigest});
  if(page.side!==side||page.basisDigest!==basisDigest||!Number.isSafeInteger(page.total)||page.total<0||page.total>20000
   ||page.items.length!==Math.min(20,Math.max(0,page.total-offset))||page.more!==(offset+page.items.length<page.total)
   ||page.nextOffset!==(page.more?offset+page.items.length:null))throw new Error('Preserved sample page is inconsistent.');
  return page;
 });
 if(state.kind==='loading')return <p className="text-caption text-text-3">正在读取{label}已保留的样本…</p>;
 if(state.kind==='error')return <LoadError message={state.message} onRetry={reload}/>;
 const page=state.data;
 return <section aria-label={`${label}保留样本`} className="flex flex-col gap-2">
  <p className="text-caption text-text-3">共 {page.total} 条，显示 {page.items.length?offset+1:0}–{offset+page.items.length} 条。</p>
  {page.items.map((member,index)=><details key={member.snapshotId}>
   <summary className="text-ui text-link">{engineName(member.engine)} · 第 {offset+index+1} 条保留的回答</summary>
   <p className="whitespace-pre-wrap text-ui">{member.preservedQuestion?.text??"原始问题未保留"}</p>
   <p className="whitespace-pre-wrap text-ui text-text-2">{member.preservedAnswer?.text??'回答未保留'}</p>
   {member.facts?.statements?.map((statement,at)=><p key={at} className="text-caption text-text-2">{statement.text} · {({correct:'正确',wrong:'错误',unverifiable:'无法核实'} as Record<string,string>)[statement.verdict]??'判定未知'}</p>)}
  </details>)}
  <div className="flex gap-2"><Button size="sm" variant="text" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-20))}>{label}上一页</Button>
   <Button size="sm" variant="text" disabled={page.nextOffset===null} onClick={()=>{if(page.nextOffset!==null)setOffset(page.nextOffset);}}>{label}下一页</Button></div>
 </section>;
}
