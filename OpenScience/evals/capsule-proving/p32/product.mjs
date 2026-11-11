// P32: twenty preselected cases through the existing product-path harness.
// One throwaway account per case; explicit memory-page seeding, native extraction and runtime recall.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Api, runCell, registerAccount } from '../../general-tasks/runner/cell.mjs';
import { startHarness, stopHarness, ensureDatabase } from '../../general-tasks/runner/run.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = '/srv/evimed/runs/p32-product-v2';
const dataDir = '/srv/evimed/pp/data/p32-product-v2';
const port = 48855, pgPort = 55685;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = text => console.log(`${new Date().toISOString()} ${text}`);
if (process.env.OPEN_SCIENCE_MEMORY_RUNTIME_LOCK_ISOLATION_ENABLED !== 'true') throw new Error('lock_isolation_required');
await fs.mkdir(out, {recursive:true});
await fs.mkdir(`${out}/records`, {recursive:true});
const cases = JSON.parse(await fs.readFile(path.join(root, 'evals/remembered-format/cases.json'), 'utf8')).cases.slice(0,20);
await fs.writeFile(`${out}/manifest.json`, JSON.stringify({automated:true, cases:cases.map(c=>c.id), selection:'First twenty fixture cases, sample 0; chosen before controls completed', lockIsolation:true, seedRoute:"/api/memory/remember", tree:root, port, pgPort, startedAt:new Date().toISOString(), balanceBefore:await fs.readFile('/srv/evimed/runs/BUDGET-LAST','utf8')},null,2));
await ensureDatabase(pgPort, 'evimed_p32_v2');
const seed = spawnSync('bash', [path.join(root,'evals/general-tasks/runner/seed.sh')], {encoding:'utf8',env:{...process.env,OS:root,L:process.env.EVAL_LIVE_DIR,SEED_FROM:'/srv/evimed/pp/seed/dsh-seed'},maxBuffer:16<<20});
if(seed.status !== 0) throw new Error(`seed_failed: ${seed.stderr.slice(-1500)}`);
const treeDir = seed.stdout.trim().split('\n').at(-1);
let harness;
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async()=>{ await stopHarness(harness); process.exit(130); });
try {
  harness = await startHarness({args:{port},treeOs:root,treeDir,dataDir,profile:'normal',arm:'C',dbUrl:`postgresql://coder@127.0.0.1:${pgPort}/evimed_p32_v2`});
  const token = (await fs.readFile(process.env.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE,'utf8')).trim();
  let ready = false;
  for(let i=0;i<120;i++) {
    const metrics = await (await fetch(`${harness.base}/api/ops/metrics`,{headers:{Authorization:`Bearer ${token}`}})).text();
    ready = ['version','modelKey','memoryTemplates'].every(f=>metrics.includes(`fact="${f}",code="ok"} 1`));
    if(ready) break;
    await sleep(3000);
  }
  if(!ready) throw new Error('engine_not_ready');
  for(const c of cases) {
    const destination = `${out}/records/${c.id}.json`;
    try { await fs.access(destination); continue; } catch {}
    const context = [...c.memory.map(m=>m.text),...(c.method ? c.method.steps : [])].join('\n');
    const api = new Api(harness.base);
    const account = await registerAccount(api, `p32${Date.now().toString(36)}`);
    const seeded = await api.call('POST','/api/memory/remember',{text:context},{project:null,timeoutMs:180000});
    if(seeded.status!==200) throw new Error(`memory_seed_${seeded.status}`);
    let stored = [];
    for(let i=0;i<90;i++) {
      const response = await api.call('GET','/api/memory/records?pageSize=100',undefined,{project:null});
      const d = response.json?.data;
      stored = Array.isArray(d) ? d : d?.items ?? d?.records ?? [];
      if(stored.length>0) break;
      await sleep(2000);
    }
    if(!stored.length) throw new Error(`memory_seed_empty_${c.id}`);
    const spec = {id:c.id,family:'knowledge',inputs:[],turns:[{session:1,text:c.partial.ask}]};
    log(`start ${c.id}; seeded ${stored.length} records`);
    const record = await runCell({api,account,spec,fixtureRoot:out,dataDir,outDir:`${out}/records/${c.id}.files`,timeoutMs:600000,log,waitMemoryTools:true,automated:true});
    record.seed = {route:'/api/memory/remember',text:context,response:seeded.json,recordsBeforeAnswer:stored};
    // Capture the TARGET opening request, not the earlier preference-writing turn.
    const target = record.turns[0];
    if(target) {
      const requests = (await fs.readFile(`${dataDir}/model-requests.jsonl`,'utf8')).trim().split('\n').map(JSON.parse).filter(r=>r.at>=target.startedAt && r.at<=record.finishedAt && r.first && r.tools>0);
      record.targetOpeningRequests = [];
      for(const r of requests) {
        const body = await fs.readFile(`${dataDir}/first-requests/${String(r.seq).padStart(4,'0')}.json`,'utf8');
        await fs.writeFile(`${out}/records/${c.id}.files/target-${r.seq}.json.gz`,zlib.gzipSync(body));
        record.targetOpeningRequests.push({seq:r.seq,toolNames:r.toolNames,hasMemoryBlock:body.includes('openviking-context')});
      }
    }
    await fs.writeFile(destination,JSON.stringify(record,null,2));
    await fs.appendFile(`${out}/STATUS`,`${new Date().toISOString()} completed ${c.id}\n`);
  }
  await fs.appendFile(`${out}/STATUS`,'complete\n');
} finally { await stopHarness(harness); }
