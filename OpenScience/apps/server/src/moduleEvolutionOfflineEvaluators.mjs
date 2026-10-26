import {MODULE_RUNTIME_TASKS} from './moduleEvolutionRuntimeSession.mjs';
import {createHash} from 'node:crypto';
import {deriveDelimitedStructure, deriveMarkdownStructure} from '@evimed/domain';
import {claimVerification} from './clinicalEvidenceQuality.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const variants = items => items.flatMap(item=>[{...item,groupId:item.id},...(item.equivalentVariant ? [{...item,...item.equivalentVariant,id:`${item.id}:equivalent`,sourceHash:item.sourceHash,groupId:item.id,equivalentVariant:null}] : [])]);

/** Absolute checks call the existing source/claim implementations. Live DSH requires a real executor.
 * These wrappers neither import generated code nor read tenant stores.
 * @param {{sourceExecute?:any, runtimeSession?:any}} [dependencies] */
export function createModuleEvolutionOfflineEvaluators({sourceExecute,runtimeSession}={}) {
  /** @type {Record<string, any>} */
  const runners = {
    sources: async input => {
      const units=[];
      for(const item of variants(input.batch ?? [])) {
        const run=async()=>{
          const output=sourceExecute ? await sourceExecute(item,input) : item.format==='csv' ? deriveDelimitedStructure({text:item.sourceText,delimiter:item.delimiter ?? ','}) : deriveMarkdownStructure({text:item.sourceText});
          const cells=(output.tables ?? []).flatMap(table=>(table.cells ?? []).map(cell=>({address:cell.address ?? `${cell.r}:${cell.c}`,text:cell.t,value:cell.value ?? null})));
          if(!Array.isArray(item.expectedCells)||!item.expectedCells.length) return {id:item.id,groupId:item.groupId ?? item.id,score:0,sourceHash:item.sourceHash ?? hash(item.sourceText),executionInputHash:hash(item.sourceText),reason:'independent_reference_missing'};
          const matched=item.expectedCells.filter(expected=>cells.some(cell=>cell.text===expected.text && (!expected.address || cell.address===expected.address))).length;
          return {id:item.id,groupId:item.groupId ?? item.id,score:matched/item.expectedCells.length,sourceHash:item.sourceHash ?? hash(item.sourceText),executionInputHash:hash(item.sourceText),slices:{exactCells:matched,totalCells:item.expectedCells.length},contextBytes:Buffer.byteLength(item.sourceText)};
        };
        units.push(await (input.checkpointUnit ? input.checkpointUnit(item.id,run) : run()));
      }
      return {pool:input.pool,units,evaluatorVersion:'source-materials-absolute-v1',evidenceTier:'exact',deterministicChecksPassed:units.every(unit=>unit.score===1),costCny:0,contextBytes:units.reduce((n,u)=>n+(u.contextBytes??0),0)};
    },
    evidence: async input => {
      const units=[];
      for(const item of variants(input.batch ?? [])) {
        const run=async()=>{
          const result=claimVerification({matrix:item.matrix,sourceArtifacts:item.sourceArtifacts});
          const expected=item.expectedStatuses;
          const passed=Array.isArray(expected)&&expected.length>0&&JSON.stringify(result.claims.map(claim=>claim.status))===JSON.stringify(expected);
          return {id:item.id,groupId:item.groupId ?? item.id,score:Number(passed),sourceHash:item.sourceHash ?? hash(item.sourceArtifacts),executionInputHash:hash({matrix:item.matrix,sourceArtifacts:item.sourceArtifacts}),slices:{exactQuotes:passed},contextBytes:Buffer.byteLength(JSON.stringify(item.sourceArtifacts))};
        };
        units.push(await (input.checkpointUnit ? input.checkpointUnit(item.id,run) : run()));
      }
      return {pool:input.pool,units,evaluatorVersion:'claim-verification-absolute-v1',evidenceTier:'exact',deterministicChecksPassed:units.every(unit=>unit.score===1),costCny:0,contextBytes:units.reduce((n,u)=>n+u.contextBytes,0)};
    },
  };
  if(runtimeSession) runners.runtime=async input=>{
    const units=[];
    for(const item of variants(input.batch ?? MODULE_RUNTIME_TASKS)) {
      const run=async()=>{
        const measured=await runtimeSession({...input,item,nativeControlRequired:true});
        if(!measured.sessionId||!measured.kernelVersion||!Array.isArray(measured.turns)||measured.turns.length<2)throw new Error('Runtime evaluation requires a real measured multi-turn DSH session.');
        return {id:item.id,groupId:item.groupId ?? item.id,score:Number(measured.passed===true),sourceHash:item.sourceHash ?? hash(item),executionInputHash:hash(item.turns),sessionId:measured.sessionId,kernelVersion:measured.kernelVersion,latencyMs:measured.latencyMs,contextBytes:measured.contextBytes};
      };
      units.push(await (input.checkpointUnit ? input.checkpointUnit(item.id,run) : run()));
    }
    return {pool:input.pool,units,evaluatorVersion:'dsh-multiturn-v1',evidenceTier:'exact',deterministicChecksPassed:units.every(unit=>unit.score===1),contextBytes:null};
  };
  return runners;
}
