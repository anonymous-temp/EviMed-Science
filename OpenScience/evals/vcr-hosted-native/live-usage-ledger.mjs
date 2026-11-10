import fs from 'node:fs/promises';
import pg from '../../apps/server/node_modules/pg/lib/index.js';
const client=new pg.Client({connectionString:process.env.VCR_TEST_DATABASE});await client.connect();
while(true){
  try {const result=await client.query("SELECT project_id,run_id,session_id,purpose,status,model,observed_model,error_code,created_at,settled_at,actual_cost,estimated_cost,reserved_cost FROM evimed_usage.model_requests ORDER BY created_at,id");await fs.writeFile('/data/conversation-usage.json',JSON.stringify({at:new Date().toISOString(),requests:result.rows})+'\n',{mode:0o600});}catch{}
  await new Promise(resolve=>setTimeout(resolve,2000));
}
