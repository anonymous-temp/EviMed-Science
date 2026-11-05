// A stand-in for `docker run` as rsi-lab-monthly.sh calls it (through fake_docker.sh, which renames `--env-file`: node itself reads that option wherever it stands): the mounts are mapped to host directories, the container's arguments are translated to host paths and
// the script runs under node in the checkout (FAKE_DOCKER_REPO). The steps that need a lab database, the runner or a signing key are stubbed: lab_bootstrap.mjs, run.mjs
// and evaluator.mjs only record that they were called (run.mjs writes a run.json that ends the campaign; FAKE_RESUME_EXIT makes its `resume` refuse with that
// exit code, as run.mjs does for a campaign it cannot complete). frontier_labels.mjs runs for real behind frontier_labels_stand_in.mjs, which stands in for the lab's
// budget ledger and for DashScope only. Every call is appended to FAKE_DOCKER_LOG with its network and the container paths it mounted.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv[0] !== 'run') process.exit(0);
const withValue = new Set(['--network', '--tmpfs', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpu-shares', '--user', '--ENVFILE', '-e', '-v', '--entrypoint']);
const mounts = [], flags = {};
let at = 1;
for (; at < argv.length && argv[at].startsWith('-'); at++) {
  if (!withValue.has(argv[at])) continue;
  const value = argv[++at];
  if (argv[at - 1] === '-v') { const [host, container] = value.split(':'); mounts.push([host, container]); } else flags[argv[at - 1]] = value;
}
const [image, script, ...rest] = argv.slice(at);
const translate = (arg) => {
  for (const [host, container] of [...mounts].sort((a, b) => b[1].length - a[1].length)) {
    if (arg === container) return host;
    if (arg.startsWith(`${container}/`)) return join(host, arg.slice(container.length));
  }
  return arg;
};
const args = rest.map(translate);
appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify({ image, script, args, network: flags['--network'], user: flags['--user'], mounts: mounts.map(([, container]) => container), envFile: flags['--ENVFILE'] ?? null })}\n`);
const stubbed = basename(script ?? '');
if (stubbed === 'lab_bootstrap.mjs' || stubbed === 'evaluator.mjs') process.exit(0);
// FAKE_FINALIZE stands in for the signer: `refuse:<code>` refuses as finalize.mjs does, `sign:<bytes>` writes the bundle where the month's finalize.json says. Unset, the real script runs.
if (stubbed === 'finalize.mjs' && process.env.FAKE_FINALIZE) {
  const [mode, ...rest] = process.env.FAKE_FINALIZE.split(':');
  if (mode === 'refuse') { console.error(JSON.stringify({ status: 'refused', reason: rest.join(':') })); process.exit(1); }
  writeFileSync(join(mounts.find(([, container]) => container === '/srv/rsi-lab/state')[0], 'current', 'bundle.json'), rest.join(':'));
  process.exit(0);
}
if (stubbed === 'run.mjs') {
  const out = args[args.indexOf('--out-dir') + 1];
  if (args[0] === 'run' && out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'run.json'), JSON.stringify({ status: 'not-qualified', reason: 'campaign_stubbed_runner' })); }
  if (args[0] === 'resume' && out && process.env.FAKE_RESUME_EXIT) {
    mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'resume.json'), JSON.stringify({ status: 'not-qualified', reason: 'campaign_stubbed_resume_refused' }));
    process.exit(Number(process.env.FAKE_RESUME_EXIT));
  }
  process.exit(0);
}
const entry = stubbed === 'frontier_labels.mjs' ? join(dirname(fileURLToPath(import.meta.url)), 'frontier_labels_stand_in.mjs') : join(process.env.FAKE_DOCKER_REPO, script);
const done = spawnSync(process.execPath, [entry, ...args], { cwd: process.env.FAKE_DOCKER_REPO, stdio: 'inherit' });
process.exit(done.status ?? 1);
