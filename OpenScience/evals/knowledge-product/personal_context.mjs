import {createHash} from 'node:crypto';
// Personal context is authored user work, never a second document store.
const normalized=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const matchesSeed=(seed,text)=>seed.requiredValues.every((value,index)=>[value,...(seed.valueVariants?.[index]??[])].some(candidate=>normalized(text).includes(normalized(candidate))));
export function validatePersonalContexts(b){
 for(const c of b.cases.filter(item=>item.stratum!=='lifecycle')){
  const substrate=c.evaluation?.substrate;
  if(substrate==='knowledge'){if(c.memorySeeds?.length)throw Error('Knowledge-only case carries memory seeds');continue;}
  if(!c.memorySeeds?.length||c.memorySeeds.some(s=>s.kind!=='user-authored'||!s.statement?.trim()||!s.requiredValues?.length||s.requiredValues.some(v=>!normalized(s.statement).includes(normalized(v)))))throw Error('Personal memory requires authored user statements and grounded values');
  c.memorySeeds.forEach(seedProposition);
  if(substrate==='memory'&&c.sources.length)throw Error('Memory-only case exposes relevant source files');
  if(substrate==='combined'&&((!c.sources.length&&!c.unanswerable)||!c.memoryDependency||!c.prompt.includes(c.memoryDependency.series)))throw Error('Combined case must require knowledge and saved personal context');
 }
 return true;
}
export function contextMaterials(b,cases){
 const memoryOnly=cases[0].evaluation.substrate==='memory';
 if(memoryOnly&&cases.some(c=>c.sources.length))throw Error('Memory-only relevant file bypass');
 const ids=new Set(cases.flatMap(c=>c.sources));
 if(!memoryOnly&&cases.some(c=>c.evaluation.maliciousControl))ids.add('general-malicious-instruction');
 return {originals:memoryOnly?[]:b.sources.filter(s=>ids.has(s.id)),seeds:[...new Map(cases.flatMap(c=>c.memorySeeds??[]).map(s=>[s.id,s])).values()]};
}
export const MAX_SEED_CANDIDATES=4;
export const approvedBodyHash=value=>createHash('sha256').update(String(value)).digest('hex');
const bodyText=value=>String(value??'').replace(/\s+/g,' ').trim();
export function seedProposition(seed){
 const p=seed.proposition;
 const stop=seed.statement.indexOf('. '),firstSentence=stop<0?seed.statement:seed.statement.slice(0,stop+1);
 if(p?.sourceQuote!==firstSentence)throw Error('Reviewed proposition must retain the complete first sentence and scope');
 const omitted=seed.statement.slice(firstSentence.length);
 if(!['',' Please remember this as my working preference.',' Remember this standing reporting convention.'].includes(omitted))throw Error('Unreviewed substantive suffix cannot be omitted from seed proposition');
 if(!p?.text||p.sourceQuote!==p.text||!seed.statement.includes(p.sourceQuote)||p.statementSha256!==approvedBodyHash(seed.statement)||p.sha256!==approvedBodyHash(p.text))throw Error('Reviewed seed proposition is not grounded in original statement');
 return p.text;
}
function candidateScore(seed,proposition,value){
 const ignored=new Set(['for','my','the','a','an','as','is','are','always','use','please','remember','this','in','to','of','it']);
 const terms=new Set((normalized(proposition).match(/[\p{L}\p{N}]+/gu)??[]).filter(t=>!ignored.has(t)));
 const words=new Set(normalized(value).match(/[\p{L}\p{N}]+/gu)??[]);
 return (matchesSeed(seed,value)?10000:0)+[...terms].filter(term=>words.has(term)).length;
}
export async function seedMemoryProof(seeds,profile,{judge}={}){
 if(typeof judge!=='function')throw Error('Semantic seed judge is required');
 if(profile.engine!=='native')throw Error('Authenticated native memory profile is required');
 const records=profile.records??[];
 if(records.length>64||seeds.length>64)throw Error('Semantic seed proof record bound exceeded');
 const native=records.map(record=>({record,uri:record.document?.uri??record.uri??record.id,value:record.value??record.body}))
  .filter(r=>/^viking:\/\/user\/[^/]+\/memories\//.test(r.uri??'')&&typeof r.value==='string');
 if(!native.length)throw Error('Required seed lacks native memory URI');
 if(native.some(r=>Buffer.byteLength(r.value)>32768))throw Error('Semantic seed proof body bound exceeded');
 const proofs=[];
 for(const seed of seeds){
  const proposition=seedProposition(seed);
  const candidates=[...native].sort((a,b)=>candidateScore(seed,proposition,b.value)-candidateScore(seed,proposition,a.value)||String(a.uri).localeCompare(String(b.uri))).slice(0,MAX_SEED_CANDIDATES);
  const attempts=[];let accepted=null;
  for(const candidate of candidates){
   let result;
   try{result=await judge({question:'Does this actual memory preserve the complete reviewed user proposition, including scope, ordering, qualifications and negation?',reference:{keyPoints:[{id:'authored',text:proposition,support:[]}]},answer:candidate.value,caseId:seed.id,component:'seed-representation'});}
   catch(error){error.semanticSeedEvidence={seedId:seed.id,attempts,interrupted:{uri:candidate.uri,bodySha256:approvedBodyHash(candidate.value),raw:error.semanticRaw??[]}};throw error;}
   attempts.push({uri:candidate.uri,actualValue:candidate.value,bodySha256:approvedBodyHash(candidate.value),result:result??null,score:result?.score??null,points:result?.points??null,raw:result?.raw??null,model:result?.model??null,provider:result?.provider??null,cost:result?.cost??null,tokens:result?.tokens??null});
   if(!result?.ok||result.malformed||!Number.isFinite(result.score)||!Array.isArray(result.points)||!result.points.length){const error=new Error('Semantic seed judge inconclusive or malformed');error.semanticSeedEvidence={seedId:seed.id,attempts};throw error;}
   if(result.score===1&&result.points.every(point=>point.verdict==='covered'&&point.contradicted!==true)){accepted={seedId:seed.id,uri:candidate.uri,recordId:candidate.record.id,approvedValue:candidate.value,bodySha256:approvedBodyHash(candidate.value),requiredValues:[...seed.requiredValues],userStatement:seed.statement,proposition:seed.proposition,judge:attempts.at(-1),attempts};break;}
  }
  if(!accepted){const error=new Error(`Required authored seed not semantically represented: ${seed.id}`);error.semanticSeedEvidence={seedId:seed.id,attempts,examinedCandidates:candidates.length,nativeRecords:native.length};throw error;}
  proofs.push(accepted);
 }
 return proofs;
}
export function preparationCounts(b){
 const groups=new Map();for(const c of b.cases.filter(item=>item.stratum!=='lifecycle')){const key=`${c.evaluation.size}-${c.evaluation.substrate}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
 const sizes={small:24,medium:64,large:256};let uploads=0,knowledgeSources=0,memorySeeds=0;
 for(const cases of groups.values()){const {originals,seeds}=contextMaterials(b,cases),target=sizes[cases[0].evaluation.size];uploads+=target;knowledgeSources+=cases[0].evaluation.substrate==='memory'?0:target-originals.filter(s=>s.originalOnly).length;memorySeeds+=seeds.length;}
 const semanticJudgements=b.cases.filter(c=>c.stratum!=='lifecycle').length*3+b.cases.filter(c=>c.stratum!=='lifecycle'&&c.evaluation.substrate==='combined').length*3;
 return {perArm:{uploads,knowledgeSources,memorySeeds,semanticJudgements,semanticSeedJudgements:{minimum:memorySeeds,maximum:memorySeeds*MAX_SEED_CANDIDATES*2}},bothArms:{uploads:uploads*2,knowledgeSources:knowledgeSources*2,memorySeeds:memorySeeds*2,semanticJudgements:semanticJudgements*2,semanticSeedJudgements:{minimum:memorySeeds*2,maximum:memorySeeds*MAX_SEED_CANDIDATES*4}},sizeUnit:'project documents; personal memory seed volume reported separately'};
}

export function collectNativeMemoryContext(lines){
 return lines.filter(m=>m.role==='user'&&(m.source==='plugin:openviking-memory'||m.source?.kind==='plugin:openviking-memory'||(m.source?.kind==='plugin'&&m.source?.plugin==='openviking-memory')))
  .map(m=>({producer:'openviking-memory',form:m.source?.form,text:(Array.isArray(m.parts??m.content)?(m.parts??m.content):[]).filter(p=>p.type==='text').map(p=>p.text).join('\n')})).filter(m=>m.text);
}
function returnedEntries(value){
 if(typeof value==='string')try{return returnedEntries(JSON.parse(value));}catch{return [];}
 if(!value||typeof value!=='object')return [];
 if(value.type==='text'&&typeof value.text==='string')return returnedEntries(value.text);
 const entries=[];
 const field=['body','value','content','text','abstract','summary'].find(key=>typeof value[key]==='string');
 if(typeof value.uri==='string'&&field)entries.push({uri:value.uri,text:value[field]});
 for(const key of ['result','data'])if(value[key])entries.push(...returnedEntries(value[key]));
 for(const key of ['memories','results','items','hits','files','documents','resources','content'])if(Array.isArray(value[key]))for(const item of value[key])entries.push(...returnedEntries(item));
 return entries;
}
function plainReadBody(value){
 if(typeof value==='string')return value;
 if(!value||typeof value!=='object')return null;
 if(value.result)return plainReadBody(value.result);
 if(value.data)return plainReadBody(value.data);
 if(typeof value.text==='string')return value.text;
 if(typeof value.content==='string')return value.content;
 if(Array.isArray(value.content)&&value.content.every(p=>p.type==='text'&&typeof p.text==='string'))return value.content.map(p=>p.text).join('\n');
 return null;
}
export function personalRetrievalProof(c,e){
 if(e.memoryFreeze?.mode==='canary-presence-only')throw Error('Canary-only freeze is not semantic proof');
 const provenance=e.memoryFreeze?.provenance??[];
 const tools=(e.retrieval??[]).filter(t=>/^mcp__openviking__(search|read)$/.test(t.name)&&['completed','success','succeeded'].includes(t.status)&&!t.error&&!t.output?.error&&!t.output?.isError&&!t.output?.code?.includes?.('unavailable'));
 return (c.memorySeeds??[]).map(seed=>{
  const proof=provenance.find(p=>p.seedId===seed.id);
  if(!proof?.approvedValue||proof.bodySha256!==approvedBodyHash(proof.approvedValue))throw Error(`Native context lacks approved seed provenance: ${seed.id}`);
  const tool=tools.find(t=>{
   const entries=returnedEntries(t.output);
   if(t.name==='mcp__openviking__read'){
    let input=t.input;if(typeof input==='string')try{input=JSON.parse(input);}catch{return false;}
    const uris=input?.uris??[input?.uri??input?.path];
    if(uris.length===1&&uris[0]===proof.uri&&!entries.length){const text=plainReadBody(t.output);if(typeof text==='string')entries.push({uri:uris[0],text});}
   }
   return entries.some(entry=>entry.uri===proof.uri&&bodyText(entry.text).includes(bodyText(proof.approvedValue)));
  });
  const context=(e.nativeMemoryContext??[]).find(m=>m.producer==='openviking-memory'&&bodyText(m.text).includes(bodyText(proof.approvedValue)));
  if(!tool&&!context)throw Error(`Native context lacks required authored seed provenance: ${seed.id}`);
  return {seedId:seed.id,uri:proof.uri,bodySha256:proof.bodySha256,via:tool?'native-tool':'native-profile-context',uriObserved:Boolean(tool)};
 });
}
export async function seedAuthoredMemory(call,{projectId,seeds,beforeEach=async()=>{}}){
 if(seeds.some(s=>s.kind!=='user-authored'||!s.statement?.trim()))throw Error('Only authored personal statements may be seeded');
 const receipts=[];
 for(const seed of seeds){await beforeEach();const commit=await call('POST','/api/memory/remember',{projectId,text:seed.statement});if(!commit?.pending?.id)throw Error('Native authored seeding completion receipt missing');receipts.push({seedId:seed.id,id:commit.pending.id});}
 return receipts;
}
