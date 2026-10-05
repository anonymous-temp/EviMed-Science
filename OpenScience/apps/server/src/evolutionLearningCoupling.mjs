/**
 * What the learning loop hands to 循证进化: a closed gap code and an event identity, read from a researcher's
 * capability handbook and never written back to it. A handbook is the researcher's own document; the platform
 * does not add revisions to it or its own fields (the tools a capability has are the platform's catalogue,
 * which a run reads through the native skill mount for that capability).
 * No personal method or source prose is copied to the platform.
 * @param {{service:any,database:any}} dependencies
 */
export function createEvolutionLearningCoupling({service,database}) {
  const handbooks=async()=> (await database.query("SELECT user_id,id,payload FROM evimed_product.documents WHERE kind='method' AND deleted_at IS NULL AND payload->>'recordType'='capability-handbook' AND payload->>'status'='active'")).rows;
  return {
    async scan() {
      for(const book of await handbooks()) {
        const runs=new Set((book.payload.observations??[]).filter(row=>row.used===true && row.gapCodes?.includes('method-missing')).map(row=>row.runId).filter(Boolean));
        if(runs.size>=2) await service.ingestEvent({id:`handbook-gap:${book.user_id}:${book.id}:${book.payload.contentDigest}`,type:'handbook-gap',userId:book.user_id,track:'M',gapCode:'method-missing',code:'method-missing'});
      }
    },
  };
}
