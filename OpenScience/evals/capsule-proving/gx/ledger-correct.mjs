/** Append commit metadata corrections; preserve original rows and explicitly reference their immutable ids. */
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {ledgerIdForRow} from '../run/ledger.mjs';
const checkout=JSON.parse(await readFile(new URL('checkout.json',import.meta.url),'utf8'));
for(const item of ['g7','g8','g12']){
 const path=`/srv/evimed/runs/gx-${item}-1`,initial=JSON.parse(await readFile(`${path}/ledger-rows.json`,'utf8'));
 if(initial.every(r=>r.commit===checkout.commit))continue;
 await writeFile(`${path}/ledger-rows.initial.json`,JSON.stringify(initial,null,2)+'\n');
 const corrected=initial.map(row=>({...row,commit:checkout.commit,flags:{...row.flags,sourceRunCommit:row.commit},
  supersedesLedgerId:ledgerIdForRow(row),notes:`${row.notes??''}; commit metadata correction: supersedes ledgerId=${ledgerIdForRow(row)}; source development run commit is in flags.sourceRunCommit` }));
 await writeFile(`${path}/ledger-rows.json`,JSON.stringify(corrected,null,2)+'\n');
 const summary=JSON.parse(await readFile(`${path}/summary.json`,'utf8'));summary.checkout=checkout;
 summary.ledgerCorrection={reason:'Initial adapter used source development run commit for the measurement checkout; values unchanged.',superseded:initial.map(ledgerIdForRow)};
 await writeFile(`${path}/summary.json`,JSON.stringify(summary,null,2)+'\n');
 console.log(execFileSync(process.execPath,['evals/capsule-proving/run/ledger.mjs','add','--json',`${path}/ledger-rows.json`,'--ledger','/srv/evimed/results/ledger.jsonl'],{cwd:'/srv/evimed/repo/OpenScience',encoding:'utf8'}).trim());
}
