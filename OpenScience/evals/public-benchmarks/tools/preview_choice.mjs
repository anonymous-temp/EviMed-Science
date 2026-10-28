// Preview the development choice the lab runner will recompute on 11-01 (same code, same inputs).
//   node preview_choice.mjs rsi/development.json rsi/slice.json
import { readFileSync } from 'node:fs';
import { chooseSkillCandidate } from '../../rsi-campaigns/skill_campaign.mjs';
const [devPath, slicePath] = process.argv.slice(2);
const development = JSON.parse(readFileSync(devPath, 'utf8'));
const slice = JSON.parse(readFileSync(slicePath, 'utf8'));
const choice = chooseSkillCandidate(development, { failureCalculators: slice.failureCalculators, margin: 0.05 });
const fmt = (s) => ({ overall: s.overall?.toFixed(3), slice: s.slice?.toFixed(3), rows: s.rows, sliceRows: s.sliceRows });
console.log(JSON.stringify({ scores: Object.fromEntries(Object.entries(choice.scores).map(([arm, s]) => [arm, fmt(s)])), candidates: choice.candidates, frozen: choice.frozen, reason: choice.reason }, null, 1));
