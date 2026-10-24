// Personal context is authored user work, never a second document store.
const normalized=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const matchesSeed=(seed,text)=>seed.requiredValues.every((value,index)=>[value,...(seed.valueVariants?.[index]??[])].some(candidate=>normalized(text).includes(normalized(candidate))));
export function validatePersonalContexts(b){
 for(const c of b.cases.filter(item=>item.stratum!=='lifecycle')){
  const substrate=c.evaluation?.substrate;
  if(substrate==='knowledge'){if(c.memorySeeds?.length)throw Error('Knowledge-only case carries memory seeds');continue;}
  if(!c.memorySeeds?.length||c.memorySeeds.some(s=>s.kind!=='user-authored'||!s.statement?.trim()||!s.requiredValues?.length||s.requiredValues.some(v=>!normalized(s.statement).includes(normalized(v)))))throw Error('Personal memory requires authored user statements and grounded values');
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
export function seedMemoryProof(seeds,profile){
 const records=profile.records??[];
 return seeds.map(seed=>{
  const matches=records.filter(r=>matchesSeed(seed,r.value??r.body));
  if(!matches.length)throw Error(`Required authored seed not represented: ${seed.id}`);
  const record=matches.find(r=>/^viking:\/\/user\/[^/]+\/memories\//.test(r.document?.uri??r.uri??r.id??''));
  if(!record)throw Error(`Required seed lacks native memory URI: ${seed.id}`);
  return {seedId:seed.id,uri:record.document?.uri??record.uri??record.id,recordId:record.id,requiredValues:[...seed.requiredValues],userStatement:seed.statement};
 });
}
export function preparationCounts(b){
 const groups=new Map();for(const c of b.cases.filter(item=>item.stratum!=='lifecycle')){const key=`${c.evaluation.size}-${c.evaluation.substrate}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
 const sizes={small:24,medium:64,large:256};let uploads=0,knowledgeSources=0,memorySeeds=0;
 for(const cases of groups.values()){const {originals,seeds}=contextMaterials(b,cases),target=sizes[cases[0].evaluation.size];uploads+=target;knowledgeSources+=cases[0].evaluation.substrate==='memory'?0:target-originals.filter(s=>s.originalOnly).length;memorySeeds+=seeds.length;}
 const semanticJudgements=b.cases.filter(c=>c.stratum!=='lifecycle').length*3+b.cases.filter(c=>c.stratum!=='lifecycle'&&c.evaluation.substrate==='combined').length*3;
 return {perArm:{uploads,knowledgeSources,memorySeeds,semanticJudgements},bothArms:{uploads:uploads*2,knowledgeSources:knowledgeSources*2,memorySeeds:memorySeeds*2,semanticJudgements:semanticJudgements*2},sizeUnit:'project documents; personal memory seed volume reported separately'};
}

export function collectNativeMemoryContext(lines){
 return lines.filter(m=>m.role==='user'&&(m.source==='plugin:openviking-memory'||m.source?.kind==='plugin:openviking-memory'||(m.source?.kind==='plugin'&&m.source?.plugin==='openviking-memory')))
  .map(m=>({producer:'openviking-memory',form:m.source?.form,text:(Array.isArray(m.parts??m.content)?(m.parts??m.content):[]).filter(p=>p.type==='text').map(p=>p.text).join('\n')})).filter(m=>m.text);
}
export function personalRetrievalProof(c,e){
 const provenance=e.memoryFreeze?.provenance??[];
 const tools=(e.retrieval??[]).filter(t=>/^mcp__openviking__(search|read)$/.test(t.name)&&['completed','success','succeeded'].includes(t.status)&&!t.error&&!t.output?.error&&!t.output?.isError&&!t.output?.code?.includes?.('unavailable'));
 return (c.memorySeeds??[]).map(seed=>{
  const proof=provenance.find(p=>p.seedId===seed.id);
  const tool=proof&&tools.find(t=>{
    const output=normalized(JSON.stringify(t.output));
    const address=output.includes(normalized(proof.uri))||(t.name==='mcp__openviking__read'&&[t.input?.uri,t.input?.path].includes(proof.uri));
    return address&&matchesSeed(seed,output);
  });
  const context=proof&&(e.nativeMemoryContext??[]).find(m=>m.producer==='openviking-memory'&&matchesSeed(seed,m.text));
  if(!proof||(!tool&&!context))throw Error(`Native context lacks required authored seed provenance: ${seed.id}`);
  return {seedId:seed.id,uri:proof.uri,via:tool?'native-tool':'native-profile-context',uriObserved:Boolean(tool)};
 });
}
export async function seedAuthoredMemory(call,{projectId,seeds,beforeEach=async()=>{}}){
 if(seeds.some(s=>s.kind!=='user-authored'||!s.statement?.trim()))throw Error('Only authored personal statements may be seeded');
 const receipts=[];
 for(const seed of seeds){await beforeEach();const commit=await call('POST','/api/memory/remember',{projectId,text:seed.statement});if(!commit?.pending?.id)throw Error('Native authored seeding completion receipt missing');receipts.push({seedId:seed.id,id:commit.pending.id});}
 return receipts;
}
