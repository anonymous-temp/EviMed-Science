/** A digest-bound compatibility patch applied only while building the immutable profile. */
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const original = 'const successful = source?.kind === "tool" && message?.role === "user" && block?.type === "tool-result" && block.toolCallId === callId && (block.isError === void 0 || block.isError === false) && data?.error === void 0;';
const replacement = 'const successful = isSuccessfulLoopxSkillResult(data, callId);';
const preamble = 'import { isSuccessfulLoopxSkillResult } from "./evimed-loopx-events.mjs";\n';
const pauseOriginal = '\t\treturn {\n\t\t\tkind: "succeeded",\n\t\t\tsnapshot: postRead.snapshot,';
const pauseReplacement = '\t\tif (request.op === "pause" && postRead.snapshot.goalActivation === "stopped") explainLoopxPause(capture.agent);\n' + pauseOriginal;
const pausePreamble = 'import { explainLoopxPause } from "./evimed-loopx-pause.mjs";\n';

export function adaptLoopxDriver({ pluginDir, pin, helper }) {
  const hash = text => createHash('sha256').update(text).digest('hex');
  const goalbarFile = path.join(pluginDir, pin.compatibility.goalbarFile);
  const goalbarInstalled = readFileSync(goalbarFile, 'utf8');
  const goalbar = goalbarInstalled.startsWith(pausePreamble)
    ? goalbarInstalled.slice(pausePreamble.length).replace(pauseReplacement, pauseOriginal) : goalbarInstalled;
  if (hash(goalbar) !== pin.compatibility.goalbarSha256 || goalbar.split(pauseOriginal).length !== 2) {
    throw new Error('The LoopX GoalBar differs from the reviewed compatibility input.');
  }
  const file = path.join(pluginDir, pin.compatibility.driverFile);
  const installed = readFileSync(file, 'utf8');
  // A derived-image build may run profile preparation again. Verify the
  // reverse transformation against the official bytes before reapplying.
  const body = installed.startsWith(preamble) ? installed.slice(preamble.length).replace(replacement, original) : installed;
  if (hash(body) !== pin.compatibility.driverSha256 || body.split(original).length !== 2) {
    throw new Error('The LoopX driver differs from the reviewed compatibility input.');
  }
  const adapted = preamble + body.replace(original, replacement);
  const adaptedGoalbar = pausePreamble + goalbar.replace(pauseOriginal, pauseReplacement);
  const pauseHelper = path.join(path.dirname(helper), 'loopxPause.mjs');
  copyFileSync(helper, path.join(pluginDir, 'lib/evimed-loopx-events.mjs'));
  copyFileSync(pauseHelper, path.join(pluginDir, 'lib/evimed-loopx-pause.mjs'));
  writeFileSync(file, adapted);
  writeFileSync(goalbarFile, adaptedGoalbar);
  const receipt = { schemaVersion: 1, adaptation: 'dsh-tool-result-activation', sourceSha256: pin.compatibility.driverSha256,
    adaptedSha256: hash(adapted), helperSha256: hash(readFileSync(helper)), upstreamVersion: pin.plugin.version,
    goalbar: { adaptation: 'pause-intent-context', sourceSha256: pin.compatibility.goalbarSha256,
      adaptedSha256: hash(adaptedGoalbar), helperSha256: hash(readFileSync(pauseHelper)) } };
  writeFileSync(path.join(pluginDir, 'evimed-compatibility.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pins = JSON.parse(readFileSync(process.argv[3] ?? '/opt/evimed/runtime-deps-version.json', 'utf8'));
  const helper = process.argv[4] ?? '/opt/evimed/socket/node_modules/@evimed/harness-port/src/loopxEvents.mjs';
  adaptLoopxDriver({ pluginDir: process.argv[2], pin: pins.loopx, helper });
}
