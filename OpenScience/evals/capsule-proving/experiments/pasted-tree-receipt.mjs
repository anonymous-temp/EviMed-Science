import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const run=process.argv[2];if(!/^p30-(?:inject-[123]|g9-1)$/.test(run??''))throw Error('P30 run id required');
const files=[...(await readdir('apps/server/src')).filter(p=>p.startsWith('nativeMemory')&&p.endsWith('.mjs')).map(p=>'apps/server/src/'+p),
 'apps/server/src/config.mjs','evals/capsule-proving/run/lab.mjs','evals/capsule-proving/run/run.mjs'];
const hashes={};for(const file of files.sort())hashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
const target=`/srv/evimed/runs/${run}/p30-tree.json`;
const previous=await readFile(target,'utf8').then(JSON.parse,()=>null);
if(previous&&JSON.stringify(previous.files)!==JSON.stringify(hashes))throw Error('proof_tree_changed');
if(!previous)await writeFile(target,JSON.stringify({at:new Date().toISOString(),files:hashes},null,2));
