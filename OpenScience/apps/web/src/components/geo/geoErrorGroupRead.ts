import {getGeoDiagnosis,type GeoErrorRow} from '@/lib/geoClient';
import {claimRows,type ClaimRow} from './spine/errorModel';

/** A drawer reads its complete addressed group, independently of list filters and pagination. */
export async function readGeoErrorGroup(
  geoId:string,
  selectionRef:string|null|undefined,
  fingerprint:string,
  read:typeof getGeoDiagnosis=getGeoDiagnosis,
):Promise<ClaimRow|null>{
  const changed=()=>new Error('The selected error group is incomplete or changed. Refresh the selection.');
  if(!selectionRef||!fingerprint)throw changed();
  const rows:GeoErrorRow[]=[],seen=new Set<string>();
  let offset=0,total:number|null=null,revision:string|null=null;
  for(let request=0;request<40;request+=1){
    const filters={errorFingerprint:fingerprint,errorLimit:500,errorOffset:offset};
    const value=await read(geoId,{selectionRef},filters),page=value.errorPage;
    if(value.selection?.reference!==selectionRef||!Array.isArray(value.errors)||!page
      ||!Number.isSafeInteger(page.total)||page.total<0||page.total>20000||page.offset!==offset
      ||page.limit!==500||page.shown!==value.errors.length||value.errors.length!==Math.min(500,page.total-offset)
      ||total!==null&&page.total!==total||!page.populationRevision||revision!==null&&page.populationRevision!==revision)throw changed();
    if(claimRows(value.errors).some(group=>group.key!==fingerprint))throw changed();
    total=page.total;revision=page.populationRevision;
    for(const row of value.errors){if(!row.id||seen.has(row.id))throw changed();seen.add(row.id);rows.push(row);}
    if(rows.length>total)throw changed();
    if(!page.more){
      if(page.nextOffset!==null||rows.length!==total)throw changed();
      return claimRows(rows).find(group=>group.key===fingerprint)??null;
    }
    const next=page.nextOffset;
    if(typeof next!=='number'||!Number.isSafeInteger(next)||next!==offset+value.errors.length||next<=offset||next>=total)throw changed();
    offset=next;
  }
  throw changed();
}
