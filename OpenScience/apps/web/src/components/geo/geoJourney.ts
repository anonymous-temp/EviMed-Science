import { geoAutomationEnabled, geoWorkflowState } from '@evimed/domain';
import { stepAllowanceWait } from '@/lib/allowanceWait';
import type { GeoProject, GeoStepKey } from '@/lib/geoClient';
import { GEO_STEP_KEYS } from '@/lib/geoClient';
import { GEO_STARTERS, GEO_STEP_NAMES, GEO_STEP_WORK } from './geoText';

type JourneyProject = Pick<GeoProject, 'id' | 'projectId' | 'name' | 'product' | 'steps' | 'status'> & Partial<Pick<GeoProject,'engines'|'coverageDays'|'activeMeasurement'>> & Partial<Pick<GeoProject, 'access'>>;
export function geoActionPermission(project: Pick<GeoProject, 'status' | 'access'>, ability: string) {
  if (project.access && !project.access.abilities.includes(ability)) return { allowed: false, reason: '你在这个项目里没有这项操作权限。' };
  if (ability === 'run' && ['paused','archived'].includes(project.status)) return { allowed: false, reason: project.status === 'paused' ? '项目已暂停，恢复项目后才能开始任务。' : '项目已归档。' };
  return { allowed: true, reason: undefined };
}
export interface GeoJourneyAction { kind: 'conversation' | 'step' | 'runs' | 'view'; label: string; step?: GeoStepKey; draft?: string }

