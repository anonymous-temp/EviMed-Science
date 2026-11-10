/** Check the harness's checkout-built persona/guidance against the shared product prompt builder. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {buildSystemPrompt} from '../run/openingBlock.mjs';
const texts=JSON.parse(execFileSync(process.execPath,['evals/remembered-format/texts.mjs','--model','deepseek-flash'],{encoding:'utf8'}));
const assembled=`${texts.persona}\n\n${texts.guidance}`;
const result={defaultPersonaGuidanceEqual:assembled===buildSystemPrompt({model:'deepseek-flash'}),sha256:createHash('sha256').update(assembled).digest('hex'),
 source:'Both use packages/socket/src/guidanceText.mjs buildGuidanceText and the preset persona; matches the native-memory default options in packages/socket/plugins/guidance.mjs.',
 options:{askUserEnabled:true,capsuleActive:false,reviewEnabled:false,runPolicyEnabled:true,capsuleToolEnabled:false,openVikingMemory:true,memorySearchHint:false},
 defaultAnswer:'apps/server/src/dshProfilePatch.mjs: thinking enabled, reasoningEffort high',
 limits:['The memory block and learned-method read exchange are simulated by the paired instrument. It omits other kernel system sections and tool definitions.',
 'Its synthesized method path is /runtime/capsule-methods/_lm/SKILL.md; real learned method paths are dynamic.',
 'It does not model attended receipt behavior, history search or opening index feature variants. This is prompt-component parity, not full-wire equality.',
 'Judge is fixed to deepseek-flash thinking disabled in both arms, retaining harness scoring; historical baseline judge mode was implicit.']};
await writeFile('/srv/evimed/runs/gx-g8-1/prompt-audit.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
