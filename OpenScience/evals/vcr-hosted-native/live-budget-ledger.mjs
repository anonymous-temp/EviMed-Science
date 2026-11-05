import fs from 'node:fs/promises';
import pg from '../../apps/server/node_modules/pg/lib/index.js';
const client=new pg.Client({connectionString:process.env.VCR_TEST_DATABASE});await client.connect();
while(true){
  try {const result=await client.query("SELECT status,count(*)::int AS requests,coalesce(sum(actual_cost),0)::float AS actual_cny,coalesce(sum(CASE WHEN status='uncertain' THEN coalesce(estimated_cost,reserved_cost) WHEN status='reserved' THEN reserved_cost ELSE 0 END),0)::float AS open_cny FROM evimed_usage.model_requests GROUP BY status");await fs.writeFile('/data/conversation-cost.json',JSON.stringify({at:new Date().toISOString(),statuses:result.rows})+'\n',{mode:0o600});}catch{}
  await new Promise(resolve=>setTimeout(resolve,2000));
}
