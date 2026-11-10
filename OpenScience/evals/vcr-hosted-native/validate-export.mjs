import { readFile } from 'node:fs/promises';
import { validateArtifacts } from './artifact-export.mjs';
const [resultPath,ids,suite,root,chainPath]=process.argv.slice(2);
const result=JSON.parse(await readFile(resultPath,'utf8'));
const count=ids?ids.split(',').length:suite==='native-chain'?4:suite==='completion'?1:suite==='post-audit'?3:20;
if(result.denominator!==count||result.results.length!==count||result.results.some(row=>!['completed','run_failed','timed_out','error','not_run_budget'].includes(row.status)))throw new Error('Incomplete result set');
const rows=[...result.results];if(chainPath)rows.push(...JSON.parse(await readFile(chainPath,'utf8')).results);
for(const row of rows)await validateArtifacts(row,root);
