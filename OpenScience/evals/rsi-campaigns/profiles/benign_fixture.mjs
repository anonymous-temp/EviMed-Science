/** Public synthetic orchestration fixture. It certifies no medical or statistical benefit. */
import { digest } from '../campaign_runner.mjs';
export function benignCampaignFixture() {
 const registration={baselineThreshold:85,thresholds:[85]};
 const pool=id=>({complete:true,day:'2026-10-25',window:{start:'2026-10-25T00:00:00Z',end:'2026-10-26T00:00:00Z'},events:{},genreFloors:{},congressActive:false,preprintPlaces:2,preprintMinScore:80,scoreVersion:'current',rows:[{id,genre:'paper',platform:'journal',channel:null,lane:null,practice_changing:null,practice_zh:null,source_type:'journal',source_source_type:'journal',source_authority:3,primary_source_id:`synthetic-${id}`,lang:'en',title_raw:'Synthetic orchestration fixture',score_total:95,score_version:'current',verification:'passed',flags:[],publication_types:['Journal Article'],summarized:true,selected:false,selected_rule:null,safety_alert:false,event_id:null,beside_selected:false,adds_value:null,evidence_type:'randomized-trial',visible_at:'2026-10-25T00:00:00Z'}],labels:[{id,label:{worth:'pick'},n:1}]});
 const sources={development:pool('synthetic-dev'),confirmation:pool('synthetic-confirm')};
 const target={surface:'frontier-selection',dependencyDigest:'a'.repeat(64),baselineRevision:'synthetic-baseline'};
 const manifest={schemaVersion:1,id:'benign-lifecycle',surface:'frontier-selection',candidateKind:'policy',claim:'efficiency',automated:true,createdAt:'2026-10-26T00:00:00Z',deadline:'2026-10-27T00:00:00Z',budget:{campaignCny:1000,monthCny:30000},models:Object.fromEntries(['solver','improver','reviewer'].map(role=>[role,{provider:'deepseek',model:'deepseek-flash'}])),target,registration:{digest:digest(registration),procedure:'synthetic-v1',claim:'efficiency'},data:{classification:'synthetic',sources:Object.entries(sources).map(([role,value])=>({id:role,digest:digest(value),role,exposure:'synthetic'}))}};
 return {manifest,inputs:{registration,target,sources}};
}
