import { createHash } from "node:crypto";

/** Frozen public snapshots come from the preservation gateway; extraction has a separate identity from proposal.
 * Missing preservation or source-root/date proofs produce no confirmation task.
 * @param {{taskPool:any, readSnapshots:(input:any)=>Promise<any[]>, extractTask:(input:any)=>Promise<any>, now?:()=>Date}} dependencies */
export function createModuleEvolutionCurator({ taskPool, readSnapshots, extractTask, now = () => new Date() }) {
  return {
    /** @param {{moduleId:string, candidate:any, modelReleasedAt:string, epoch:string, exposedSourceRoots?:string[], pool?:string, quarter?:string}} input */
    async curate(input) {
      if (!["frontier", "geo", "autopilot"].includes(input.moduleId)) return {status:"unavailable",reason:"curator_module_unavailable",added:0};
      const boundary = Math.max(Date.parse(input.candidate.frozenAt), Date.parse(input.modelReleasedAt));
      if (!Number.isFinite(boundary)) return {status:"unavailable",reason:"environment_date_unknown",added:0};
      const exposed = new Set([...(input.candidate.developmentSourceRoots ?? []),...(input.exposedSourceRoots ?? [])]);
      const snapshots = await readSnapshots({...input,since:new Date(boundary).toISOString(),limit:100});
      let added = 0;
      for (const source of snapshots) {
        const firstPublicAt = Date.parse(source.firstPublicAt);
        if (!source.sourceRoot || exposed.has(source.sourceRoot) || !source.firstPublicEvidenceId
          || source.provenanceResolved !== true || !Number.isFinite(firstPublicAt) || firstPublicAt <= boundary || firstPublicAt > now().getTime()
          || typeof source.sourceText !== "string" || createHash("sha256").update(source.sourceText).digest("hex") !== source.sourceHash) continue;
        const item = await extractTask({moduleId:input.moduleId,source,curatorOnly:true});
        if (!item || item.curatorIndependent !== true || !item.id || !Array.isArray(item.sourceQuotes)
          || !item.sourceQuotes.length || item.sourceQuotes.some((quote) => typeof quote !== "string" || !quote || !source.sourceText.includes(quote))) continue;
        await taskPool.add({...item,moduleId:input.moduleId,sourceRoot:source.sourceRoot,sourceHash:source.sourceHash,
          studyFamilyId:source.studyFamilyId ?? source.sourceRoot,sourceAliases:source.sourceAliases ?? source.aliases ?? [],quarter:input.quarter??null,pool:input.pool??"confirmation",scope:"public",firstPublicAt:source.firstPublicAt,firstPublicEvidenceId:source.firstPublicEvidenceId,
          curatorIndependent:true,epoch:input.epoch,provenanceEvidence:source.provenanceEvidence ?? [],
          equivalentVariant:item.equivalentVariant ?? null,abstentionExpected:item.abstentionExpected === true});
        exposed.add(source.sourceRoot); added++;
      }
      return {status:added ? "curated" : "waiting",added};
    },
  };
}
