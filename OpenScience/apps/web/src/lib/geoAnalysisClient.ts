import { productRequest } from './productClient';
import { geoReadScopeQuery, type GeoReadScope, type GeoMetricMembers } from './geoReadScope';
import type { GeoCell } from './geoClient';
export interface GeoAnalysisDescriptor { viewId:'V01'|'V02'; metricId?:string|null; dimension?:'project'|'engine'|'group' }
export interface GeoAnalysisValue {value:number|null;state:string;metric:GeoCell|null;members:GeoMetricMembers|null}
export interface GeoAnalysisRow {key:string;label:string;metricId:string;dimensions:{period?:string;date?:string|null;engine?:string|null;groupId?:string|null};values:Record<string,GeoAnalysisValue>}
export interface GeoAnalysisView {chart?:{labels:string[];series:Array<{key:string;label:string;engine?:string|null;values:Array<number|null>}>};view:GeoAnalysisDescriptor;selection:{reference:string};digest:string;columns:Array<{key:string;label:string}>;rows:GeoAnalysisRow[];page:{total:number;shown:number;nextOffset:number|null};availability:{status:string}}
export function getGeoAnalysis(geoId:string,scope:GeoReadScope|undefined,view:GeoAnalysisDescriptor,offset=0,expectedDigest?:string) {
  const query=new URLSearchParams(geoReadScopeQuery(scope));
  for(const [key,value] of Object.entries({...view,offset,limit:20,expectedDigest})) if(value!=null) query.set(key,String(value));
  return productRequest<GeoAnalysisView>(`/geo/projects/${encodeURIComponent(geoId)}/analysis?${query}`);
}
