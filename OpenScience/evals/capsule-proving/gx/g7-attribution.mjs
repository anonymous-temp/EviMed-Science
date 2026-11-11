/** Expanded literal provenance inventory, grounded in this run's rendered labels; never a semantic verdict. */
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {readFile,writeFile} from 'node:fs/promises';
const out='/srv/evimed/runs/gx-g7-1';
const summary=JSON.parse(await readFile(`${out}/summary.json`,'utf8'));
// Template source: MEMORY_DECIDE_TEXT in packages/domain/src/memoryNeverKept.mjs, rendered into every type.
// It mandates assistant suggested / user believes / document says, and _language.txt asks for the user's language.
// The templates do not prescribe fixed Chinese phrases. These literal equivalents were read in attribution.jsonl;
// retain both the narrow exact-label count and this rendered-label count so neither is a hidden rubric change.
const rendered={
 suggestion:[...summary.labels.suggestion,'助手给出的','助手按链式方程'],
 opinion:[...summary.labels.opinion,'用户观点','按用户立场','认为','觉得'],
 document_claim:[...summary.labels.document_claim,'取自科室会议纪要','用户粘贴','该指南报告称','研究报告','研究称','分析称','材料提到','片段称','据行业简报摘录','引用荟萃分析报告','核对所引英文成本效果论文','中国银屑病指南称'],
};
const norm=s=>String(s).normalize('NFKC').toLowerCase().replace(/\s+/gu,'');
const counts={},rows=[];
for await(const line of createInterface({input:createReadStream(`${out}/attribution.jsonl`),crlfDelay:Infinity})){
 if(!line.trim())continue;const row=JSON.parse(line);
 const hits=row.matched.map(hit=>({...hit,labels:rendered[row.category].filter(label=>norm(hit.text).includes(norm(label)))}));
 const labelled=hits.filter(h=>h.labels.length),c=counts[row.category]??={planted:0,matchedItems:0,labelledItems:0,matchedLines:0,labelledLines:0};
 c.planted++;c.matchedItems+=hits.length>0;c.labelledItems+=labelled.length>0;c.matchedLines+=hits.length;c.labelledLines+=labelled.length;
 rows.push({...row,matched:hits,labelled:labelled.length});
}
summary.renderedAttribution={counts,labels:rendered,method:'Expanded literal renderings observed in the final development snapshots. Subject-bearing profile verbs count as user belief. These are descriptive code counts, not semantic proof; vague gold anchors can match unrelated lines. The earlier exact-label count remains above.'};
const uniqueCounts={};
for(const category of Object.keys(rendered)){
 const matched=new Set(),labelled=new Set();
 for(const row of rows.filter(r=>r.category===category))for(const hit of row.matched){const key=JSON.stringify([row.userKey,hit.rel,hit.text]);matched.add(key);if(hit.labels.length)labelled.add(key);}
 uniqueCounts[category]={matchedLines:matched.size,labelledLines:labelled.size};
}
summary.renderedAttribution.uniqueCounts=uniqueCounts;
summary.renderedAttribution.anchorMatchLimit='counts.matchedLines is the sum of per-gold-anchor line matches; uniqueCounts deduplicates user + file + text. One suggestion line matched two gold anchors.';
await writeFile(`${out}/attribution-rendered.jsonl`,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
await writeFile(`${out}/summary.json`,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(counts));
