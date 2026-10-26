import { readGeoSignalProgress, writeGeoSignalProgress, geoSignalProgressSuperseded } from './geoSignalProgress.mjs';
import { createHash } from 'node:crypto';
import { GEO_MEASUREMENT_METHOD_VERSION, validateGeoMeasurementContract } from '@evimed/domain';
import { canonicalJson } from './geoStore.mjs';
import { GEO_ROUND_ANSWERED } from './geoMeasureStore.mjs';
import { withGeoReadTransaction, readGeoSelection } from './geoReadScope.mjs';
import { geoComparisonKey, geoComparableAnswer, geoComparisonCellKey, geoComparisonMembers, compareGeoMetricCohorts, geoComparisonContractsMatch } from './geoComparison.mjs';
import { geoMarketReadTimestamp } from './geoMarketOperations.mjs';
import { packGeoGroupChange, readGeoGroupChangeMembers } from './geoSignalTargets.mjs';
import { HttpError } from './security.mjs';
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const sorted = values => [...new Set(values)].sort();
const fail = code => new HttpError(409, code, 'The completed comparison is not ready; preserved progress will be retried.');
export const GROUP_CHANGE_MARK = 'signals:group-change:v1';
export const GROUP_CHANGE_POLICY = Object.freeze({ policyVersion: 'group-observed-pp-v1', threshold: 5, unit: 'percentage_points', operator: '>',
  deltaBasis: 'canonical_rounded_delta', criterion: 'descriptive_magnitude_screen', noiseMeasured: false, noiseThreshold: null, causal: false, consumerModelVersion: 'unknown' });

/**
 * Exact adjacent completed observations are selected by recorded completion, including the same day. A round that heard no answer
 * (`GEO_ROUND_ANSWERED`; its engines paused or the probe host down, 2026-10-25) is no observation: it is never measured, so a pair
 * ending on it was "not ready" on every pass and the screen stopped there for good.
 */
