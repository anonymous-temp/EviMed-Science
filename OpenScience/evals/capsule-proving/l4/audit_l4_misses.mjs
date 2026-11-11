#!/usr/bin/env node
/** Read public L4 missed-pair receipts; no model calls or sealed inputs. */
import { readFile, writeFile } from 'node:fs/promises';
import { pairKey } from './run_l4.mjs';
const load = file => readFile(file,'utf8').then(JSON.parse);
const root='/srv/evimed/runs', records=[];
for(const size of [50,200,600]) {
  const dir=`${root}/l4-${size}-1`,summary=await load(`${dir}/summary.json`);
  const gold=(await load(`/srv/evimed/data/memdata-data/l4/gold-${size}.json`)).pairs;
  const library=(await load(`/srv/evimed/data/memdata-data/l4/library-${size}.json`)).methods;
  const groups=await load(`${dir}/decide-0.50/groups.json`);
  for(const [kind,type] of [['subset','subset'],['conflict','conflicts_with']]) for(const pair of gold.filter(pair=>pair.relation===kind)) {
    if(records.filter(record=>record.kind===kind).length>=20)continue;
    const predictions=groups.flatMap(g=>g.predictions).filter(p=>pairKey(p.a,p.b)===pairKey(pair.a,pair.b));
    const correct=predictions.some(p=>p.type===type&&(kind!=='subset'||p.wider===pair.a));
    if(correct)continue;
    const diagnostic=summary.goldDiagnostics.find(p=>pairKey(p.a,p.b)===pairKey(pair.a,pair.b));
    const together=groups.map((g,i)=>({g,i})).filter(({g})=>g.ids.includes(pair.a)&&g.ids.includes(pair.b));
    const states=await Promise.all(together.map(({i})=>load(`${dir}/decide-0.50/group-${String(i).padStart(3,'0')}/library.json`)));
    const recorded=states.some((state,index)=>state.documents.rows.some(row=>row.id===together[index].g.mapping[pair.b]
      &&row.payload.learning?.relations?.some(r=>r.type===type&&r.target===together[index].g.mapping[pair.a])));
    const stage=!diagnostic.shortlistedAt030||diagnostic.score<.5?'pre-filter-not-proposed':!together.length?'proposed-but-not-grouped':
      predictions.length?'judge-other-relation':'judge-omitted-pair';
    records.push({size,floor:.5,kind,...pair,stage,diagnostic,recordedExpectedRelation:recorded,
      predictions,together:together.map(({g})=>({groupId:g.groupId,decideFailed:g.result.decideFailed,relationTypes:g.result.relationTypes})),
      methods:[pair.a,pair.b].map(id=>library.find(m=>m.id===id))});
  }
}
const counts={};for(const r of records){const k=`${r.kind}:${r.stage}`;counts[k]=(counts[k]??0)+1;}
const result={scope:'First 20 missed subset and 20 missed conflict records at floor 0.50, across libraries 50/200/600; planted rules repeat across sizes. No explicit unrelated verdict is inferred from omission.',counts,records};
await writeFile(`${root}/l4b-p34-miss-audit.json`,JSON.stringify(result,null,1));
process.stdout.write(JSON.stringify({counts,records:records.map(({size,a,kind,stage,recordedExpectedRelation})=>({size,a,kind,stage,recordedExpectedRelation}))},null,1)+'\n');
