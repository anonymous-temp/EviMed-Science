/** Calendar spending belongs to the immutable policy that authorized the call, including older unfinished missions.
 * @param {any[]} missions @param {any[]} spending @param {string} beforeMonth */
export function evolutionMonthlyObservations(missions,spending,beforeMonth){
 const rows=[];
 for(const mission of missions){
  const costs=spending.filter(row=>row.mission_id===mission.id&&row.month<beforeMonth);
  const completionMonth=mission.completedAt?.slice(0,7);
  const months=new Set([...costs.map(row=>row.month),mission.month,completionMonth].filter(month=>month&&month<beforeMonth));
  for(const month of months){
   const measured=costs.find(row=>row.month===month),completedThisMonth=mission.completed===true&&completionMonth===month;
   const observations=(mission.regressionObservations??[]).filter(item=>item.at?.slice(0,7)===month);
   const unknownPublished=completedThisMonth&&mission.confirmedPromotions>0&&!Number.isFinite(mission.regressions);
   rows.push({...mission,month,researchCostCny:Number(measured?.incomplete??0)>0?null:Number(measured?.cost??0),
    costBasis:'usage-call-created-at-calendar-month',policyAttribution:'immutable-mission-policy',completed:completedThisMonth,
    confirmedPromotions:completedThisMonth?Number(mission.confirmedPromotions??0):0,newSupportedFamilies:completedThisMonth?Number(mission.newSupportedFamilies??0):0,
    regressions:unknownPublished?null:observations.filter(item=>item.regressed).length,
    regressionBasis:unknownPublished?'missing-published-candidate-verdict':observations.length?'dated-independent-verdict-observations':'no-observed-activated-candidate-regression-in-month',
    // An audit pertains to the candidate completion cohort, not every month it incurred cost.
    ...(completionMonth===month?{}:{auditReceiptId:null,developmentGain:null,auditGain:null,overfitGap:null})});
  }
 }
 return rows;
}