async function nextRounds(store, project, mark) {
  return (await store.query(`SELECT r.*,${geoMarketReadTimestamp('r.finished_at')} AS completed_at FROM evimed_geo.rounds r
    JOIN evimed_geo.projects p ON p.id=r.geo_project_id AND p.user_id=r.user_id
    WHERE p.id=$1 AND p.user_id=$2 AND p.project_id=$3 AND p.deleted_at IS NULL AND NOT p.internal
      AND r.kind IN ('baseline','weekly','single_step') AND r.status IN ('done','partial') AND r.finished_at IS NOT NULL AND ${GEO_ROUND_ANSWERED('r')}
      AND coalesce(r.surface->>'mode','web') IN ('web','raw')
      AND ($4::timestamptz IS NULL OR (r.finished_at,r.id)>($4::timestamptz,$5))
    ORDER BY r.finished_at,r.id LIMIT $6`, [project.id, project.userId, project.projectId, mark.completedAt ?? null, mark.roundId ?? '', mark.roundId ? 1 : 2])).rows;
}
async function assertReady(store, project, ids) {
  const rows = (await store.query(`SELECT r.id,${geoMarketReadTimestamp('r.finished_at')} AS completed_at FROM evimed_geo.rounds r JOIN evimed_geo.projects p ON p.id=r.geo_project_id AND p.user_id=r.user_id
    WHERE r.id=ANY($1::text[]) AND r.geo_project_id=$2 AND r.user_id=$3 AND p.project_id=$4 AND p.deleted_at IS NULL AND NOT p.internal
    AND r.kind IN ('baseline','weekly','single_step') AND coalesce(r.surface->>'mode','web') IN ('web','raw')
    AND r.status IN ('done','partial') AND r.finished_at IS NOT NULL AND r.ref->'balance' IS NOT NULL
    AND EXISTS(SELECT 1 FROM evimed_geo.metrics m WHERE m.round_id=r.id AND m.geo_project_id=r.geo_project_id AND m.user_id=r.user_id)
    AND NOT EXISTS(SELECT 1 FROM evimed_geo.snapshots s WHERE s.round_id=r.id AND s.geo_project_id=r.geo_project_id AND s.user_id=r.user_id
      AND s.status IN ('valid','refusal') AND NOT EXISTS(SELECT 1 FROM evimed_geo.facts f WHERE f.snapshot_id=s.id AND f.geo_project_id=s.geo_project_id AND f.user_id=s.user_id))
    AND NOT EXISTS(SELECT 1 FROM evimed_geo.facts f JOIN evimed_geo.snapshots s ON s.id=f.snapshot_id AND s.geo_project_id=f.geo_project_id AND s.user_id=f.user_id
      WHERE s.round_id=r.id AND s.geo_project_id=r.geo_project_id AND s.user_id=r.user_id AND greatest(f.created_at,coalesce(f.reparsed_at,f.created_at))>
        (SELECT max(m.computed_at) FROM evimed_geo.metrics m WHERE m.round_id=r.id AND m.geo_project_id=r.geo_project_id AND m.user_id=r.user_id))`,
  [ids, project.id, project.userId, project.projectId])).rows;
  if (rows.length !== ids.length || ids[0] === ids[1]) throw fail('geo_group_change_not_ready');
  return rows;
}
export async function readGeoRoundComparison(store, project, {previousRoundId, currentRoundId}) {
  return withGeoReadTransaction(store, async () => {
    const ready = await assertReady(store, project, [previousRoundId, currentRoundId]);
    const adjacent = (await store.query(`SELECT previous.id FROM evimed_geo.rounds previous JOIN evimed_geo.rounds current
      ON current.geo_project_id=previous.geo_project_id AND current.user_id=previous.user_id
      WHERE previous.id=$1 AND current.id=$2 AND previous.geo_project_id=$3 AND previous.user_id=$4
        AND (previous.finished_at,previous.id)<(current.finished_at,current.id)
        AND NOT EXISTS(SELECT 1 FROM evimed_geo.rounds between_round WHERE between_round.geo_project_id=previous.geo_project_id AND between_round.user_id=previous.user_id
          AND between_round.kind IN ('baseline','weekly','single_step') AND between_round.status IN ('done','partial')
          AND coalesce(between_round.surface->>'mode','web') IN ('web','raw') AND ${GEO_ROUND_ANSWERED('between_round')}
          AND (between_round.finished_at,between_round.id)>(previous.finished_at,previous.id)
          AND (between_round.finished_at,between_round.id)<(current.finished_at,current.id))`,
    [previousRoundId,currentRoundId,project.id,project.userId])).rows;
    if(adjacent.length!==1) throw fail('geo_group_change_pair_not_adjacent');
    const previousFull = await readGeoSelection(store, project, {round: previousRoundId});
    const currentFull = await readGeoSelection(store, project, {round: currentRoundId});
    const old = new Set(previousFull.rows.filter(geoComparableAnswer).map(geoComparisonKey));
    const commonKeys = sorted(currentFull.rows.filter(geoComparableAnswer).map(geoComparisonKey).filter(key => old.has(key)));
    const subset = { keys: commonKeys, eligibleOnly: true };
    const previous = await readGeoSelection(store, project, {round: previousRoundId}, {subset});
    const current = await readGeoSelection(store, project, {round: currentRoundId}, {subset});
    for (const selected of [previous,current]) selected.rounds[0].completed_at = ready.find(round=>round.id===selected.rounds[0].id).completed_at;
    // Preserve answer bytes and assessment material in this same repeatable-read generation.
    const groups = (await store.query('SELECT id,name FROM evimed_geo.question_groups WHERE geo_project_id=$1 AND user_id=$2', [project.id,project.userId])).rows;
    const names = new Map(groups.map(group=>[group.id,group.name]));
    for (const selected of [previous,current]) for (const question of selected.questions) question.group_name = names.get(question.group_id) ?? null;
    const ids = [...previous.rows, ...current.rows].map(row => row.snapshotId);
    const materials = (await store.query(`SELECT s.id,s.answer_text,s.answer_sha256 FROM evimed_geo.snapshots s
      WHERE s.geo_project_id=$1 AND s.user_id=$2 AND s.id=ANY($3::text[])`, [project.id, project.userId, ids])).rows;
    const byId = new Map(materials.map(row => [row.id,row]));
    for (const selected of [previous,current]) {
      const questions=new Map(selected.questions.map(question=>[question.id,question]));
      for (const row of selected.rows) {
        const material = byId.get(row.snapshotId),question=questions.get(row.questionId);
        if (!material||!question) throw fail('geo_group_change_material_missing');
        row.preservedAnswer = { text: material.answer_text, digest: material.answer_sha256 ?? hash(material.answer_text) };
        row.preservedQuestion = {id:question.id,text:question.text,setVersion:question.set_version,groupId:question.group_id,pool:question.pool,
          originalId:question.original_id??null,originalGroup:question.original_group??null,clientTags:question.client_tags??[],kind:question.kind??null};
      }
    }
    return {previous,current,commonKeys,excluded:{before:previousFull.selection.counts,after:currentFull.selection.counts}};
  });
}
function methodBasis(selected) {
  const comparability = selected.selection.comparability, round = selected.rounds[0];
  return {methodVersion:selected.selection.methodVersion,methodVersions:comparability.methodVersions,samplingContracts:comparability.samplingContracts,
    engines:sorted(round.ref?.balance?.engines ?? []),declaredEngines:sorted(round.engines ?? []),modes:comparability.modes,samplingModes:comparability.samplingModes};
}
function contractFor(selected) {
  try {
    const b=methodBasis(selected);
    if(b.methodVersion!==GEO_MEASUREMENT_METHOD_VERSION||b.methodVersions.length!==1||b.methodVersions[0]!==GEO_MEASUREMENT_METHOD_VERSION
      ||b.samplingContracts.length!==1||b.modes.length!==1||!['web','raw'].includes(b.modes[0])||!b.engines.length)return null;
    // enqueueRound adds only the exact locked question version to the saved user contract.
    const {questionVersion,...agreement}=b.samplingContracts[0]??{};
    if(questionVersion!==undefined&&(!Number.isSafeInteger(questionVersion)||questionVersion!==Number(selected.rounds[0]?.set_version)))return null;
    const contract=validateGeoMeasurementContract(agreement);
    if(!b.declaredEngines.length||b.declaredEngines.some(engine=>!contract.engines.includes(engine))||hash(b.engines)!==hash(b.declaredEngines)
      ||b.samplingModes.length!==1||b.samplingModes[0]!==contract.samplingMode)return null;
    return {...contract,observedEngines:b.declaredEngines};
  } catch { return null; }
}
/** A common question is usable only with every agreed engine and repeat; missing calls never become zero. */
function completeGroups(selected,contract) {
  const groups=new Map();
  for(const row of selected.rows){
    const key=canonicalJson([row.groupId,row.pool]),group=groups.get(key)??{valid:true,questions:new Map()};groups.set(key,group);
    if(!geoComparableAnswer(row)||!contract.observedEngines.includes(row.engine)||!Number.isSafeInteger(row.repeatIndex)||row.repeatIndex<0||row.repeatIndex>=contract.repeats){group.valid=false;continue;}
    const engines=group.questions.get(row.questionId)??new Map();group.questions.set(row.questionId,engines);
    const repeats=engines.get(row.engine)??new Set();engines.set(row.engine,repeats);
    if(repeats.has(row.repeatIndex))group.valid=false;repeats.add(row.repeatIndex);
  }
  return new Set([...groups].filter(([,group])=>group.valid&&group.questions.size&&[...group.questions.values()].every(engines=>contract.observedEngines.every(engine=>engines.get(engine)?.size===contract.repeats))).map(([key])=>key));
}
/** Pure screening over the canonical comparison and exact domain denominator membership, with no NET calculation. */
export function groupChangeEvents({previous,current,commonKeys,excluded = null}) {
  const reasons={}, count = reason => {reasons[reason]=(reasons[reason]??0)+1;};
  if (!commonKeys.length) { count('no_common_cohort'); return {events:[],reasons}; }
  const version=Number(current.rounds[0]?.set_version);
  const beforeBasis=methodBasis(previous),afterBasis=methodBasis(current);
  const beforeContract=contractFor(previous),afterContract=contractFor(current);
  if (!beforeContract||!afterContract||!geoComparisonContractsMatch(current,previous)||hash(beforeBasis)!==hash(afterBasis)
    || !Number.isSafeInteger(version)||version<1||Number(previous.rounds[0]?.set_version)!==version) {
    count('incompatible_measurement');return {events:[],reasons};
  }
  const beforeComplete=completeGroups(previous,beforeContract),afterComplete=completeGroups(current,afterContract);
  const comparisons=compareGeoMetricCohorts(current,previous,{mode:'common',commonCount:commonKeys.length});
  const groups=new Map();
  for(const cell of comparisons) {
    if(cell.scope!=='group'||!['M-01','M-03'].includes(cell.metricId)||cell.engine||cell.arm||cell.variant||cell.rival||!cell.groupId)continue;
    if(!beforeContract.metricIds.includes(cell.metricId)||!afterContract.metricIds.includes(cell.metricId)){count('metric_not_agreed');continue;}
    const cohortKey=canonicalJson([cell.groupId,cell.pool]);
    if(!beforeComplete.has(cohortKey)||!afterComplete.has(cohortKey)){count('incomplete_sampling_contract');continue;}
    if(!cell.comparable||cell.current.status!=='ok'||cell.previous?.status!=='ok'||!Number.isFinite(cell.delta)) {count(cell.reason??'cell_not_ok');continue;}
    if(Math.abs(cell.delta)<=GROUP_CHANGE_POLICY.threshold){count('below_screen');continue;}
    const key=canonicalJson([cell.groupId,version,cell.pool]);
    const group=groups.get(key)??{groupId:cell.groupId,pool:cell.pool,cells:[]};group.cells.push(cell);groups.set(key,group);
  }
  const events=[];
  for(const [objectKey,group] of [...groups].sort(([a],[b])=>a.localeCompare(b))) {
    const sides={},cells=group.cells.map(cell=>({key:geoComparisonCellKey(cell),metricId:cell.metricId,delta:cell.delta,unit:'percentage_points'}));
    for(const [side,selected,field] of [['before',previous,'previous'],['after',current,'current']]) {
      const targets=new Map();
      for(const [index,cell] of group.cells.entries()) {
        const members=geoComparisonMembers(selected,cell[field]).rows;
        const ids=sorted(members.map(row=>row.snapshotId));
        cells[index][side]={...cell[field],snapshotIds:undefined,members:undefined,memberCount:ids.length,memberDigest:hash(ids)};
        for(const row of members) {
          const target=targets.get(row.snapshotId)??{type:'group_member',key:`${side}:${row.snapshotId}`,side,...row,metricKeys:[]};
          target.metricKeys.push(cells[index].key);targets.set(row.snapshotId,target);
        }
      }
      sides[side]={selectionRef:selected.selection.reference,dataRevision:selected.selection.dataRevision,targets:[...targets.values()].sort((a,b)=>a.snapshotId.localeCompare(b.snapshotId))};
    }
    const descriptor=selected=>({id:selected.rounds[0].id,completedAt:selected.rounds[0].completed_at??(selected.rounds[0].finished_at==null?null:new Date(selected.rounds[0].finished_at).toISOString()),questionVersion:version});
    const label=current.questions.find(q=>q.group_id===group.groupId)?.group_name??null;
    const basis={policy:GROUP_CHANGE_POLICY,basisObservation:'at_discovery',roundOrder:'finished_at,id',group:{id:group.groupId,label,pool:group.pool,questionVersion:version},
      previous:descriptor(previous),current:descriptor(current),methods:{before:beforeBasis,after:afterBasis},common:{count:commonKeys.length,digest:hash(commonKeys)},excluded,cells,sides};
    const sample=side=>sides[side].targets;
    const eventVersion=hash([GROUP_CHANGE_POLICY.policyVersion,basis.previous.id,basis.current.id,objectKey,basis.methods,sample('before'),sample('after'),cells]);
    events.push({kind:'group_changed',objectKey,eventVersion,title:`${label??'问题群'}的观测指标发生变化`,observedAt:basis.current.completedAt,basis});
  }
  return {events,reasons};
}

