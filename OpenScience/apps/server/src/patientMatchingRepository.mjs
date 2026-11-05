/** Durable matching coordination keeps references only. Patient words and clinical decisions
 * live exclusively in the existing erasure-aware judgment/data stores. */
import { assertScope, profileIdentity } from '@evimed/patient-matching-core';
import { HttpError } from './security.mjs';

export const PATIENT_MATCHING_TASK_KIND = 'patient-matching-task';
export class PatientMatchingRepository {
  constructor(documents) { this.documents = documents; }
  async get(scope, taskId) {
    const row = await this.documents.get(scope.actorId, PATIENT_MATCHING_TASK_KIND, taskId);
    if (!row || row.projectId !== scope.projectId) throw new HttpError(404, 'patient_matching_task_not_found', 'Matching task was not found.');
    assertScope(scope, row.payload.scope);
    const payload=structuredClone(row.payload);
    const load=async refs => (await Promise.all(refs.map(async ref=>{
      const page=await this.documents.get(scope.actorId,PATIENT_MATCHING_TASK_KIND,ref);
      if(!page || page.projectId!==scope.projectId || page.payload.recordType!=='matching-reference-page' || page.payload.taskId!==taskId) throw new HttpError(409,'patient_matching_reference_unavailable','A matching scope reference is unavailable.');
      assertScope(scope,page.payload.scope); return page.payload.items;
    }))).flat();
    if(payload.selectedPairPages) payload.selectedPairs=await load(payload.selectedPairPages);
    if(payload.rowIdPages) payload.rowIds=await load(payload.rowIdPages);
    for(const version of payload.results??[]) if(version.rowIdPages)version.rowIds=await load(version.rowIdPages);
    for(const execution of payload.executions??[]) {
      if(execution.sourcePages)execution.sources=await load(execution.sourcePages);
      if(execution.pairPages)execution.pairs=await load(execution.pairPages);
    }
    return {...row,payload};
  }
  async put(scope, id, payload, revision = 0) {
    assertScope(scope, payload.scope);
    const stored=structuredClone(payload);
    async function persistPages(documents,items,field) {
      const refs=[];
      for(let offset=0;offset<items.length;offset+=256){
        const chunk=items.slice(offset,offset+256),ref=`${id}_ref_${profileIdentity({field,chunk}).slice(7,31)}`;
        if(!await documents.get(scope.actorId,PATIENT_MATCHING_TASK_KIND,ref)) {
          try{await documents.put(scope.actorId,PATIENT_MATCHING_TASK_KIND,ref,{recordType:'matching-reference-page',taskId:id,scope,field,index:offset/256,items:chunk},{expectedRevision:0,projectId:scope.projectId});}
          catch(error){if(error?.code!=='product_revision_conflict')throw error;}
        }
        refs.push(ref);
      }
      return refs;
    }
    stored.recordType='matching-task';
    stored.selectedPairPages=await persistPages(this.documents,stored.selectedPairs??[],'selectedPairs');delete stored.selectedPairs;
    stored.rowIdPages=await persistPages(this.documents,stored.rowIds??[],'rowIds');delete stored.rowIds;
    for(const version of stored.results??[]){version.rowIdPages=await persistPages(this.documents,version.rowIds??[],`result:${version.resultId}`);delete version.rowIds;delete version.sources;}
    for(const execution of stored.executions??[]){
      if(execution.state==='committed'){delete execution.sources;delete execution.pairs;delete execution.sourcePages;delete execution.pairPages;}
      else{
        execution.sourcePages=await persistPages(this.documents,execution.sources??[],`execution:${execution.executionId}:sources`);delete execution.sources;
        execution.pairPages=await persistPages(this.documents,execution.pairs??[],`execution:${execution.executionId}:pairs`);delete execution.pairs;
      }
    }
    await this.documents.put(scope.actorId, PATIENT_MATCHING_TASK_KIND, id, stored, { expectedRevision: revision, projectId: scope.projectId });
    return this.get(scope,id);
  }
}
