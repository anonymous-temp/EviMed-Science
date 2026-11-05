import { sourcePrivacyOf } from '@evimed/domain';

/** Server source receipts contain bounded identifiers/digests, never source prose. Kernel events cannot attest ordinary privacy.
 * @param {readonly any[]} input @param {{trusted?:boolean,inheritedPrivacy?:any}} [options] */
export function sourceReceiptState(input,{trusted=false,inheritedPrivacy=null}={}) {
  const found=new Map();let incomplete=false;
  for(const item of Array.isArray(input)?input:[]){
    if(!item||typeof item.id!=='string'||item.id.length>200||!/^[a-f0-9]{64}$/.test(item.contentDigest??'')){incomplete=true;continue;}
    const sourcePrivacy=trusted?sourcePrivacyOf(item):sourcePrivacyOf({sourcePrivacy:{schemaVersion:1,classification:'unclassified'},originalSources:[item]});
    const key=`${item.id}:${item.contentDigest}`;
    const held=found.get(key);
    found.set(key,{id:item.id,contentDigest:item.contentDigest,attribution:{schemaVersion:1,origins:Array.isArray(item.attribution?.origins)?item.attribution.origins.filter(origin=>typeof origin==='string').slice(0,16):['unknown'],confirmed:false},sourcePrivacy:held?sourcePrivacyOf({originalSources:[held,{sourcePrivacy}]}):sourcePrivacy});
  }
  const all=[...found.values()],originalSources=all.slice(0,40),sourcePrivacy=sourcePrivacyOf({originalSources:all,...(inheritedPrivacy?{sourcePrivacy:inheritedPrivacy}:{})});
  if((incomplete||all.length>40)&&sourcePrivacy.classification==='ordinary'){sourcePrivacy.classification='unclassified';sourcePrivacy.reasons.push('source-receipt-incomplete');}
  return {originalSources,sourcePrivacy};
}
