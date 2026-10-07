import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { writeFileExclusiveNoFollow } from './security.mjs';
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Immutable evaluator-owned freeze, first-use reservation and feedback records. No hidden data is returned. @param {any} config */
export function createEvolutionConfirmationLedger(config) {
  const root = config.evaluationDataDir || path.join(config.dataDir, 'evaluation-control');
  const directory = path.join(root, 'paper-gold', 'confirmation-ledger');
  const read = async (kind, id) => {
    try { return JSON.parse(await readFile(path.join(directory, kind, `${id}.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  };
  const write = async (kind, id, record) => writeFileExclusiveNoFollow(root, path.join(directory, kind, `${id}.json`), canonicalJson(record) + '\n', { mode: 0o444 });
  const sourceRoot=item=>item.canonicalSourceRoot??item.studyFamilyId??item.sourceRoot??item.doi??item.sourceUrl??null;
  const feedbackCount=async(provenanceRoot)=>{
    let names;try{names=await readdir(path.join(directory,'feedback'));}catch(error){if(error.code==='ENOENT')return 0;throw error;}
    let count=0;
    for(const name of names.filter(filename=>/^[a-f0-9]{64}\.json$/.test(filename))){const record=await read('feedback',name.slice(0,-5));count+=(record?.cases??[]).filter(item=>item.sourceRoot===provenanceRoot).length;}
    return count;
  };
  return {
    /** @param {any} candidate @param {any} [options] */
    async freezeCandidate(candidate, { card = {}, modelReleasedAt=card.modelReleasedAt??null, modelReleaseEvidenceId=card.modelReleaseEvidenceId??null } = {}) {
      const artifactDigest = `sha256:${hash(candidate.files ?? {})}`;
      const identity = hash({ artifactDigest, modelReleasedAt,modelReleaseEvidenceId, methodId: card.methodId ?? candidate.methodId ?? candidate.id, contract: { entrypoint: candidate.entrypoint ?? null, dependencies: candidate.dependencies ?? [], executionTools: candidate.executionTools ?? [] } });
      const existing = await read('freezes', identity);
      if (existing) return existing;
      const record = { schemaVersion: 2, modelReleasedAt,modelReleaseEvidenceId,identity, artifactDigest, frozenAt: new Date().toISOString(), lineageId: card.lineageId ?? card.id ?? candidate.id, methodId: card.methodId ?? candidate.methodId ?? candidate.id };
      try { await write('freezes', identity, record); return record; }
      catch (error) { if (error.code !== 'EEXIST') throw error; return read('freezes', identity); }
    },
    /** Reserving globally makes a confirmation batch support only one promotion. Crashed reservations remain consumed. */
    async assemble(definition, frozen, { purpose = 'confirmation', minimumCases = 2, requireTemporal = false } = {}) {
      const cases = [], groups = [];
      const candidates=[];
      const cutoff=Math.max(Date.parse(frozen.frozenAt),Date.parse(frozen.modelReleasedAt));
      const temporalProof=Number.isFinite(cutoff)&&typeof frozen.modelReleaseEvidenceId==='string'&&frozen.modelReleaseEvidenceId.length>0;
      const freshCase=item=>temporalProof&&Date.parse(item.earliestPublicAt??'')>cutoff&&Date.parse(item.earliestPublicAt??'')<=Date.now();
      const seenRoots=new Set();
      for(const item of definition.cases??[]){
        const prior=await read('uses',hash({sourceRoot:sourceRoot(item)}));
        const fresh=freshCase(item);
        const count=await feedbackCount(sourceRoot(item));
        if(['release-replay','development'].includes(purpose)||sourceRoot(item)&&!seenRoots.has(sourceRoot(item))&&!prior&&count===0&&(fresh||item.reserve===true&&item.hidden===true)&&item.hidden===true&&item.independentQa?.passed===true&&/^[a-f0-9]{64}$/.test(item.sourceHash??'')){candidates.push(item);seenRoots.add(sourceRoot(item));}
      }
      if(!['release-replay','development'].includes(purpose)&&(candidates.length<minimumCases||requireTemporal&&!candidates.some(item=>item.kind==='published'&&freshCase(item))))return{cases:[],groups:[],frozen,batchHash:hash([]),confirmatory:true};
      for (const item of candidates) {
        const identity = hash({sourceRoot:sourceRoot(item)});
        const prior = await read('uses', identity);
        if(purpose==='development'&&item.reserve===true&&!prior)continue;
        if (purpose === 'release-replay' || purpose === 'development') { cases.push(item); groups.push({ caseId: item.id, sourceRoot:sourceRoot(item), sourceHash:item.sourceHash, group: 'development', feedbackCount: await feedbackCount(sourceRoot(item)) }); continue; }
        const fresh = freshCase(item);
        const hiddenReserve = item.reserve === true && item.hidden === true;
        if (prior || !(fresh || hiddenReserve) || item.hidden!==true || item.independentQa?.passed !== true || !/^[a-f0-9]{64}$/.test(item.sourceHash??'')) continue;
        const use = { schemaVersion: 1, caseId: item.id, sourceRoot:sourceRoot(item), sourceHash: item.sourceHash, candidateIdentity: frozen.identity, lineageId: frozen.lineageId, reservedAt: new Date().toISOString(), purpose, earliestPublicAt: item.earliestPublicAt ?? null, freshness: fresh ? 'post-freeze-publication' : 'unused-hidden-reserve' };
        try { await write('uses', identity, use); }
        catch (error) { if (error.code !== 'EEXIST') throw error; continue; }
        cases.push(item); groups.push({ caseId: item.id, sourceRoot:sourceRoot(item), sourceHash:item.sourceHash, group: purpose === 'audit' ? 'audit' : 'confirmation', feedbackCount: 0, freshness: use.freshness });
      }
      return { cases, groups, frozen, batchHash: hash(groups), confirmatory: !['release-replay', 'development'].includes(purpose) };
    },
    async recordFeedback(evaluation, { lineageId = null, candidateDigest = null } = {}) {
      if (!evaluation?.evaluationReceiptHash) return;
      const record = { schemaVersion: 1, evaluationReceiptHash: evaluation.evaluationReceiptHash, lineageId, candidateDigest, at: new Date().toISOString(), cases: [...new Map((evaluation.caseGroups ?? []).map(item=>[item.caseId,{caseId:item.caseId,sourceRoot:item.sourceRoot??null,sourceHash:item.sourceHash,feedbackCount:1}])).values()] };
      try { await write('feedback', hash({ receipt: evaluation.evaluationReceiptHash, lineageId }), record); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    },
  };
}
