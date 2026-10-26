import {describe,expect,it,vi} from 'vitest';
import type {GeoDiagnosis,GeoErrorRow} from '@/lib/geoClient';
import {readGeoErrorGroup} from './geoErrorGroupRead';
const error=(id:string,extra:Partial<GeoErrorRow>={}):GeoErrorRow=>({id,fingerprint:'chosen',engine:'deepseek',statement:'Preserved statement',status:'open',severity:'S1',claimId:null,questionId:'q',firstSnapshotId:'s',lastSnapshotId:'s',judgmentState:'active',...extra} as GeoErrorRow);
const page=(rows:GeoErrorRow[],total=rows.length,offset=0,more=false,nextOffset:number|null=null)=>({selection:{reference:'gsel_exact'},errors:rows,errorPage:{populationRevision:"stable",total,offset,shown:rows.length,limit:500,more,nextOffset}} as GeoDiagnosis);
describe('the exact addressed error group',()=>{
 it('reads the full group independently of list filters and includes closed and withdrawn records',async()=>{
  const first=Array.from({length:500},(_,i)=>error('e'+i));
  const read=vi.fn().mockResolvedValueOnce(page(first,502,0,true,500)).mockResolvedValueOnce(page([error('closed',{status:'closed'}),error('withdrawn',{judgmentState:'withdrawn'})],502,500));
  const result=await readGeoErrorGroup('geo','gsel_exact','chosen',read);
  expect(result?.rows).toHaveLength(502);
  expect(read.mock.calls).toEqual([['geo',{selectionRef:'gsel_exact'},{errorFingerprint:'chosen',errorLimit:500,errorOffset:0}],['geo',{selectionRef:'gsel_exact'},{errorFingerprint:'chosen',errorLimit:500,errorOffset:500}]]);
 });
 it('an empty complete group means unavailable in this selection',async()=>{
  expect(await readGeoErrorGroup('geo','gsel_exact','chosen',vi.fn().mockResolvedValue(page([])))).toBeNull();
 });
 it.each(['scope','key','more','count','bound','revision'])('refuses an inconsistent %s result',async kind=>{
  const value=page([error('e')]);
  if(kind==='revision')value.errorPage!.populationRevision=undefined;
  if(kind==='scope')value.selection!.reference='other';
  if(kind==='key')value.errors[0]=error('foreign',{fingerprint:'different',claimId:'chosen'});
  if(kind==='more')Object.assign(value.errorPage!,{more:true,nextOffset:0});
  if(kind==='count')value.errorPage!.total=2;
  if(kind==='bound')Object.assign(value.errorPage!,{total:20001,more:true,nextOffset:1});
  await expect(readGeoErrorGroup('geo','gsel_exact','chosen',vi.fn().mockResolvedValue(value))).rejects.toThrow();
 });
 it('refuses duplicate rows or a changed population across pages',async()=>{
  const first=page(Array.from({length:500},(_,i)=>error('e'+i)),501,0,true,500);
  for(const last of [page([error('e0')],501,500),page([error('next')],502,500),{...page([error('next')],501,500),errorPage:{...page([],501,500).errorPage!,shown:1,populationRevision:'changed'}}]){
   await expect(readGeoErrorGroup('geo','gsel_exact','chosen',vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(last))).rejects.toThrow();
  }
 });
 it('does not replace an absent selection or a server refusal with another scope',async()=>{
  const read=vi.fn().mockRejectedValue(new Error('Scope changed'));
  await expect(readGeoErrorGroup('geo',null,'chosen',read)).rejects.toThrow();expect(read).not.toHaveBeenCalled();
  await expect(readGeoErrorGroup('geo','gsel_exact','chosen',read)).rejects.toThrow('Scope changed');expect(read).toHaveBeenCalledOnce();
 });
});