/** A factual task projection shared by list, workbench and native conversation. Navigation never requests work. */
export function geoJourney(project: JourneyProject) {
  const originalSteps = project.steps ?? {};
  const measurement = project.activeMeasurement;
  // A monitoring daemon's old status is not an accepted measurement receipt.
  const recurringActive = measurement && ['weekly','sentinel','post_publication','noise','error_confirmation'].includes(measurement.kind);
  const steps = {...originalSteps};
  if (recurringActive || (steps.monitoring && ['queued','running'].includes(steps.monitoring.status))) {
    steps.monitoring = {requested: false, ...steps.monitoring, status: recurringActive ? measurement.status : 'none'};
  }
  const workflow = geoWorkflowState(steps);
  const legacy = (workflow as {legacyUnconfirmed?:string[]}).legacyUnconfirmed ?? [];
  const product = project.product?.brandName || project.product?.genericName || null;
  const canConverse = geoActionPermission(project, 'run').allowed && geoActionPermission(project, 'edit').allowed;
  const names = (keys: readonly string[]) => keys.map(key => GEO_STEP_WORK[key as GeoStepKey]).join('、');
  const active = workflow.active.find((key: string) => steps[key as GeoStepKey]?.status === 'running') ?? workflow.active[0];
  const failed = GEO_STEP_KEYS.find(key => workflow.steps[key].status === 'failed' && (workflow.steps[key].required || steps[key]?.runId));
  const blocked = workflow.required.find((key: string) => stepAllowanceWait(steps[key as GeoStepKey]));
  const pending = [...workflow.requested, ...workflow.required].find((key: string) => !['done', 'minimal'].includes(workflow.steps[key].status));
  const current = (blocked ?? active ?? failed ?? pending ?? null) as GeoStepKey | null;
  const waitingFor = current ? workflow.steps[current].waitingFor as GeoStepKey[] : [];
  const retained = GEO_STEP_KEYS.flatMap(key => steps[key]?.summary?.text ? [steps[key]!.summary!.text] : []);
  const inputDraft = `请先根据我提供的资料确认产品，再完成我选择的任务。产品名称及适用场景：${product ?? ''}；目标受众（患者、医生或其他）：；本次希望得到：。说明书、证据或已有稿件我会在此对话中附上。缺少会影响工作的资料时请具体指出。`;
  const requested = legacy.length && !workflow.requested.length ? '历史工作范围待确认' : workflow.full ? '本次工作：完整八步方案' : workflow.requested.length ? `本次工作：${names(workflow.requested)}` : '尚未提交工作';
  let stage: 'inputs' | 'ready' | 'running' | 'queued' | 'blocked' | 'failed' | 'paused' | 'results' = 'ready';
  let title = product ? `继续${product}的工作` : '先说明产品与这次要做的事';
  let detail = product ? '选择本次任务；已有资料可直接附在对话中。' : '产品名称与适用场景、目标受众、本次目标能帮助确定工作范围；说明书、证据或已有稿件可直接附在对话中。';
  let next: GeoJourneyAction = { kind: 'conversation', label: '在对话中补充产品与任务', draft: inputDraft };
  if (!product) stage = 'inputs';
  else if (project.steps.questions && ['done', 'minimal'].includes(project.steps.questions.status)) {
    next = {kind:'step',step:'diagnosis',label:'查看诊断与开始测量'};
    detail = '测量问题已有结果。核对范围后，可明确开始一轮 AI 回答诊断。';
  } else if (project.steps.evidence && ['done', 'minimal'].includes(project.steps.evidence.status)) {
    next = {kind:'step',step:'questions',label:'查看问题与下一步'};
    detail = '产品证据已有结果。可继续整理测量问题，也可在对话中交代其他任务。';
  } else if (product) next = {kind:'step',step:'evidence',label:'查看产品依据与资料'};
  if (workflow.requested.length && !pending) {
    stage = 'results'; title = '本次工作已有结果'; detail = '查看保留结果，或在同一对话中解释、修改和继续。';
    next = {kind:'step',step:workflow.requested.at(-1) as GeoStepKey,label:'查看本次结果'};
  }
  if (current) {
    next = {kind:'step',step:current,label:'继续当前工作'};
    const state = workflow.steps[current];
    if (blocked) {stage='blocked';title=`${GEO_STEP_NAMES[current]}等待额度`;detail='打开当前工作查看额度状态和已保留的结果。';}
    else if (active) {stage=state.status === 'running' ? 'running' : 'queued';title=`${state.status === 'running' ? '正在' : '已排队：'}${GEO_STEP_WORK[current]}`;detail=waitingFor.length ? `等待${names(waitingFor)}。` : '查看这次任务的运行记录与已有结果。';}
    else if (failed) {stage='failed';title=`${GEO_STEP_NAMES[current]}没有完成`;detail='查看失败原因与这次运行；已保留的结果仍可打开。';}
    else {stage='queued';title=`待继续：${GEO_STEP_WORK[current]}`;detail=waitingFor.length ? `还需要${names(waitingFor)}。` : '该项工作已请求，尚未观察到开始运行。';}
    if (!active && !failed && !blocked && waitingFor.length) next = {kind:'step',step:waitingFor[0],label:`查看${GEO_STEP_NAMES[waitingFor[0]]}`};
  }
  if (legacy.length && !active && !workflow.requested.length) {
    stage='ready';title='历史步骤范围待确认，选择需要继续的任务';detail='历史结果和已受理的任务都保留。选择本次需要继续的一项工作；不会按旧标记自动启动完整方案。';
  }
  if (workflow.requested.includes('monitoring') && !active && !failed) {
    stage=geoAutomationEnabled(project)?'ready':'blocked';title=geoAutomationEnabled(project)?'自动监测已开启，等待下一轮':'尚未开启自动监测';detail='已有测量任务和结果保留。查看当前引擎与覆盖周期和后续复测安排。';
    next={kind:'step',step:'monitoring',label:'查看范围与自动监测设置'};
  }
  if (['paused','archived'].includes(project.status)) {
    stage='paused';title=project.status === 'paused' ? '项目已暂停' : '项目已归档'; detail='已有结果和运行记录仍可查看。'; next={kind:'view',step:current ?? undefined,label:'查看项目与保留结果'};
  }
  const intents = ['answers', 'optimize', 'strategy'].map(key => {
    const starter = GEO_STARTERS.find(item => item.key === key)!;
    return {key,label:starter.label,draft:starter.draft(product)};
  });
  return {product,workflow,stage,title,detail,requested,current,waitingFor,retained,next,canConverse,runId:current ? workflow.steps[current].runId as string | null : null,intents};
}
