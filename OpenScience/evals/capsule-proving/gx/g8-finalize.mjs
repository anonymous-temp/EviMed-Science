/** Bind prompt parity and denominator checks to the completed paired results. */
import {readFile,writeFile} from 'node:fs/promises';
const out='/srv/evimed/runs/gx-g8-1',summary=JSON.parse(await readFile(`${out}/summary.json`,'utf8'));
summary.promptAudit=JSON.parse(await readFile(`${out}/prompt-audit.json`,'utf8'));
summary.validation={existingHarnessUnitTests:{tests:26,pass:26,fail:0,command:'PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s evals/remembered-format/tests -p test_*.py'},expectedPartialPerSetting:90,expectedCellsPerSetting:180};
for(const value of Object.values(summary.settings))if(value.cells!==180||value.summary.partial.n!==90||value.summary.full.n!==90)throw Error('paired_denominator_mismatch');
summary.wallSeconds=Object.values(summary.settings).reduce((n,v)=>n+v.wallSeconds,0);
summary.referenceComparison='Historical reference 58/90, not a concurrent paired control. Enabled 54/90, disabled 50/90; overlapping sampling uncertainty, not established improvement. Judge mode in the historical reference was implicit.';
await writeFile(`${out}/summary.json`,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({settings:Object.fromEntries(Object.entries(summary.settings).map(([k,v])=>[k,{invented:v.summary.partial.inventedRuns,n:90,fullAllGiven:v.summary.full.allGiven,bothRight:v.summary.pairs.bothRight}])),promptParity:summary.promptAudit.defaultPersonaGuidanceEqual}));
