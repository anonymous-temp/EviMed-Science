/** One bounded, source-literal ranking view across lexical, dense and supplied candidate pools. */
import {segmentCriteria} from '@evimed/domain';
import {trialRecordText} from '@evimed/patient-matching-core';
export const MATCHING_RANKING_VIEW='balanced-source-1500-v1';
/** The whole trial record in the fit stage's field order, bounded at 12,000 characters (`trialRecordText`). Measured 2026-11-08 on the 78
 * development patients with the eligibility instruction: rerank-only nDCG@10 0.638 against 0.602 for the balanced view. */
export const TRIAL_RECORD_VIEW='trial-record-12k-v1';
const TRIAL_RECORD_CAP=12000;
/** The view id a deployment's `patientMatchingRankView` setting (`trial-record` | `balanced`) names; the trial record is the default. */
export const rankingViewId=(/** @type {unknown} */ setting)=>setting==='balanced'?MATCHING_RANKING_VIEW:TRIAL_RECORD_VIEW;
const text=value=>typeof value==='string'?value.trim():'';
const list=value=>Array.isArray(value)?value.map(item=>typeof item==='string'?item:item?.name??'').filter(Boolean).join('; '):text(value);
const bounded=(value,limit)=>value.length<=limit?value:limit>3?`${value.slice(0,Math.ceil((limit-3)/2))}...${value.slice(-Math.floor((limit-3)/2))}`:value.slice(0,limit);
/** This is a retrieval representation, never a replacement for the full clinical trial profile. */
export function patientMatchingRankingDocument(candidate,view=MATCHING_RANKING_VIEW){
 const raw=candidate.record??candidate,eligibility=text(raw.eligibility??raw.eligibilityText);
 const preserved=eligibility&&!['in_record','not_in_listing'].includes(eligibility)?eligibility:text(raw.eligibilityHead);
 const sections=segmentCriteria(preserved),groups={inclusion:[],exclusion:[],unsectioned:[]};
 for(const clause of sections)(groups[clause.kind]??groups.unsectioned).push(clause.text);
 if(view===TRIAL_RECORD_VIEW){const full=trialRecordText(raw,{limit:Number.MAX_SAFE_INTEGER}),shown=trialRecordText(raw,{limit:TRIAL_RECORD_CAP});return {text:shown,profile:TRIAL_RECORD_VIEW,sourceEligibilityChars:preserved.length,representedEligibilityChars:preserved.length,truncated:full.length>shown.length};}
 const slots=[['title',text(raw.title),180],['conditions',list(raw.conditions),140],['interventions',list(raw.interventions),140],
  ['demographics',[raw.sexStated??raw.sex,raw.ageStated??raw.minimumAge,raw.maximumAge].filter(Boolean).join('; '),80],
  ['summary',text(raw.summary??raw.briefSummary??raw.brief_summary??candidate.description?.briefSummary),180],
  ['inclusion',groups.inclusion.join('\n'),240],['exclusion',groups.exclusion.join('\n'),240],['unclassified',groups.unsectioned.join('\n')||(!sections.length?preserved:''),180]];
 const value=slots.filter(([,body])=>body).map(([name,body,limit])=>`${name}: ${bounded(String(body),Number(limit))}`).join('\n');
 return {text:value,profile:MATCHING_RANKING_VIEW,sourceEligibilityChars:preserved.length,representedEligibilityChars:slots.slice(5).reduce((sum,[,body,limit])=>sum+Math.min(String(body).length,Number(limit)),0),truncated:slots.some(([,body,limit])=>String(body).length>Number(limit))};
}

