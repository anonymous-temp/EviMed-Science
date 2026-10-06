/** Auditable progress from confirmed outcomes. An unmeasured improvement is null, not zero.
 * @param {{from:string,to:string,missions?:any[],verdicts?:any[],archives?:any[],waiters?:any[],trials?:any[],costCny?:number|null}} input */
export function evolutionProgress({from,to,missions=[],verdicts=[],archives=[],waiters=[],trials=[],costCny=null}) {
  const payload = row => ({id:row.id,...(row.payload??row)});
  const inWindow = row => {const at=Date.parse(row.completedAt??row.at??row.decidedAt??'');return at>=Date.parse(from)&&at<Date.parse(to);};
  const v=verdicts.map(payload).filter(inWindow),m=missions.map(payload).filter(inWindow);
  const promoted=archives.map(payload).filter(row=>row.status==='promoted'&&inWindow({at:row.activatedAt})).flatMap(archive=>{
    const verdict=verdicts.map(payload).find(row=>row.id===archive.verdictId&&(row.archiveId??row.candidateId)===archive.id);
    return verdict?.promote&&verdict.confirmatory&&verdict.receiptValid&&!verdict.auditOnly?[verdict]:[];
  });
  const gaps=v.filter(row=>Number.isFinite(row.developmentGain)&&Number.isFinite(row.auditGain));
  const pruned=promoted.filter(row=>row.outcome==='simplified');
  const delays=m.filter(row=>row.confirmedPromotions>0&&Date.parse(row.createdAt)<=Date.parse(row.completedAt)).map(row=>(Date.parse(row.completedAt)-Date.parse(row.createdAt))/86400000).sort((a,b)=>a-b);
  const median=delays.length?(delays[Math.floor((delays.length-1)/2)]+delays[Math.floor(delays.length/2)])/2:null;
  return {from,to,costCny,confirmedVersions:promoted.map(row=>({id:row.candidateId,moduleId:row.moduleId,outcome:row.outcome})),
    newSupportedFamilies:m.reduce((sum,row)=>sum+(row.confirmedOnNewTasks?Number(row.newSupportedFamilies??0):0),0),
    resumedAndCompleted:waiters.map(payload).filter(row=>row.status==='resolved'&&row.completedResearchAt&&Date.parse(row.completedResearchAt)>=Date.parse(from)&&Date.parse(row.completedResearchAt)<Date.parse(to)).length,
    medianOpportunityToAssetDays:median,overfitGap:gaps.length?gaps.reduce((sum,row)=>sum+row.developmentGain-row.auditGain,0)/gaps.length:null,
    prunedMechanisms:pruned.reduce((sum,row)=>sum+Number(row.removedMechanisms??1),0),
    pruningNonRegression:pruned.length?pruned.filter(row=>row.score>=row.baseline-row.delta).length/pruned.length:null,
    promotionRate:v.length?v.filter(row=>row.promote&&row.confirmatory&&row.receiptValid&&!row.auditOnly).length/v.length:null,
    policyAdopted:trials.map(payload).filter(row=>inWindow(row)&&row.status==='adopted').length,
    policyRolledBack:trials.map(payload).filter(row=>inWindow(row)&&row.status==='rolled_back').length,
    confirmedGainPerCny:costCny>0?(promoted.length+m.reduce((sum,row)=>sum+(row.confirmedOnNewTasks?Number(row.newSupportedFamilies??0):0),0))/costCny:null};
}
/** @param {any} progress */
export function renderEvolutionProgress(progress) {
  if (!progress) return '今天平台进步了什么\n尚无已确认的新进展。';
  const cost=Number.isFinite(progress.costCny)?`${progress.costCny.toFixed(2)} 元`:'花费待结算';
  const completed=Number.isFinite(progress.resumedAndCompleted)?`唤醒并完成 ${progress.resumedAndCompleted} 项研究`:'研究续跑尚无可汇总结果';
  return `今天平台进步了什么\n新确认 ${progress.confirmedVersions.length} 个版本，新增支持 ${progress.newSupportedFamilies} 类任务，${completed}，删减 ${progress.prunedMechanisms} 个机制；${cost}。`;
}
