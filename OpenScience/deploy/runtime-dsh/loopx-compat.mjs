/** A digest-bound compatibility patch applied only while building the immutable profile. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const original = 'const successful = source?.kind === "tool" && message?.role === "user" && block?.type === "tool-result" && block.toolCallId === callId && (block.isError === void 0 || block.isError === false) && data?.error === void 0;';
const replacement = 'const successful = isSuccessfulLoopxSkillResult(data, callId);';
const preamble = 'import { isSuccessfulLoopxSkillResult } from "./evimed-loopx-events.mjs";\n';
const pauseOriginal = '\t\treturn {\n\t\t\tkind: "succeeded",\n\t\t\tsnapshot: postRead.snapshot,';
const pauseReplacement = '\t\tif (request.op === "pause" && postRead.snapshot.goalActivation === "stopped") explainLoopxPause(capture.agent);\n' + pauseOriginal;
const pausePreamble = 'import { explainLoopxPause } from "./evimed-loopx-pause.mjs";\n';

/** pnpm sorts package names; DSH appends new bundles in that order, not CLI argument order. */
export function orderLoopxProfileBundles(profileFile) {
  const manifest = JSON.parse(readFileSync(profileFile, 'utf8'));
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || ['dsh-loopx-plugin', '@evimed/dsh-socket'].some(name => bundles.filter(value => value === name).length !== 1)) {
    throw new Error('The prepared profile must contain exactly one LoopX and EviMed bundle.');
  }
  const ordered = bundles.filter(name => name !== 'dsh-loopx-plugin');
  ordered.splice(ordered.indexOf('@evimed/dsh-socket'), 0, 'dsh-loopx-plugin');
  if (JSON.stringify(ordered) !== JSON.stringify(bundles)) {
    manifest.dsh.profile.bundles = ordered;
    writeFileSync(profileFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return ordered;
}

/**
 * The kernel's own exact-version exemption for the pinned plugin, granted while the immutable profile is built.
 *
 * The plugin declares the DSH range it was written for (0.1.1-beta.6: `<0.2.1-0`). From 0.2.1 the kernel holds a
 * bundle to that range at install and at every startup, and a bundle outside it is skipped whole, so the LoopX GoalBar,
 * driver and skills were gone from the profile while every file of ours still named them. Upstream's answer is an
 * exemption in the profile's own `compatibility.json`: one `name@version` for exactly the listed DSH versions, written
 * by `dsh plugin allow-version … --accept-risk`, inherited by neither a plugin nor a kernel upgrade. It is granted here
 * only for the pair the pins record as reviewed (`loopx.compatibility.dshVersionExemption`, a live run of the pair is
 * the review), only for the archive whose digest is the pin, and the file it leaves must hold that one grant and
 * nothing else. A moved kernel or plugin pin fails the build by name until the pair is reviewed again.
 * @param {{ seedHome: string, profile?: string, archive: string, pins: Record<string, any>, dsh?: string }} options
 * @returns {Record<string, string[]>} the profile's compatibility record
 */
export function grantLoopxVersionExemption({ seedHome, profile = 'evimed-runtime', archive, pins, dsh = 'dsh' }) {
  const loopx = pins.loopx;
  const exemption = loopx?.compatibility?.dshVersionExemption;
  const plugin = `dsh-loopx-plugin@${loopx?.plugin?.version}`;
  if (!exemption) throw new Error('deps-version.json records no reviewed LoopX version exemption.');
  if (exemption.plugin !== plugin || exemption.dsh !== pins.dsh?.version) {
    throw new Error(`The LoopX exemption was reviewed for ${exemption.plugin} on DSH ${exemption.dsh}; the pins are ${plugin} on DSH ${pins.dsh?.version}. Review the pair on a live kernel and record it again.`);
  }
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== loopx.plugin.sha256) {
    throw new Error('The LoopX plugin archive differs from the pinned digest; no exemption is granted for unreviewed bytes.');
  }
  execFileSync(dsh, ['plugin', '--profile', profile, 'allow-version', plugin, '--dsh-version', exemption.dsh, '--accept-risk'],
    { env: { ...process.env, DSH_HOME: seedHome }, stdio: ['ignore', 'inherit', 'inherit'] });
  const file = path.join(seedHome, 'profiles', profile, 'compatibility.json');
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (JSON.stringify(record) !== JSON.stringify({ [plugin]: [exemption.dsh] })) {
    throw new Error(`The profile's compatibility record is not the one reviewed grant: ${JSON.stringify(record)}`);
  }
  // The plugin manager writes it 0600; the runtime's own user reads it at every startup.
  chmodSync(file, 0o644);
  return record;
}

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
  if (process.argv[2] === '--order-profile') orderLoopxProfileBundles(process.argv[3]);
  else if (process.argv[2] === '--grant-exemption') {
    const pins = JSON.parse(readFileSync(process.argv[5] ?? '/opt/evimed/runtime-deps-version.json', 'utf8'));
    grantLoopxVersionExemption({ seedHome: process.argv[3], archive: process.argv[4], pins });
  } else {
    const pins = JSON.parse(readFileSync(process.argv[3] ?? '/opt/evimed/runtime-deps-version.json', 'utf8'));
    const helper = process.argv[4] ?? '/opt/evimed/socket/node_modules/@evimed/harness-port/src/loopxEvents.mjs';
    adaptLoopxDriver({ pluginDir: process.argv[2], pin: pins.loopx, helper });
  }
}
