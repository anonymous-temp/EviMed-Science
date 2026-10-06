import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { evolutionKey } from './evolutionService.mjs';

export const EVOLUTION_POOLS = Object.freeze(['development', 'confirmation', 'audit', 'prospective']);
/** @param {any} value */
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Immutable evaluator-side tasks. No API exposes hidden inputs or answers to a proposer.
 * @param {{service:any}} dependencies */
export function createEvolutionTaskPool({ service }) {
  const queues=new Map();
  const atomic=async(key,operation)=>{
    const database=service.documents?.database;
    const perform=()=>database?.transaction&&database.withTransactionClient?database.transaction(client=>database.withTransactionClient(client,async()=>{await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`evimed-evolution:${key}`]);return operation();})):service.withLock(key,operation);
    const pending=(queues.get(key)??Promise.resolve()).catch(()=>{}).then(perform);queues.set(key,pending);
    try{return await pending;}finally{if(queues.get(key)===pending)queues.delete(key);}
  };
  async function add(task) {
    if (!task.id || !task.sourceRoot || !task.sourceHash || !task.moduleId || !EVOLUTION_POOLS.includes(task.pool)) throw new Error('A task needs preserved source, module and pool identities.');
    if (task.scope !== 'public' && task.scope !== 'generated') throw new Error('Platform tasks cannot contain tenant data.');
    if (task.scope === 'generated' && task.truthVerified !== true) throw new Error('Generated tasks require executable truth and rejected wrong solutions.');
    const id = `evolution-task-${evolutionKey([task.moduleId, task.id, task.sourceHash])}`;
    const previous = await service.get(id);
    if (previous) return previous;
    return service.save('task', id, { ...task, feedbackCount: 0, uses: [], addedAt: service.now().toISOString(), taskHash: hash(task) });
  }
  async function expose(tasks, { candidateId, lineageId, reason }) {
    return atomic('task-pools', async () => {
      for (const task of tasks) {
        const row = await service.get(task.id), p = row?.payload;
        if (!p) continue;
        const key = `${candidateId}:${reason}`;
        if ((p.uses ?? []).some(use => use.key === key)) continue;
        await service.save('task', row.id, { ...p, pool: p.pool === 'prospective' ? p.pool : 'development', feedbackCount: Number(p.feedbackCount ?? 0) + 1,
          uses: [...(p.uses ?? []), { key, candidateId, lineageId, reason, at: service.now().toISOString() }] }, row);
      }
    });
  }
  async function assemble({ candidateId, lineageId, moduleId, frozenAt, modelReleasedAt, epoch, minimum, slices = [] }) {
    return atomic('task-pools', async () => {
      const id = `evolution-confirmation-batch-${evolutionKey([candidateId, epoch])}`;
      const existing = await service.get(id);
      if (existing) return existing;
      const tasks = await service.list('task');
      const assets=await service.list('resource-asset');
      const identities=t=>[t.sourceRoot,t.canonicalSourceRoot,t.studyFamilyId,t.studyFamily,t.sourceHash,t.sourceUrl,...(t.sourceAliases??[])].filter(Boolean);
      const exposedRoots = new Set([...tasks,...assets].filter(row=>row.payload.feedbackCount>0||row.payload.exposedToDevelopment===true||row.payload.reservedFor||row.payload.exposureTier&&row.payload.exposureTier!=='unexposed').flatMap(row=>identities(row.payload)));
      // Transitive alias closure prevents a new URL, version or task id from recycling one exposed study.
      let changed=true;
      while(changed){changed=false;for(const row of [...tasks,...assets]){const keys=identities(row.payload);if(keys.some(key=>exposedRoots.has(key)))for(const key of keys)if(!exposedRoots.has(key)){exposedRoots.add(key);changed=true;}}}
      const eligible = tasks.filter(row => {
        const t = row.payload;
        if (t.moduleId !== moduleId || t.pool !== 'confirmation' || t.reservedFor || t.feedbackCount || identities(t).some(key=>exposedRoots.has(key))) return false;
        if (t.epoch && t.epoch !== epoch) return false;
        if (t.reservedHidden === true && t.curatorIndependent === true) return true;
        if (t.scope === 'generated') return t.truthVerified && t.parameterRangeUnseen && Date.parse(t.generatedAt) > Date.parse(frozenAt) && Date.parse(t.generatedAt)<=service.now().getTime();
        return t.firstPublicEvidenceId && Date.parse(t.firstPublicAt) > Math.max(Date.parse(frozenAt), Date.parse(modelReleasedAt)) && Date.parse(t.firstPublicAt)<=service.now().getTime();
      });
      const grouped = new Map();
      for (const row of eligible) { const root=row.payload.studyFamilyId??row.payload.studyFamily??row.payload.canonicalSourceRoot??row.payload.sourceRoot; if (!grouped.has(root)) grouped.set(root, row); }
      const selected = [...grouped.values()].sort((a,b) => hash([candidateId, a.id]).localeCompare(hash([candidateId, b.id])));
      if (selected.length < minimum) return { id: null, payload: { status: 'waiting', reason: 'fresh-task-groups-incomplete', availableGroups: selected.length, minimum } };
      const chosen=[];
      const choose=predicate=>{const row=selected.find(item=>!chosen.includes(item)&&predicate(item));if(row)chosen.push(row);};
      choose(row=>row.payload.abstentionExpected===true&&row.payload.equivalentVariant);
      for(const slice of slices)if(!chosen.some(row=>row.payload.slices?.includes(slice)))choose(row=>row.payload.slices?.includes(slice)&&row.payload.equivalentVariant);
      for(const row of selected)if(chosen.length<minimum&&!chosen.includes(row)&&row.payload.equivalentVariant)chosen.push(row);
      if(chosen.length>minimum)return{id:null,payload:{status:'waiting',reason:'required-slices-exceed-batch-size'}};
      if(chosen.length<minimum)return{id:null,payload:{status:'waiting',reason:'equivalence-coverage-incomplete'}};
      if (!chosen.some(row => row.payload.abstentionExpected === true) || !chosen.every(row => row.payload.equivalentVariant)) return { id: null, payload: { status: 'waiting', reason: 'abstention-or-equivalence-coverage-missing' } };
      if (slices.some(slice => !chosen.some(row => row.payload.slices?.includes(slice)))) return { id: null, payload: { status: 'waiting', reason: 'preregistered-slice-missing' } };
      const batch = await service.save('confirmation-batch', id, { candidateId, lineageId, moduleId, epoch, frozenAt, assembledAt: service.now().toISOString(),
        taskIds: chosen.map(row => row.id), sourceRoots: chosen.map(row => row.payload.sourceRoot), taskHashes: chosen.map(row => row.payload.taskHash),
        minimum, slices, status: 'sealed', attempt: 0, noiseAlgorithm: 'paired-three-baselines-two-sd-floor-0.02', selectionVersion: 'evolution-selection-2' });
      for (const row of chosen) await service.save('task', row.id, { ...row.payload, reservedFor: candidateId }, row);
      return batch;
    });
  }
  async function begin(batch) {
    return atomic(`batch:${batch.id}`, async () => {
      const current = await service.get(batch.id);
      if(current.payload.status==='complete')return{status:'complete',tasks:[]};
      if (current.payload.attempt > 0) return { status: 'resumed', tasks:await Promise.all(current.payload.taskIds.map(id=>service.get(id))) };
      await service.save('confirmation-batch', batch.id, { ...current.payload, attempt: 1, attemptedAt: service.now().toISOString(), status: 'running' }, current);
      return { status: 'started', tasks: await Promise.all(current.payload.taskIds.map(id => service.get(id))) };
    });
  }
  /** A successful first answer is durable. A paid/interrupted ambiguous answer cannot be repeated. */
  async function executeUnit(batch,key,operation){
    const id=`evolution-evaluation-unit-${evolutionKey([batch.id,key])}`;
    const claimed=await atomic(`unit:${id}`,async()=>{
      const previous=await service.get(id);
      if(previous?.payload.status==='complete'){if(hash(previous.payload.result)!==previous.payload.resultHash)throw new Error('Evaluation unit changed after sealing.');return{completed:true,result:previous.payload.result};}
      if(previous?.payload.status==='running'||previous?.payload.status==='interrupted')throw Object.assign(new Error('The original first answer needs reconciliation.'),{code:'evolution_first_answer_reconciliation',status:409});
      await service.save('evaluation-unit',id,{batchId:batch.id,key,status:'running',attempt:1,startedAt:service.now().toISOString()},previous);
      return{completed:false};
    });
    if(claimed.completed)return claimed.result;
    try{
      const result=await operation();
      await atomic(`unit:${id}`,async()=>{const current=await service.get(id);await service.save('evaluation-unit',id,{...current.payload,status:'complete',result,resultHash:hash(result),completedAt:service.now().toISOString()},current);});
      return result;
    }catch(error){
      const unpaid=error?.code==='usage_budget_exceeded'&&(error.status??error.statusCode)===402;
      await atomic(`unit:${id}`,async()=>{const current=await service.get(id);await service.save('evaluation-unit',id,{...current.payload,status:unpaid?'pending-budget':'interrupted',failureCode:unpaid?'usage_budget_exceeded':'first-answer-uncertain'},current);});
      throw error;
    }
  }
  async function finish(batch, result) {
    const current = await service.get(batch.id);
    await service.save('confirmation-batch', batch.id, { ...current.payload, status: 'complete', result, completedAt: service.now().toISOString() }, current);
    await expose(await Promise.all(current.payload.taskIds.map(id => service.get(id))), { candidateId: current.payload.candidateId, lineageId: current.payload.lineageId, reason: 'confirmation-result' });
  }
  async function rotateAudit(quarter) {
    return atomic('task-pools',async()=>{
      const current=await service.get('evolution-audit-pool');
      if(current?.payload.quarter===quarter&&current.payload.status==='sealed')return current;
      if(current&&current.payload.quarter!==quarter)for(const id of current.payload.taskIds){
        const task=await service.get(id);
        if(task)await service.save('task',id,{...task.payload,pool:'development',exposedToDevelopment:true,reservedFor:null,retiredAuditQuarter:current.payload.quarter},task);
      }
      const all=await service.list('task'),assets=await service.list('resource-asset');
      const identities=t=>[t.sourceRoot,t.canonicalSourceRoot,t.studyFamilyId,t.studyFamily,t.sourceHash,t.sourceUrl,...(t.sourceAliases??[])].filter(Boolean);
      const exposed=new Set([...all,...assets].filter(row=>row.payload.feedbackCount||row.payload.exposedToDevelopment||row.payload.reservedFor).flatMap(row=>identities(row.payload)));
      let changed=true;while(changed){changed=false;for(const row of [...all,...assets]){const keys=identities(row.payload);if(keys.some(key=>exposed.has(key)))for(const key of keys)if(!exposed.has(key)){exposed.add(key);changed=true;}}}
      const roots=new Set();
      const tasks=all.filter(row=>row.payload.pool==='audit'&&(!row.payload.auditQuarter||row.payload.auditQuarter===quarter)&&!identities(row.payload).some(key=>exposed.has(key)))
        .sort((a,b)=>hash([quarter,a.id]).localeCompare(hash([quarter,b.id])))
        .filter(row=>{const root=row.payload.studyFamilyId??row.payload.sourceRoot;if(roots.has(root))return false;roots.add(root);return true;}).slice(0,120);
      for(const row of tasks)await service.save('task',row.id,{...row.payload,reservedFor:`audit:${quarter}`},row);
      return service.save('audit-pool','evolution-audit-pool',{quarter,taskIds:tasks.map(row=>row.id),status:tasks.length?'sealed':'waiting',createdAt:service.now().toISOString()},current);
    });
  }

  return { add, expose, assemble, begin, executeUnit, finish, rotateAudit };
}

/** Development exercises are accepted only when executable truth separates correct and wrong answers.
 * This verifier is provided by trusted engine code, never imported from a generated workspace.
 * @param {{verify:(input:any,answer:any)=>boolean,input:any,correct:any,wrong:any[]}} exercise */
export function validateEvolutionExercise(exercise) {
  if (!Array.isArray(exercise.wrong) || exercise.wrong.length < 2) return false;
  try { return exercise.verify(exercise.input, exercise.correct) === true && exercise.wrong.every(answer => exercise.verify(exercise.input, answer) === false); }
  catch { return false; }
}
/** @param {boolean[]} results */
export function evolutionCurriculumDestination(results) {
  if (results.length !== 3) return 'unmeasured';
  const successes = results.filter(Boolean).length;
  return successes === 3 ? 'regression-anchor' : successes === 0 ? 'diagnose-resource-or-capability' : 'development';
}
