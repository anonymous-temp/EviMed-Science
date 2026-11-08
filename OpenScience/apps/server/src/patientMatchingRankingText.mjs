/** One bounded, source-literal ranking view across lexical, dense and supplied candidate pools. */
import {segmentCriteria} from '@evimed/domain';
export const MATCHING_RANKING_VIEW='balanced-source-1500-v1';
export const ELIGIBILITY_FULL_VIEW='eligibility-full-v1';
const ELIGIBILITY_FULL_CAP=12000;
/** The view id a deployment's `patientMatchingRankView` setting (`balanced` | `eligibility-full`) names; anything else is the default. */
export const rankingViewId=(/** @type {unknown} */ setting)=>setting==='eligibility-full'?ELIGIBILITY_FULL_VIEW:MATCHING_RANKING_VIEW;
const text=value=>typeof value==='string'?value.trim():'';
const list=value=>Array.isArray(value)?value.map(item=>typeof item==='string'?item:item?.name??'').filter(Boolean).join('; '):text(value);
const bounded=(value,limit)=>value.length<=limit?value:limit>3?`${value.slice(0,Math.ceil((limit-3)/2))}...${value.slice(-Math.floor((limit-3)/2))}`:value.slice(0,limit);
/** This is a retrieval representation, never a replacement for the full clinical trial profile. */
export function patientMatchingRankingDocument(candidate,view=MATCHING_RANKING_VIEW){
 const raw=candidate.record??candidate,eligibility=text(raw.eligibility??raw.eligibilityText);
 const preserved=eligibility&&!['in_record','not_in_listing'].includes(eligibility)?eligibility:text(raw.eligibilityHead);
 const sections=segmentCriteria(preserved),groups={inclusion:[],exclusion:[],unsectioned:[]};
 for(const clause of sections)(groups[clause.kind]??groups.unsectioned).push(clause.text);
 if(view===ELIGIBILITY_FULL_VIEW)return fullEligibilityDocument(raw,candidate,groups,preserved,sections.length);
 const slots=[['title',text(raw.title),180],['conditions',list(raw.conditions),140],['interventions',list(raw.interventions),140],
  ['demographics',[raw.sexStated??raw.sex,raw.ageStated??raw.minimumAge,raw.maximumAge].filter(Boolean).join('; '),80],
  ['summary',text(raw.summary??raw.briefSummary??raw.brief_summary??candidate.description?.briefSummary),180],
  ['inclusion',groups.inclusion.join('\n'),240],['exclusion',groups.exclusion.join('\n'),240],['unclassified',groups.unsectioned.join('\n')||(!sections.length?preserved:''),180]];
 const value=slots.filter(([,body])=>body).map(([name,body,limit])=>`${name}: ${bounded(String(body),Number(limit))}`).join('\n');
 return {text:value,profile:MATCHING_RANKING_VIEW,sourceEligibilityChars:preserved.length,representedEligibilityChars:slots.slice(5).reduce((sum,[,body,limit])=>sum+Math.min(String(body).length,Number(limit)),0),truncated:slots.some(([,body,limit])=>String(body).length>Number(limit))};
}

/** Criteria whole under a total cap: the head of the record first, then inclusion, exclusion and the unsectioned rest, the later ones trimmed first. */
function fullEligibilityDocument(/** @type {any} */ raw,/** @type {any} */ candidate,/** @type {Record<string,string[]>} */ groups,/** @type {string} */ preserved,/** @type {number} */ sectioned){
 const head=[['title',text(raw.title),300],['conditions',list(raw.conditions),300],['interventions',list(raw.interventions),400],
  ['demographics',[raw.sexStated??raw.sex,raw.ageStated??raw.minimumAge,raw.maximumAge].filter(Boolean).join('; '),120],
  ['summary',text(raw.summary??raw.briefSummary??raw.brief_summary??candidate.description?.briefSummary),400]];
 let truncated=head.some(([,body,limit])=>String(body).length>Number(limit));
 const lines=head.filter(([,body])=>body).map(([name,body,limit])=>`${name}: ${bounded(String(body),Number(limit))}`);
 let room=ELIGIBILITY_FULL_CAP-lines.join('\n').length;
 let represented=0;
 for(const [name,body] of [['inclusion',groups.inclusion.join('\n')],['exclusion',groups.exclusion.join('\n')],['unclassified',groups.unsectioned.join('\n')||(!sectioned?preserved:'')]]){
  if(!body)continue;
  const allowance=Math.max(0,room-name.length-3);
  if(allowance<=0){truncated=true;continue;}
  const shown=bounded(body,allowance);
  if(shown.length<body.length)truncated=true;
  lines.push(`${name}: ${shown}`);room-=name.length+3+shown.length;represented+=shown.length;
 }
 return {text:lines.join('\n'),profile:ELIGIBILITY_FULL_VIEW,sourceEligibilityChars:preserved.length,representedEligibilityChars:represented,truncated};
}
