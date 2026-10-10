/** Platform-written longitudinal tables; numerical cells bind to the frozen
 * report model, exactly like the existing statistical-engine result tables. */
import { renderVcrNumbers } from './vcrRender.mjs';

const METRICS = {mae:'平均绝对误差',rmse:'均方根误差',crps:'分布误差（CRPS）',correlation:'相关系数',
  auroc:'AUROC',averagePrecision:'平均精确率',brier:'Brier 分数',intervalCoverage:'预测区间覆盖率',nominalCoverage:'名义覆盖率'};
const BASELINES = {persistence:'最近一次观测',trend:'既往线性趋势',calibration_prevalence:'校准集事件比例',calibration_kaplan_meier:'校准集 Kaplan–Meier'};

/** @param {any[]} records @returns {import('./vcrModelDocuments.mjs').VcrDocumentBlock[]} */
export function longitudinalInputBlocks(records) {
  if (!records.length) return [];
  return [{type:'table',title:'纵向研究的输入与模型版本',columns:['记录','模型及版本','预测起点','输入历史','内容哈希'],rows:records.map(row => [
    row.id, row.model ? `${row.model.name ?? '未知'} · ${row.model.version ?? '未知'}` : row.kind === 'history' ? '历史快照' : '试验基准',
    row.origin ?? '—',row.historyId ?? '—',row.hash])}];
}

/** @param {any} model @returns {import('./vcrModelDocuments.mjs').VcrDocumentBlock[]} */
export function longitudinalResultBlocks(model) {
  /** @type {import('./vcrModelDocuments.mjs').VcrDocumentBlock[]} */ const blocks = [];
  const records = model.modelAnalysis?.longitudinal?.records ?? [];
  /** @param {string} path @param {string} [format] */
  const n = (path,format = 'f3') => renderVcrNumbers(`{{n:${path}|${format}}}`,model).text;
  for (const [i,record] of records.entries()) {
    const s = record.summary, base = `modelAnalysis.longitudinal.records[${i}].summary`;
    if (record.kind === 'prediction') {
      blocks.push({type:'facts',title:`预测：${s.model?.name ?? '外部模型'} · ${s.model?.version ?? '版本未知'}`,rows:[
        ['记录',record.id],['历史',s.historyId],['终点',`${s.endpoint?.code ?? '未知'} · ${s.endpoint?.unit ?? '未知'}`],
        ['接收／可用／无效预测',`${n(`${base}.received`,'int')} / ${n(`${base}.accepted`,'int')} / ${n(`${base}.invalidRows`,'int')}`],
        ['用途',s.dataClass === 'synthetic' ? '合成数据流程检验' : '研究预测'] ]});
      if (s.failures?.length) blocks.push({type:'list',title:'未完成的预测部分',items:s.failures.map((/** @type {any} */ f) => String(f.code))});
      continue;
    }
    if (record.kind === 'prediction_interruption') {
      blocks.push({type:'text',text:`预测中断：${s.code}；已完成的部分保留。`});continue;
    }
    if (!['evaluation','trial_evaluation','comparison'].includes(record.kind)) continue;
    blocks.push({type:'facts',title:record.kind === 'trial_evaluation' ? '独立试验基准' : record.kind === 'comparison' ? '配对模型情景比较' : '纵向预测验证',rows:[
      ['记录',record.id],['输入记录',record.parentId ?? '—'],['验证来源',s.dataClass === 'synthetic' ? '合成数据流程检验，不是临床验证' : record.kind === 'trial_evaluation' ? '已保留的试验证据' : '纵向观测'],
      ['划分',typeof s.split === 'string' ? s.split : '—'],['模型训练数据重叠',s.trainingOverlap ?? '未知'] ]});
    if (record.kind === 'trial_evaluation') blocks.push({type:'facts',rows:[['纳入／排除比较',`${n(`${base}.comparisons`,'int')} / ${n(`${base}.excluded`,'int')}`]]});
    for (const [j,group] of (s.groups ?? []).entries()) {
      const p = `${base}.groups[${j}]`, title = `${n(`${p}.horizonDays`,'int')} 天${group.endpoint ? ` · ${group.endpoint} · ${group.scale} · ${group.unit}` : ''}`;
      if (record.kind === 'comparison') {
        blocks.push({type:'table',title,columns:['配对受试者','预测均值差','抽样区间'],rows:[[
          n(`${p}.subjects`,'int'),n(`${p}.meanDifference`),`${n(`${p}.lower`)} – ${n(`${p}.upper`)}`]]});continue;
      }
      if (record.kind === 'evaluation') blocks.push({type:'table',title,columns:['应预测','已验证','缺少预测','无效预测','缺少结局'],rows:[[
        n(`${p}.requested`,'int'),n(`${p}.evaluated`,'int'),n(`${p}.missingForecasts`,'int'),n(`${p}.invalidForecasts`,'int'),n(`${p}.missingOutcomes`,'int')]]});
      const keys = Object.keys(group.metrics ?? {}).filter(key => Object.hasOwn(METRICS,key));
      if (keys.length) blocks.push({type:'table',title:`${title} · 指标`,columns:['指标','估计','95% 抽样区间'],rows:keys.map(key => [
        METRICS[key],n(`${p}.metrics.${key}.value`),`${n(`${p}.metrics.${key}.lower`)} – ${n(`${p}.metrics.${key}.upper`)}`])});
      for (const [name,baseline] of Object.entries(/** @type {Record<string,any>} */ (group.baselines ?? {}))) {
        const b = `${p}.baselines.${name}`;
        blocks.push({type:'table',title:`${title} · ${BASELINES[name] ?? name}（相同受试者）`,columns:['指标','模型','基线','模型减基线','点估计较优'],
          rows:Object.keys(baseline.comparisons ?? {}).map(key => [METRICS[key] ?? key,n(`${b}.comparisons.${key}.model`),n(`${b}.comparisons.${key}.baseline`),
            n(`${b}.comparisons.${key}.modelMinusBaseline`),{model:'模型',baseline:'基线',equal:'相同'}[baseline.comparisons[key].preferred] ?? '未知'])});
      }
      if (group.baseline?.metrics) blocks.push({type:'table',title:`${title} · 其他试验家族均值基线`,columns:['指标','模型','基线'],
        rows:keys.filter(key => group.baseline.metrics[key]).map(key => [METRICS[key],n(`${p}.metrics.${key}.value`),n(`${p}.baseline.metrics.${key}.value`)])});
      if (group.distributionAvailability) blocks.push({type:'facts',rows:[['预测样本／分位区间／标准差可用记录',
        `${n(`${p}.distributionAvailability.sampleRows`,'int')} / ${n(`${p}.distributionAvailability.intervalRows`,'int')} / ${n(`${p}.distributionAvailability.sdRows`,'int')}`]]});
    }
    if (s.issues?.length) blocks.push({type:'list',title:'未纳入比较的原因',items:[...new Set(s.issues.map((/** @type {any} */ issue) => String(issue.code)))]});
  }
  if (blocks.length) blocks.push({type:'note',text:'基线比较是相同样本的点估计比较，没有进行差异显著性检验。预测区间、患者抽样区间和模型参数不确定性含义不同；模型情景差异不能直接解释为因果治疗效果。CRPS 需要预测样本，覆盖率需要预测分位数，缺少时显示未计算。'});
  return blocks;
}