/** A frozen input receipt uses the existing document ledger; the leased discovery mark owns all progress. */
export class GeoGroupChanges {
  constructor({store,signals,now=()=>new Date()}){this.store=store;this.signals=signals;this.now=now;}
  async mark(project,detail,state='done') {
    return writeGeoSignalProgress(this.store,project,GROUP_CHANGE_MARK,detail,state,this.now());
  }
  async project(project) {
    let mark=await readGeoSignalProgress(this.store,project,GROUP_CHANGE_MARK);
    try {
      if(!mark.pending) {
        const rounds=await nextRounds(this.store,project,mark);
        if(!rounds.length)return;
        if(!mark.roundId){ const first=rounds.shift();mark=await this.mark(project,{...mark,roundId:first.id,completedAt:first.completed_at}); }
        if(!rounds.length)return;
        const current=rounds[0],id=`ggp_${hash([project.id,mark.roundId,current.id,GROUP_CHANGE_POLICY.policyVersion])}`;
        let receipt=await this.signals.documents.get(project.userId,'geo-signal',id);
        if(!receipt) {
          const result=groupChangeEvents(await readGeoRoundComparison(this.store,project,{previousRoundId:mark.roundId,currentRoundId:current.id}));
          const docs=[],entries=[];
          for(const event of result.events) {
            const inputId=`ggi_${hash([id,event.objectKey])}`,packed=packGeoGroupChange(project,inputId,event.basis);
            docs.push({kind:'geo-signal',id:inputId,projectId:project.projectId,payload:{recordType:'geo-group-input',geoId:project.id,event:{...event,basis:packed.basis},basis:packed.basis,basisDigest:hash(packed.basis)}},...packed.pages);
            entries.push({id:inputId,basisDigest:hash(packed.basis),eventDigest:hash({...event,basis:packed.basis})});
          }
          const payload={recordType:'geo-group-pair',geoId:project.id,previousRoundId:mark.roundId,currentRoundId:current.id,completedAt:current.completed_at,entries,reasons:result.reasons};
          if(docs.length > 256 || Buffer.byteLength(JSON.stringify(docs))+Buffer.byteLength(JSON.stringify(payload))>16*1024*1024||entries.length>20_000)throw fail('geo_group_change_input_limit');
          try{await this.signals.documents.createBatch(project.userId,[{kind:'geo-signal',id,projectId:project.projectId,payload},...docs]);}
          catch(error){if(!await this.signals.documents.get(project.userId,'geo-signal',id))throw error;}
          receipt=await this.signals.documents.get(project.userId,'geo-signal',id);
        }
        mark=await this.mark(project,{...mark,pending:id,pendingDigest:hash(receipt.payload),index:0,lastError:null});
      }
      const receipt=await this.signals.documents.get(project.userId,'geo-signal',mark.pending),payload=receipt?.payload;
      if(receipt?.projectId!==project.projectId||payload?.recordType!=='geo-group-pair'||payload.geoId!==project.id||payload.previousRoundId!==mark.roundId||hash(payload)!==mark.pendingDigest)throw fail('geo_group_change_input_missing');
      const stop=Math.min(mark.index+20,payload.entries.length);
      while(mark.index<stop) {
        const input=await this.signals.documents.get(project.userId,'geo-signal',payload.entries[mark.index].id);
        if(input?.projectId!==project.projectId||input?.payload.geoId!==project.id||input.payload.recordType!=='geo-group-input'||input.payload.basisDigest!==hash(input.payload.basis)||input.payload.basisDigest!==payload.entries[mark.index].basisDigest||hash(input.payload.event)!==payload.entries[mark.index].eventDigest||hash(input.payload.event.basis)!==input.payload.basisDigest)throw fail('geo_group_change_input_missing');
        const basis={...input.payload.basis,sides:{...input.payload.basis.sides}};
        for(const side of ['before','after']) {
          const targets=[];let offset=0,page;
          do{page=await readGeoGroupChangeMembers(this.signals.documents,project,input,{side,offset,limit:500});targets.push(...page.items);offset=page.nextOffset;}while(page.more);
          basis.sides[side]={selectionRef:basis.sides[side].selectionRef,dataRevision:basis.sides[side].dataRevision,targets};
        }
        await this.signals.record(project,{...input.payload.event,basis});
        mark=await this.mark(project,{...mark,index:mark.index+1,lastError:null});
      }
      if(mark.index>=payload.entries.length) mark=await this.mark(project,{...mark,pending:undefined,pendingDigest:undefined,index:undefined,roundId:payload.currentRoundId,completedAt:payload.completedAt,lastPair:mark.pending,reasons:payload.reasons,lastError:null});
    } catch(error) {
      if (geoSignalProgressSuperseded(error)) return {superseded:true};
      try { await this.mark(project,{...mark,lastError:String(error?.code??'geo_group_change_failed').slice(0,160)},'failed'); }
      catch (failure) { if (geoSignalProgressSuperseded(failure)) return {superseded:true}; throw failure; }
      throw error;
    }
  }
}
