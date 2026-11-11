#!/usr/bin/env node
/** Read public L4 missed-pair receipts; no model calls or sealed inputs. */
import { readFile, writeFile } from 'node:fs/promises';
import { pairKey } from './run_l4.mjs';
const load = file => readFile(file,'utf8').then(JSON.parse);
const root='/srv/evimed/runs', records=[],storageChecks=[],statesByPath=new Map();
const stateAt=async file=>{if(!statesByPath.has(file))statesByPath.set(file,await load(file));return statesByPath.get(file);};
for(const floor of [0.50,0.60]) for(const size of [50,200,600]) {
  const dir=`${root}/l4-${size}-1`,summary=await load(`${dir}/summary.json`);
  const gold=(await load(`/srv/evimed/data/memdata-data/l4/gold-${size}.json`)).pairs;
  const library=(await load(`/srv/evimed/data/memdata-data/l4/library-${size}.json`)).methods;
  const groups=await load(`${dir}/decide-${floor.toFixed(2)}/groups.json`);
  for(const [kind,type] of [['subset','subset'],['conflict','conflicts_with']]) for(const pair of gold.filter(pair=>pair.relation===kind)) {
    const predictions=groups.flatMap(g=>g.predictions).filter(p=>pairKey(p.a,p.b)===pairKey(pair.a,pair.b));
    const correct=predictions.some(p=>p.type===type&&(kind!=='subset'||p.wider===pair.a));
    const diagnostic=summary.goldDiagnostics.find(p=>pairKey(p.a,p.b)===pairKey(pair.a,pair.b));
    const together=groups.map((g,i)=>({g,i})).filter(({g})=>g.ids.includes(pair.a)&&g.ids.includes(pair.b));
    const states=await Promise.all(together.map(({i})=>stateAt(`${dir}/decide-${floor.toFixed(2)}/group-${String(i).padStart(3,'0')}/library.json`)));
    const recorded=states.some((state,index)=>state.documents.rows.some(row=>row.id===together[index].g.mapping[pair.b]
      &&row.payload.learning?.relations?.some(r=>r.type===type&&r.target===together[index].g.mapping[pair.a])));
    if(correct)storageChecks.push({size,floor,kind,a:pair.a,b:pair.b,recorded});
    if(correct&&recorded||records.filter(record=>record.kind===kind).length>=20)continue;
    const stage=correct?'judged-but-not-recorded':!diagnostic.shortlistedAt030||diagnostic.score<floor?'pre-filter-not-proposed':!together.length?'proposed-but-not-grouped':
      predictions.length?'judge-other-relation':'judge-omitted-pair';
    records.push({size,floor,kind,...pair,stage,diagnostic,recordedExpectedRelation:recorded,
      predictions,together:together.map(({g})=>({groupId:g.groupId,decideFailed:g.result.decideFailed,relationTypes:g.result.relationTypes})),
      methods:[pair.a,pair.b].map(id=>library.find(m=>m.id===id))});
  }
}
if(records.filter(record=>record.kind==='subset').length!==20||records.filter(record=>record.kind==='conflict').length!==20)throw new Error('The requested 20+20 audit sample is incomplete');
const counts={};for(const r of records){const k=`${r.kind}:${r.stage}`;counts[k]=(counts[k]??0)+1;}
const result={scope:'First 20 missed subset and 20 missed conflict records across libraries 50/200/600, scanning floor 0.50 then 0.60 (only 19 conflict misses exist at 0.50); planted rules repeat across sizes. No explicit unrelated verdict is inferred from omission.',counts,positiveJudgeStorage:{checked:storageChecks.length,missing:storageChecks.filter(row=>!row.recorded)},records};
await writeFile(`${root}/l4b-p34-miss-audit.json`,JSON.stringify(result,null,1));
process.stdout.write(JSON.stringify({counts,records:records.map(({size,a,kind,stage,recordedExpectedRelation})=>({size,a,kind,stage,recordedExpectedRelation}))},null,1)+'\n');
