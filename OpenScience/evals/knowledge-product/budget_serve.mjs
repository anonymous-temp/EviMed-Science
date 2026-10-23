// Start one coordinator for baseline + candidate + OpenViking + C. Keep its directory and all keys outside the repository.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBudgetProxy } from './budget_proxy.mjs';
if(!process.env.KNOWLEDGE_BUDGET_CONFIG)throw new Error('Set KNOWLEDGE_BUDGET_CONFIG to private admitted models/provider key-file references');
const config=JSON.parse(await fs.readFile(process.env.KNOWLEDGE_BUDGET_CONFIG,'utf8'));
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'evimed-shared-budget-'));
const token=randomBytes(32).toString('hex'),tokenFile=path.join(dir,'token');
await fs.writeFile(tokenFile,token,{mode:0o600});
const proxy=await createBudgetProxy({...config,capCny:50,token,ledgerFile:path.join(dir,'ledger.jsonl')});
await fs.writeFile(path.join(dir,'coordinator.json'),JSON.stringify({coordinatorUrl:proxy.url,sharedBudgetId:proxy.budget.id,tokenFile},null,2),{mode:0o600});
console.log(JSON.stringify({coordinatorUrl:proxy.url,sharedBudgetId:proxy.budget.id,privateManifest:path.join(dir,'coordinator.json'),status:'dry-unarmed',capCny:50}));
const stop=async()=>{await proxy.close();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
