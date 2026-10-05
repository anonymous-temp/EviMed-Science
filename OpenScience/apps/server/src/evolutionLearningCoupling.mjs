import { evolutionToolVisible } from '@evimed/domain';
/** Reuse existing owner handbooks. No personal method or source prose is copied to the platform. */
export function createEvolutionLearningCoupling({service,documents,database}) {
  const handbooks=async()=> (await database.query("SELECT user_id,id,payload,revision FROM evimed_product.documents WHERE kind='method' AND deleted_at IS NULL AND payload->>'recordType'='capability-handbook' AND payload->>'status'='active'")).rows;
  return {
    async scan() {
      for(const book of await handbooks()) {
        const runs=new Set((book.payload.observations??[]).filter(row=>row.used===true && row.gapCodes?.includes('method-missing')).map(row=>row.runId).filter(Boolean));
        if(runs.size>=2) await service.ingestEvent({id:`handbook-gap:${book.user_id}:${book.id}:${book.payload.contentDigest}`,type:'handbook-gap',userId:book.user_id,track:'M',gapCode:'method-missing',code:'method-missing'});
      }
      return this.refresh();
    },
    async refresh() {
      const tools=(await service.tools()).filter(row=>evolutionToolVisible(row.payload));
      for(const book of await handbooks()) {
        const references=tools.filter(row=>row.payload.capabilityIds?.includes(book.payload.capabilityId)).map(row=>({toolId:row.id,revision:row.payload.revision,digest:row.payload.artifactDigest,validationLevel:row.payload.validationLevel,origin:'tool-result'}));
        if(JSON.stringify(book.payload.platformToolReferences??[])===JSON.stringify(references))continue;
        await documents.put(book.user_id,'method',book.id,{...book.payload,platformToolReferences:references},{expectedRevision:book.revision,telemetry:true});
      }
      return {observed:tools.length};
    },
  };
}
