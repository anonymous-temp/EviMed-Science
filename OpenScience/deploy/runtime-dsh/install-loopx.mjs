/** Install the complete upstream distribution at image build time, never during a research turn. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyLoopxArchive(file, expected) {
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error('LoopX archive digest mismatch.');
  return actual;
}

export function installLoopx({ pins, root = '/opt/evimed/loopx', python = '/opt/evimed/venv/bin/python',
  cli = '/opt/evimed/venv/bin/loopx', archives = root } = {}) {
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
