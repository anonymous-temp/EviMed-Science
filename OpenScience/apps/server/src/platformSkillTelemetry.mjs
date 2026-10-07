import {createHash} from 'node:crypto';
import { observedCall } from './runProgress.mjs';
import { evolutionResultEvidence } from './evolutionUsage.mjs';
const canonicalTool=value=>String(value??'').replace(/^mcp__evimed__/,'').split('/').at(-1);
/** Observe executed native tools against immutable platform revisions. Reads count as retrieval only.
 * No command, patient input or output is retained or sent to the maintenance ledger.
 * @param {any[]} pins @param {string} [scope] */
export function createPlatformSkillTelemetry(pins,scope=''){
  const identity=(kind,key,toolId)=>{const hex=createHash('sha256').update(JSON.stringify([scope,kind,key,toolId])).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;};
  pins=Array.isArray(pins)?pins:[];
  // No platform tool is mounted (the module is off, or nothing is published): there is nothing to observe, and every tool event of every
  // run would otherwise be copied, remembered for the life of the run and parsed a second time.
  if(!pins.length)return{observe:()=>[]};
  const readable=pins.filter(pin=>pin.id!=='platform-tool-search'),methods=readable.filter(pin=>pin.publicationKind==='skill'),calls=new Map(),opened=new Set(),completed=new Map(),emitted=new Set();
  return{observe(event){
    const key=String(event.callId??`seq:${event.seq}`);
    if(event.type==='tool/call'){
      if(calls.has(key))return[];
      const tool=canonicalTool(event.tool),input=event.input??{},targets=[],reads=[];
      const file=String(input.path??input.filePath??input.file_path??input.filename??'');
      const rootPattern=/^\/opt\/evimed\/(?:platform-skills|platform-skill-generations\/[a-f0-9]{64}\/skills)\//;
      if(['read','read_file','file_read'].includes(tool)&&rootPattern.test(file))for(const pin of readable)if(file.endsWith(`/${pin.nativeName}/SKILL.md`)||file.endsWith(`/${pin.nativeName}/INSTRUCTIONS.md`))reads.push(pin);
      const command=String(input.command??input.code??'');
      if(['evimed_exec','exec','shell','bash'].includes(tool))for(const pin of methods){
        const scripts=(pin.files??[]).map(item=>item.path).filter(path=>/^scripts\/[A-Za-z0-9_.-]+\.py$/.test(path));
        const invocation=command.trim().match(/^(?:python3?|uv run python3?)\s+(['"]?)((?:\/opt\/evimed\/(?:platform-skills|platform-skill-generations\/[a-f0-9]{64}\/skills)|\$EVIMED_PLATFORM_SKILLS_DIR)\/platform-[a-f0-9]{24}\/scripts\/[A-Za-z0-9_.-]+\.py)\1(?:\s|$)/);
        if(invocation&&scripts.some(path=>invocation[2].endsWith(`/${pin.nativeName}/${path}`)))targets.push(pin);
      }
      calls.set(key,{tool,targets,reads});return[];
    }
    if(event.type!=='tool/result'||emitted.has(key))return[];
    const call=calls.get(key);if(!call)return[];emitted.add(key);
    const ok=observedCall({tool:event.tool,status:event.status,output:event.output}).ok;
    if(ok===null)return[];
    const retrievals=ok?call.reads.map(pin=>{opened.add(pin.id);return{kind:'retrieval',toolId:pin.id,revision:pin.revision,digest:pin.digest,retrievalId:identity('retrieval',key,pin.id)};}):[];
    const targets=[...call.targets];
    for(const pin of methods){
      if(!opened.has(pin.id)||!pin.executionTools?.length||!pin.executionTools.map(canonicalTool).includes(call.tool))continue;
      if(!ok){targets.push(pin);completed.delete(pin.id);continue;}
      const seen=completed.get(pin.id)??new Set();seen.add(call.tool);completed.set(pin.id,seen);
      if(pin.executionTools.map(canonicalTool).every(tool=>seen.has(tool))){targets.push(pin);completed.delete(pin.id);opened.delete(pin.id);}
    }
    return [...retrievals,...[...new Map(targets.map(pin=>[pin.id,pin])).values()].map(pin=>({toolId:pin.id,revision:pin.revision,digest:pin.digest,callId:identity('execution',key,pin.id),result:ok?{ok:true}:{ok:false,code:'platform_skill_execution_failed'},resultEvidence:evolutionResultEvidence(event.output)}))];
  }};
}
