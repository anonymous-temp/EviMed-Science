/** Source-backed knowledge passages reuse immutable captures and the conversation's source selection. */
import {contentDigest,profileIdentity,sourceIdentity,verifyEvidencePassage} from '@evimed/patient-matching-core';
import {sourceOriginOf} from '@evimed/domain';
import {HttpError} from './security.mjs';
import {sourceReadable} from './sourceService.mjs';
import {chunkDocument} from './kbChunker.mjs';
import {searchTokens} from './searchTokens.mjs';
const fail=()=>new HttpError(409,'patient_matching_knowledge_changed','The selected knowledge source is unavailable or changed.');
/** @param {{sources:any,index:any,sourceScope:(origin:any)=>Promise<string[]|null>}} dependencies */
export function createPatientMatchingKnowledge({sources,index,sourceScope}){
  async function load(origin,id){
    const selected=await sourceScope(origin);if(selected&&!selected.includes(id))throw fail();
    const source=await sources.get(origin.userId,id);
    if(source.projectId!==origin.projectId||!sourceReadable(source.payload))throw fail();
    const kind=sourceOriginOf({connectorType:source.payload.connector?.type,path:source.payload.paths?.[0]});
    if(['wiki','database'].includes(kind))return {indexOnly:true};
    const capture=await sources.loadCapture(origin.userId,source);if(!capture?.input?.text)throw fail();
    const text=capture.input.text;
    return {text,pageMap:capture.pageMap,source:{sourceId:id,revision:`${source.payload.generation}:${source.payload.analysis.textSha256}`,digest:contentDigest(text),kind:'knowledge'}};
  }
  async function knowledge({origin,input}){
    if(!sources||!index)return {status:'unsupported',summary:'The knowledge source is not connected.',data:{passages:[],limitations:['Knowledge retrieval is unavailable.']},artifacts:[]};
    const limit=Math.min(20,Math.max(1,input.limit??8)),maxChars=input.maxChars??1800;
    if(!Number.isSafeInteger(maxChars)||maxChars<1||maxChars>12000||input.offset!=null&&(!Number.isSafeInteger(input.offset)||input.offset<0||!input.sourceId))throw fail();
    const query=String(input.query??'').trim();if(query.length>512)throw new HttpError(400,'patient_matching_knowledge_query_invalid','The evidence question is too long.');
    let candidates;
    if(input.sourceId)candidates=[{sourceId:input.sourceId}];
    else{if(!query)throw new HttpError(400,'patient_matching_knowledge_query_invalid','Supply an evidence question or source.');
      const selected=await sourceScope(origin),found=await index.search({userId:origin.userId,projectId:origin.projectId,query,limit,sourceIds:selected,includeLibrary:false});
      candidates=found.hits?.length?found.hits:found.files??[];}
    const windows=[],limitations=[],terms=searchTokens(query);
    for(const hit of candidates.slice(0,50)){
      if(hit.compiled===true){limitations.push('A compiled knowledge page is an index; retrieve its original documents for clinical evidence.');continue;}
      const current=await load(origin,hit.sourceId);
      if(current.indexOnly){limitations.push('This source is an index or controlled dataset; use its original evidence or patient-data tools.');continue;}
      let spans;
      if(input.offset!=null)spans=[{start:input.offset,end:Math.min(current.text.length,input.offset+maxChars)}];
      else if(Number.isSafeInteger(hit.start))spans=[{start:hit.start,end:Math.min(hit.end,hit.start+maxChars)}];
      else spans=chunkDocument({text:current.text,pageMap:current.pageMap}).map(chunk=>({start:chunk.start,end:Math.min(chunk.end,chunk.start+maxChars)}));
      for(const span of spans){
        if(span.start<0||span.end<=span.start||span.end>current.text.length)throw fail();
        const text=current.text.slice(span.start,span.end),lower=text.toLocaleLowerCase();
        windows.push({current,span,text,score:terms.filter(term=>lower.includes(term.toLocaleLowerCase())).length});
      }
    }
    windows.sort((a,b)=>b.score-a.score||a.span.start-b.span.start);
    const passages=[],nextRead=[];
    for(const window of windows.slice(0,limit)){
      const {current,span,text}=window,passage={evidenceId:`kb:${profileIdentity([current.source,span.start,span.end]).slice(7)}`,source:current.source,span,text};
      verifyEvidencePassage(passage,{source:current.source,sourceText:current.text});passages.push(passage);
      if(span.end<current.text.length)nextRead.push({taskId:input.taskId,source:'knowledge',action:'read',sourceId:current.source.sourceId,offset:span.end,maxChars});
    }
    if(candidates.length>50)limitations.push('The source-read budget covers the first 50 selected documents; narrow the source selection for the remaining documents.');
    if(query&&windows.length&&!windows[0].score)limitations.push('No lexical passage matched this question; use the source read cursor to inspect other sections.');
    if(!passages.length)limitations.push('No readable source-backed passage was found for this question.');
    return {status:limitations.length?'partial':'complete',summary:'Preserved knowledge passages retrieved.',data:{passages,nextRead,limitations:[...new Set(limitations)]},artifacts:[]};
  }
  knowledge.refresh=async({origin,passages})=>{
    const held=new Map();for(const passage of passages){if(!held.has(passage.source.sourceId))held.set(passage.source.sourceId,await load(origin,passage.source.sourceId));
      const current=held.get(passage.source.sourceId);if(current.indexOnly)throw fail();if(sourceIdentity(current.source)!==sourceIdentity(passage.source))throw fail();verifyEvidencePassage(passage,{source:current.source,sourceText:current.text});}
  };
  return knowledge;
}
