/** Install the complete upstream distribution at image build time, never during a research turn. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORD_BESIDE = path.join(HERE, 'loopx-workflow-skills.json');
const RECORD_IN_CONTRACT = path.join(HERE, '..', '..', 'packages', 'contracts', 'loopx', 'workflow-skills.json');

/**
 * The folders the pinned CLI installs, as `packages/contracts/loopx/workflow-skills.json` records them (read off the pinned
 * wheel). The image build copies that file beside this one; a checkout reads it from the contract directory.
 */
export const WORKFLOW_SKILLS_RECORD = existsSync(RECORD_BESIDE) ? RECORD_BESIDE : RECORD_IN_CONTRACT;

/**
 * Holds what `loopx workflow-skills --install` wrote equal to what the contract records for this CLI, and names the difference.
 *
 * Hidden knowledge: LoopX was installed whole and nothing said which skills that was. The plugins page lists what the image
 * carries (`runtime-inventory.json`), so a skill a CLI bump adds — or one it stops writing — is a decision, and it is made
 * here, at the build, where the folders are, instead of reaching a model's catalogue unlisted.
 *
 * @param {readonly string[]} found the skill folders the install left
 * @param {{ installed?: unknown, version?: unknown }} record the contract
 * @returns {string[]} the folders, sorted
 */
export function verifyLoopxWorkflowSkills(found, record) {
  const expected = Array.isArray(record?.installed) ? record.installed.map(String) : [];
  if (expected.length === 0) throw new Error('The LoopX workflow-skill record names no installed skill.');
  const names = [...found].sort();
  const missing = [...expected].sort().filter(name => !names.includes(name));
  const unrecorded = names.filter(name => !expected.includes(name));
  if (missing.length || unrecorded.length) {
    throw new Error(`The LoopX CLI installed other skills than packages/contracts/loopx/workflow-skills.json records for ${record?.version ?? 'this version'}`
      + `${missing.length ? `; missing: ${missing.join(', ')}` : ''}${unrecorded.length ? `; not recorded: ${unrecorded.join(', ')}` : ''}. `
      + 'Re-record the file from the pinned wheel and list each new skill in packages/domain/src/runtime-inventory-zh.json.');
  }
  return names;
}

export function verifyLoopxArchive(file, expected) {
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error('LoopX archive digest mismatch.');
  return actual;
}

export function installLoopx({ pins, root = '/opt/evimed/loopx', python = '/opt/evimed/venv/bin/python',
  cli = '/opt/evimed/venv/bin/loopx', archives = root, record = WORKFLOW_SKILLS_RECORD } = {}) {
  const pin = pins.loopx;
  mkdirSync(root, { recursive: true });
  mkdirSync(archives, { recursive: true });
  const env = { ...process.env, LOOPX_USAGE_PING: '0', DO_NOT_TRACK: '1', PYTHONDONTWRITEBYTECODE: '1' };
  for (const artifact of [pin.wheel, pin.plugin]) {
    const file = path.join(archives, artifact.filename);
    try { verifyLoopxArchive(file, artifact.sha256); }
    catch {
      execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3',
        '--connect-timeout', '20', '--max-time', '600', artifact.url, '-o', file], { env, stdio: 'inherit' });
      verifyLoopxArchive(file, artifact.sha256);
    }
  }
  execFileSync('uv', ['pip', 'install', '--python', python, '--no-deps', path.join(archives, pin.wheel.filename)], { env, stdio: 'inherit' });
  const version = execFileSync(cli, ['--version'], { env, encoding: 'utf8' }).trim();
  if (version !== `loopx ${pin.version}`) throw new Error('Installed LoopX version differs from the pin.');
  const skillsDir = path.join(root, 'skills');
  const result = execFileSync(cli, ['workflow-skills', '--install', '--skills-dir', skillsDir,
    '--cli-bin', cli, '--host-surface', 'deepseek-harness-native', '--format', 'json'],
  { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const installed = JSON.parse(result);
  if (installed.ok === false) throw new Error('LoopX workflow skill installation failed.');
  const skills = readdirSync(skillsDir).filter(name => !name.startsWith('.')).sort().flatMap(name => {
    try {
      const body = readFileSync(path.join(skillsDir, name, 'SKILL.md'));
      return [{ name, sha256: createHash('sha256').update(body).digest('hex') }];
    } catch { return []; }
  });
  if (!skills.some(skill => skill.name === 'loopx') || !skills.some(skill => skill.name === 'loopx-project')) {
    throw new Error('The native LoopX entry and lifecycle skills were not installed.');
  }
  // What the CLI wrote is what the contract says it writes, for this version: a difference is a decision, named by skill.
  verifyLoopxWorkflowSkills(skills.map(skill => skill.name), JSON.parse(readFileSync(record, 'utf8')));
  const receipt = { schemaVersion: 1, version: pin.version, pluginVersion: pin.plugin.version,
    wheelSha256: pin.wheel.sha256, pluginSha256: pin.plugin.sha256, skills };
  writeFileSync(path.join(root, 'installation.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pins = JSON.parse(readFileSync(process.argv[2] ?? '/opt/evimed/runtime-deps-version.json', 'utf8'));
  const receipt = installLoopx({ pins });
  console.log(`Installed LoopX ${receipt.version}, DSH plugin ${receipt.pluginVersion}, ${receipt.skills.length} workflow skills.`);
}
