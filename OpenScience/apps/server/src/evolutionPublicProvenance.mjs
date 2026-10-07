/** Public chronology is primary-source evidence, never a journal-date guess or a content hash. */
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const doiOf=value=>{const raw=String(value??'').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').replace(/^doi:/i,'').toLowerCase();return /^10\.\d{4,9}\/[^\s<>]+$/.test(raw)?raw:null;};
/** Exact calendar days only. Partial dates cannot establish freshness. @param {any} parts */
export function publicCalendarDate(parts){if(!Array.isArray(parts)||parts.length!==3||parts.some(n=>!Number.isInteger(n)))return null;const [year,month,day]=parts;if(year<1900||year>2200)return null;const date=new Date(Date.UTC(year,month-1,day));return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?date.toISOString():null;}
/** @param {{service:any,fetchImpl?:typeof fetch,now?:()=>Date,loadReleaseSource?:((proof:any,row:any)=>Promise<any>)|null}} dependencies */
export function createEvolutionPublicProvenance({service,fetchImpl=fetch,now=()=>new Date(),loadReleaseSource=null}){
 async function get(url,format="json"){try{const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{accept:'application/json'}});if(!response.ok)return null;let bytes;if(response.body?.getReader){const reader=response.body.getReader(),chunks=[];let size=0;try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>512*1024){await reader.cancel();return null;}chunks.push(Buffer.from(item.value));}}finally{reader.releaseLock();}bytes=Buffer.concat(chunks);}else bytes=Buffer.from(await response.text());if(bytes.length>512*1024)return null;const digest=createHash("sha256").update(bytes).digest("hex");const id=`evolution-public-source-version-${digest}`;if(!await service.get(id))await service.save('public-source-version',id,{url,sha256:digest,bodyBase64:bytes.toString('base64'),fetchedAt:now().toISOString(),origin:'external-source'});return {data:format==='json'?JSON.parse(bytes.toString('utf8')):bytes.toString('utf8'),evidence:{id,url,sha256:digest}};}catch{return null;}}
 const aliasRecordId=alias=>`evolution-public-provenance-alias-${hash(alias).slice(0,32)}`;
 /** @param {string[]} aliases */
 async function recordForAliases(aliases){for(const alias of aliases){const pointer=await service.get(aliasRecordId(alias));const row=pointer?.payload?.recordId?await service.get(pointer.payload.recordId):null;if(row)return row;}return null;}
 async function resolvePaper(paper){
  const unresolved=(evidence=[],root=null,aliases=[])=>({firstPublicAt:null,firstPublicEvidenceId:null,sourceRoot:root,aliases,provenanceResolved:false,provenanceEvidence:evidence});
  const arxiv=/^(?:arxiv:|https?:\/\/arxiv\.org\/abs\/|(?:doi:)?10\.48550\/arxiv\.)(\d{4}\.\d{4,5})(?:v\d+)?$/i.exec(String(paper.identity??paper.doi??paper.url??""));
  if(arxiv){const identifier=arxiv[1],root=`arxiv:${identifier}`;const found=await get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(identifier)}`,'text');if(!found)return unresolved([],root,[root]);
    const entry=/<entry>([\s\S]*?)<\/entry>/.exec(found.data)?.[1]??'';
    const entryId=/<id>https?:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5})(?:v\d+)?<\/id>/.exec(entry)?.[1];
    const published=/<published>([^<]+)<\/published>/.exec(entry)?.[1];
    if(entryId!==identifier||!Number.isFinite(Date.parse(published??''))||Date.parse(published)>now().getTime())return unresolved([found.evidence],root,[root]);
    const id=`evolution-public-provenance-${hash(root).slice(0,32)}`,prior=await service.get(id);const earlier=prior?.payload.firstPublicAt&&prior.payload.firstPublicAt<new Date(published).toISOString();
    const payload={firstPublicAt:earlier?prior.payload.firstPublicAt:new Date(published).toISOString(),firstPublicEvidenceId:earlier?prior.payload.firstPublicEvidenceId:found.evidence.id,sourceRoot:root,aliases:[root,`doi:10.48550/arxiv.${identifier}`],provenanceResolved:true,provenanceEvidence:[found.evidence],updatedAt:now().toISOString()};await service.save('public-provenance',id,payload,prior);return payload;
  }
  let doi=doiOf(paper.doi??paper.identity??paper.identityKey??paper.url);const pmid=/^(?:pmid:)?(\d+)$/.exec(String(paper.pmid??paper.identity??''))?.[1],pmcid=/^(?:pmcid:)?(PMC\d+)$/i.exec(String(paper.pmcid??paper.identity??''))?.[1];
  const evidence=[],dates=[],aliases=new Set(),registryIds=new Set();let ambiguous=false;
  const addDate=(date,id)=>{const parsed=Date.parse(date??'');if(Number.isFinite(parsed)&&parsed<=now().getTime())dates.push({at:new Date(parsed).toISOString(),evidenceId:id});};
  if(pmid||pmcid){const query=pmid?`EXT_ID:${pmid} AND SRC:MED`:`PMCID:${pmcid.toUpperCase()}`;const found=await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=2`);if(!found)return unresolved();evidence.push(found.evidence);const rows=(found.data.resultList?.result??[]).filter(r=>pmid?String(r.id)===pmid&&r.source==='MED':String(r.pmcid??'').toUpperCase()===pmcid.toUpperCase());if(rows.length!==1)return unresolved(evidence);const row=rows[0];doi=doiOf(row.doi);if(row.source==='MED')aliases.add(`pmid:${row.id}`);if(row.pmcid)aliases.add(String(row.pmcid).toUpperCase());if(/^\d{4}-\d{2}-\d{2}$/.test(row.firstPublicationDate??''))addDate(row.firstPublicationDate,found.evidence.id);}
  if(!doi&&!pmid&&!pmcid)return unresolved();
  const queue=doi?[doi]:[],visited=new Set();
  while(queue.length&&visited.size<8){const current=queue.shift();if(visited.has(current))continue;visited.add(current);aliases.add(`doi:${current}`);const found=await get(`https://api.crossref.org/works/${encodeURIComponent(current)}`);if(!found){ambiguous=true;continue;}evidence.push(found.evidence);const work=found.data.message;if(doiOf(work?.DOI)!==current){ambiguous=true;continue;}let exactDates=0;
   for(const field of ['posted','published-online','published-print','published']){const parts=work[field]?.['date-parts']?.[0];if(!parts)continue;const date=publicCalendarDate(parts);if(date){addDate(date,found.evidence.id);exactDates++;}else ambiguous=true;}
   if(!exactDates)ambiguous=true;
   for(const key of ['is-preprint-of','has-preprint','is-version-of','has-version'])for(const related of work.relation?.[key]??[]){const linked=related['id-type']==='doi'?doiOf(related.id):null;if(!linked){ambiguous=true;continue;}if(!visited.has(linked))queue.push(linked);}
   for(const text of [work.abstract??'',...(work['clinical-trial-number']??[]).map(value=>value['clinical-trial-number']??'')])for(const match of String(text).matchAll(/\bNCT\d{8}\b/gi))registryIds.add(match[0].toUpperCase());
  }
  if(queue.some(value=>!visited.has(value)))ambiguous=true;
  for(const registryId of [...registryIds].slice(0,3)){const found=await get(`https://clinicaltrials.gov/api/v2/studies/${registryId}`);if(!found){ambiguous=true;continue;}evidence.push(found.evidence);const record=found.data;if(record.protocolSection?.identificationModule?.nctId!==registryId){ambiguous=true;continue;}if(record.hasResults===true){const date=record.protocolSection?.statusModule?.resultsFirstPostDateStruct?.date;if(/^\d{4}-\d{2}-\d{2}$/.test(date??''))addDate(date,found.evidence.id);else ambiguous=true;}}
  // Found through one pointer per alias: a scan of every provenance record per paper grew by hundreds of records a day
  // once the confirmation curator resolved the whole feed (2026-10-07).
  const orderedAliases=[...aliases].sort();const prior=await recordForAliases(orderedAliases);const root=prior?.payload.sourceRoot??orderedAliases.find(value=>value.startsWith('doi:'))??orderedAliases[0]??null;
  if(ambiguous||!dates.length||!root)return unresolved(evidence,root,orderedAliases);
  const earliest=dates.sort((a,b)=>a.at.localeCompare(b.at))[0];
  // An observed earlier date may move the bound earlier. A later metadata version cannot reset it.
  const firstPublicAt=prior?.payload.firstPublicAt&&prior.payload.firstPublicAt<earliest.at?prior.payload.firstPublicAt:earliest.at;
  const firstPublicEvidenceId=firstPublicAt===earliest.at?earliest.evidenceId:prior.payload.firstPublicEvidenceId;
  const payload={firstPublicAt,firstPublicEvidenceId,sourceRoot:root,aliases:[...new Set([...(prior?.payload.aliases??[]),...orderedAliases])],provenanceResolved:true,provenanceEvidence:evidence,updatedAt:now().toISOString()};
  const id=prior?.id??`evolution-public-provenance-${hash(root).slice(0,32)}`;await service.save('public-provenance',id,payload,prior);
  for(const alias of payload.aliases)if(!await service.get(aliasRecordId(alias)))await service.save('public-provenance-alias',aliasRecordId(alias),{alias,recordId:id});
  return payload;
 }
 /** Read already registered release proofs only when the official source and actual model match. @param {string} actualModel */
 async function modelReleaseProof(actualModel){
  const live=await officialModelRelease(actualModel);
  if(live)return live;
  for(const row of await service.list('tool')){const proof=row.payload.modelReleaseProof;if(proof?.model!==actualModel||!proof.evidenceId||!proof.sourceId||!row.payload.modelReleasedAt)continue;const sources=await service.list('public-source-version');const official=sources.find(source=>source.payload.sha256===proof.sha256&&/^(?:https:\/\/)(?:api-docs\.deepseek\.com|api\.deepseek\.com|www\.deepseek\.com|deepseek\.com|qwen\.ai|www\.alibabacloud\.com)\//.test(source.payload.url??''));if(!official){const source=loadReleaseSource?await loadReleaseSource(proof,row):null;if(!source||source.sha256!==proof.sha256||typeof source.text!=='string'||hash(source.text)!==proof.sha256||!source.text.includes(actualModel)||!source.text.includes(row.payload.modelReleasedAt)||!/^https:\/\/(?:api-docs\.deepseek\.com|api\.deepseek\.com|www\.deepseek\.com|deepseek\.com|qwen\.ai|www\.alibabacloud\.com)\//.test(source.url??''))continue;return {model:actualModel,releasedAt:row.payload.modelReleasedAt,evidenceId:proof.evidenceId,sourceVersionId:proof.sourceId,provenanceResolved:true};}return {model:actualModel,releasedAt:row.payload.modelReleasedAt,evidenceId:proof.evidenceId,sourceVersionId:official.id,provenanceResolved:true};}return {model:actualModel,releasedAt:null,evidenceId:null,provenanceResolved:false};}
 async function officialModelRelease(actualModel){
  if(!/^deepseek-(?:v[0-9]+(?:\.[0-9]+)?-)?(?:flash|pro)(?:-[a-z0-9]+)*$/i.test(actualModel))return null;
  const id=`evolution-model-release-${hash(actualModel).slice(0,32)}`,prior=await service.get(id);
  if(prior&&Date.parse(prior.payload.checkedAt)>now().getTime()-86400000)return prior.payload;
  const found=await get('https://api-docs.deepseek.com/updates/','text');
  if(!found)return null;
  const text=found.data.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  const sections=[...text.matchAll(/Date:\s*(\d{4}-\d{2}-\d{2})([\s\S]*?)(?=Date:\s*\d{4}-\d{2}-\d{2}|$)/g)];
  const normalized=actualModel.toLowerCase();
  const section=sections.find(item=>item[2].toLowerCase().includes(normalized)&&/release/i.test(item[2].slice(0,160))&&Date.parse(item[1])<=now().getTime());
  if(!section)return null;
  // A dated official section is a conservative public bound, not a claimed training cutoff.
  // Preserve both the exact source bytes and the normalized extraction used to read the date.
  const payload={model:actualModel,releasedAt:new Date(section[1]).toISOString(),evidenceId:`${found.evidence.id}:${hash(section[0])}`,
   sourceVersionId:found.evidence.id,sourceUrl:found.evidence.url,sectionHash:hash(section[0]),chronologyKind:'official-model-public-bound',
   provenanceResolved:true,checkedAt:now().toISOString()};
  await service.save('model-release-proof',id,payload,prior);return payload;
 }
 return {resolvePaper,modelReleaseProof};
}
