import { createHash } from "node:crypto";

/** Frozen public snapshots come from the preservation gateway; extraction has a separate identity from proposal.
 * Missing preservation or source-root/date proofs produce no confirmation task.
 *
 * Each read continues where the last one stopped (`readCursor`/`saveCursor`, one cursor per module, pool and quarter):
 * the feed brings hundreds of entries a day and only those first public after the boundary qualify, so a read that
 * always began at the boundary saw the same first hundred entries on every wake — re-extracting and re-reviewing
 * them each time — and never reached the papers that could fill a cohort. A snapshot the reader could not use
 * comes back `skipped` so the cursor still moves past it; the cursor is saved before each extraction, so an
 * extraction that fails (a spent budget) is tried again on the next wake and nothing before it is read twice.
 * @param {{taskPool:any, readSnapshots:(input:any)=>Promise<any[]>, extractTask:(input:any)=>Promise<any>, now?:()=>Date,
 *   readCursor?:((key:string)=>Promise<any>)|null, saveCursor?:((key:string,cursor:any)=>Promise<any>)|null}} dependencies */
export function createModuleEvolutionCurator({ taskPool, readSnapshots, extractTask, now = () => new Date(), readCursor = null, saveCursor = null }) {
  return {
    /** @param {{moduleId:string, candidate:any, modelReleasedAt:string, epoch:string, exposedSourceRoots?:string[], pool?:string, quarter?:string, want?:number}} input */
    async curate(input) {
      if (!["frontier", "geo", "autopilot"].includes(input.moduleId)) return {status:"unavailable",reason:"curator_module_unavailable",added:0};
      const boundary = Math.max(Date.parse(input.candidate.frozenAt), Date.parse(input.modelReleasedAt));
      if (!Number.isFinite(boundary)) return {status:"unavailable",reason:"environment_date_unknown",added:0};
      const exposed = new Set([...(input.candidate.developmentSourceRoots ?? []),...(input.exposedSourceRoots ?? [])]);
      const key = [input.moduleId, input.pool ?? "confirmation", input.quarter ?? ""].join(":");
      const saved = readCursor ? await readCursor(key) : null;
      const resume = saved?.receivedAt && Date.parse(saved.at) > boundary ? saved : null;
      // One call reads up to three pages and stops once it has the tasks the cohort still lacks (`want`).
      const want = Number.isFinite(input.want) && input.want > 0 ? input.want : Infinity;
      let added = 0, last = null, page = 0, more = true;
      const flush = async () => { if (last && saveCursor) await saveCursor(key, last); };
      while (more && added < want && page++ < 3) {
        const from = last ?? resume;
        const snapshots = await readSnapshots({...input,since:from?.receivedAt ?? new Date(boundary).toISOString(),afterId:from?.id ?? null,
          publishedAfter:new Date(boundary).toISOString(),limit:100});
        more = snapshots.length >= 100;
        for (const source of snapshots) {
          if (added >= want) { more = false; break; }
          const firstPublicAt = Date.parse(source.firstPublicAt);
          const usable = !source.skipped && source.sourceRoot && !exposed.has(source.sourceRoot) && source.firstPublicEvidenceId
            && source.provenanceResolved === true && Number.isFinite(firstPublicAt) && firstPublicAt > boundary && firstPublicAt <= now().getTime()
            && typeof source.sourceText === "string" && createHash("sha256").update(source.sourceText).digest("hex") === source.sourceHash;
          if (!usable) { last = source.cursor ?? last; continue; }
          await flush();
          last = source.cursor ?? last;
          const item = await extractTask({moduleId:input.moduleId,source,curatorOnly:true});
          if (!item || item.curatorIndependent !== true || !item.id || !Array.isArray(item.sourceQuotes)
            || !item.sourceQuotes.length || item.sourceQuotes.some((quote) => typeof quote !== "string" || !quote || !source.sourceText.includes(quote))) continue;
          await taskPool.add({...item,moduleId:input.moduleId,sourceRoot:source.sourceRoot,sourceHash:source.sourceHash,
            studyFamilyId:source.studyFamilyId ?? source.sourceRoot,sourceAliases:source.sourceAliases ?? source.aliases ?? [],quarter:input.quarter??null,pool:input.pool??"confirmation",scope:"public",firstPublicAt:source.firstPublicAt,firstPublicEvidenceId:source.firstPublicEvidenceId,
            curatorIndependent:true,epoch:input.epoch,provenanceEvidence:source.provenanceEvidence ?? [],
            equivalentVariant:item.equivalentVariant ?? null,abstentionExpected:item.abstentionExpected === true});
          exposed.add(source.sourceRoot); added++;
        }
      }
      await flush();
      return {status:added ? "curated" : "waiting",added};
    },
  };
}
