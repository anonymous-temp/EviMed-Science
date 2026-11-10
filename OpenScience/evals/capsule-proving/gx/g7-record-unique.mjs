/** Keep unique-line provenance denominators distinct from gold-anchor/line match counts. */
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {wilson} from '../run/ledger.mjs';
const out='/srv/evimed/runs/gx-g7-1',summary=JSON.parse(await readFile(`${out}/summary.json`,'utf8'));
const [base]=JSON.parse(await readFile(`${out}/ledger-rows.json`,'utf8'));
const rows=Object.entries(summary.renderedAttribution.uniqueCounts).map(([category,v])=>({...base,metric:`unique_provenance_labelled_lines_${category}`,n:v.matchedLines,value:v.labelledLines/v.matchedLines,ci95:wilson(v.labelledLines,v.matchedLines),judged:{code:v.matchedLines,judge:0,unknown:0,error:0},notes:'Deduplicated user + file + line; observed literal renderings of template attribution labels. Gold anchor matching is descriptive and can include unrelated lines.'}));
await writeFile(`${out}/ledger-unique-lines.json`,JSON.stringify(rows,null,2)+'\n');
console.log(execFileSync(process.execPath,['evals/capsule-proving/run/ledger.mjs','add','--json',`${out}/ledger-unique-lines.json`,'--ledger','/srv/evimed/results/ledger.jsonl'],{cwd:'/srv/evimed/repo/OpenScience',encoding:'utf8'}).trim());
