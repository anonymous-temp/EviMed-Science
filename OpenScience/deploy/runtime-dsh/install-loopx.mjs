/** Install the complete upstream distribution at image build time, never during a research turn. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * The folders of what the CLI installed that the model's skill catalogue keeps, from the same contract record.
 *
 * Hidden cost: `loopx workflow-skills --install` writes eight folders, and the kernel puts every folder of a skill root into
 * the model's catalogue, in every session — about 3,000 characters of description lines. Six of the eight are LoopX's own
 * repository-management workflows (PR review, PR programmes, benchmarks, performance diagnosis, self-repair, a document
 * registry); a goal on this platform is research, and nothing starts those. The build keeps the entry skill, which `/loopx`
 * invokes, and `loopx-project`, the goal lifecycle the entry skill hands off to, and leaves the rest out of the image. The
 * record says which folders those are, so the inventory page and this build read one list.
 *
 * @param {{ installed?: unknown, kept?: unknown, entry?: unknown }} record the contract
 * @returns {string[]} the kept folders, sorted
 */
export function keptLoopxSkills(record) {
  const installed = Array.isArray(record?.installed) ? record.installed.map(String) : [];
  const kept = Array.isArray(record?.kept) ? record.kept.map(String) : [];
  if (!kept.length) throw new Error('The LoopX workflow-skill record keeps no skill.');
  const outside = kept.filter(name => !installed.includes(name));
  if (outside.length) throw new Error(`The LoopX workflow-skill record keeps skills the CLI does not install: ${outside.join(', ')}.`);
  if (!kept.includes(String(record?.entry ?? 'loopx'))) throw new Error('The LoopX workflow-skill record must keep the entry skill.');
  return [...kept].sort();
}

/** A folder the CLI copied out of a read-only package keeps its modes; an unlink needs the folder writable. @param {string} target */
function makeWritable(target) {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) return;
  chmodSync(target, info.mode | 0o200 | (info.isDirectory() ? 0o100 : 0));
  if (info.isDirectory()) for (const entry of readdirSync(target)) makeWritable(path.join(target, entry));
}

/** Python's `json.dumps(value, ensure_ascii=False, sort_keys=True)`: the form the CLI hashes its readback items in. */
function pythonJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}: ${pythonJson(value[key])}`).join(', ')}}`;
}

/**
 * The CLI's own readback manifest (`.loopx-skill-install.json`), pruned to the folders that are left, the way the CLI prunes it
 * when it retires a managed skill (`retire_duplicate_managed_skills`): the ids and the items of the folders that went, and the
 * digest over what remains. Left as the CLI wrote it, the manifest would name eight folders in a directory that holds two, and
 * its own check (`inspect_skill_install_readback`, which the onboarding packet runs when `LOOPX_SKILLS_DIR` names this root)
 * would report the six as missing.
 *
 * @param {string} skillsDir @param {readonly string[]} kept
 * @returns {boolean} whether there was a manifest to prune
 */
export function pruneSkillInstallReadback(skillsDir, kept) {
  const file = path.join(skillsDir, '.loopx-skill-install.json');
  if (!existsSync(file)) return false;
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(manifest.materialized_skill_ids)) manifest.materialized_skill_ids = manifest.materialized_skill_ids.map(String).filter(id => kept.includes(id)).sort();
  const items = manifest.skills?.items;
  if (items && typeof items === 'object') {
    for (const id of Object.keys(items)) if (!kept.includes(id)) delete items[id];
    manifest.skills.digest = createHash('sha256').update(pythonJson(items)).digest('hex');
  }
  // The CLI writes sorted keys, two-space indent and a final newline.
  const sorted = value => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  writeFileSync(file, `${JSON.stringify(sorted(manifest), null, 2)}\n`);
  return true;
}

/**
 * The CLI's own hash of one skill folder (`hash_skill_tree` in `loopx/skill_install_readback.py`): over the files in the order
 * Python sorts `Path`s (component by component, not as one string), each as its relative path, a NUL, the file's sha256 in hex and
 * a newline. The readback manifest records it for every folder the CLI installed and the CLI's own check reads it back, so a
 * folder this build edits has to be written back to the manifest the way the CLI would have written it.
 *
 * @param {string} root the skill folder
 * @returns {{ available: boolean, file_count: number, sha256: string | null }}
 */
export function hashSkillTree(root) {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return { available: false, file_count: 0, sha256: null };
  /** @type {string[][]} */
  const files = [];
  const walk = (/** @type {string} */ directory, /** @type {string[]} */ prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name), [...prefix, entry.name]);
      else if (entry.isFile()) files.push([...prefix, entry.name]);
    }
  };
  walk(root, []);
  const compare = (/** @type {string[]} */ a, /** @type {string[]} */ b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  };
  const digest = createHash('sha256');
  for (const parts of files.sort(compare)) {
    digest.update(parts.join('/'));
    digest.update(Buffer.from([0]));
    digest.update(createHash('sha256').update(readFileSync(path.join(root, ...parts))).digest('hex'));
    digest.update('\n');
  }
  return { available: true, file_count: files.length, sha256: digest.digest('hex') };
}

/**
 * The places where the CLI's `loopx-project` sends the model to `loopx-doc-registry`, the one workflow skill of the six this
 * image leaves out. Each is exact text of the pinned CLI's file, present once, and none says anything but "go to that skill".
 *
 * Hidden cost: the first is in the skill's description line, which sits in every session's catalogue, and the second is the
 * paragraph a model reads on loading the skill; a model told to "prefer" or to "load" a skill that is not there spends a call
 * on the refusal, and the dropped skill's own description ("use even when the user does not mention LoopX") is the one
 * that would have pulled ordinary note-taking into a LoopX registry. The third names the same skill as the "trigger" of a
 * section whose commands stand on their own.
 */
export const LOOPX_PROJECT_EDITS = Object.freeze([
  Object.freeze({ from: ' For registering durable project materials, prefer loopx-doc-registry.', to: '' }),
  Object.freeze({
    from: 'If the task is mainly about reading,\nremembering, recording, indexing, or registering a durable project material,\nload `loopx-doc-registry` and use that narrower workflow first.\n\n',
    to: '',
  }),
  Object.freeze({ from: 'treat\nthat as a doc-registry skill trigger.', to: 'register\nit with the commands below.' }),
]);

/**
 * Takes the dangling pointers out of the kept `loopx-project` skill, bound to the pinned CLI's bytes: the folder is edited only
 * when its SKILL.md is the file the pin names (`loopx.compatibility.skillEdit.sha256`, the wheel's own), every fragment is
 * there exactly once, and the result is the file the pin records (`adaptedSha256`). A CLI bump that changes the file fails the
 * build by name until the edit is read again; the readback manifest is written back so the CLI's own check still passes.
 *
 * @param {{ skillsDir: string, edit: { skill?: string, file?: string, sha256?: string, adaptedSha256?: string } | undefined }} options
 * @returns {{ skill: string, file: string, sourceSha256: string, adaptedSha256: string, edits: number } | null} null when the pin records no edit
 */
export function adaptLoopxProjectSkill({ skillsDir, edit }) {
  if (!edit) return null;
  const { skill = 'loopx-project', file = 'SKILL.md', sha256, adaptedSha256 } = edit;
  const target = path.join(skillsDir, skill, file);
  const original = readFileSync(target);
  const hash = (/** @type {Buffer | string} */ body) => createHash('sha256').update(body).digest('hex');
  if (hash(original) !== sha256) throw new Error(`The LoopX ${skill} skill differs from the reviewed compatibility input; read the pinned CLI's file again before the edit is applied.`);
  let text = original.toString('utf8');
  for (const { from, to } of LOOPX_PROJECT_EDITS) {
    if (text.split(from).length !== 2) throw new Error(`The LoopX ${skill} skill does not hold the reviewed text exactly once: ${JSON.stringify(from.slice(0, 60))}`);
    text = text.replace(from, () => to);
  }
  const adapted = Buffer.from(text, 'utf8');
  if (hash(adapted) !== adaptedSha256) throw new Error(`The edited LoopX ${skill} skill is not the reviewed one.`);
  // The CLI copies out of a read-only package and keeps the modes; the folder is writable for the edit and put back as it was.
  const folder = path.dirname(target);
  const modes = [statSync(folder).mode, statSync(target).mode];
  chmodSync(folder, modes[0] | 0o200);
  chmodSync(target, modes[1] | 0o200);
  writeFileSync(target, adapted);
  chmodSync(target, modes[1]);
  chmodSync(folder, modes[0]);
  return { skill, file, sourceSha256: sha256, adaptedSha256: hash(adapted), edits: LOOPX_PROJECT_EDITS.length };
}

/**
 * Writes one or more folders back to the CLI's readback manifest as the CLI would have written them: the item of each (its tree
 * hash) and the digest over all items. For a folder this build edited.
 *
 * @param {string} skillsDir @param {readonly string[]} skillIds
 * @returns {boolean} whether there was a manifest
 */
export function refreshSkillInstallReadback(skillsDir, skillIds) {
  const file = path.join(skillsDir, '.loopx-skill-install.json');
  if (!existsSync(file)) return false;
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const items = manifest.skills?.items;
  if (!items || typeof items !== 'object') return false;
  for (const id of skillIds) if (id in items) items[id] = hashSkillTree(path.join(skillsDir, id));
  manifest.skills.digest = createHash('sha256').update(pythonJson(items)).digest('hex');
  const sorted = (/** @type {any} */ value) => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  writeFileSync(file, `${JSON.stringify(sorted(manifest), null, 2)}\n`);
  return true;
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
  const contract = JSON.parse(readFileSync(record, 'utf8'));
  verifyLoopxWorkflowSkills(skills.map(skill => skill.name), contract);
  // The catalogue keeps what the contract keeps; the rest never reaches the image, and the receipt says so by name.
  const kept = keptLoopxSkills(contract);
  const dropped = skills.map(skill => skill.name).filter(name => !kept.includes(name));
  for (const name of dropped) {
    makeWritable(path.join(skillsDir, name));
    rmSync(path.join(skillsDir, name), { recursive: true, force: true });
  }
  pruneSkillInstallReadback(skillsDir, kept);
  const left = readdirSync(skillsDir).filter(name => !name.startsWith('.')).sort();
  if (JSON.stringify(left) !== JSON.stringify(kept)) throw new Error(`The LoopX skills left after filtering (${left.join(', ')}) are not the kept ones (${kept.join(', ')}).`);
  // What the kept `loopx-project` says about the skill that was dropped, taken out (digest-bound to the pinned CLI's file).
  const edit = adaptLoopxProjectSkill({ skillsDir, edit: pin.compatibility?.skillEdit });
  if (edit) refreshSkillInstallReadback(skillsDir, [edit.skill]);
  const carried = skills.filter(skill => kept.includes(skill.name)).map(skill => edit && skill.name === edit.skill
    ? { name: skill.name, sha256: createHash('sha256').update(readFileSync(path.join(skillsDir, skill.name, 'SKILL.md'))).digest('hex') } : skill);
  const receipt = { schemaVersion: 1, version: pin.version, pluginVersion: pin.plugin.version,
    wheelSha256: pin.wheel.sha256, pluginSha256: pin.plugin.sha256,
    // `skills` is what the image carries (after the edit below, when there is one), as it always was; `shipped` is every folder
    // the pinned CLI wrote, with the digest it wrote it with, and `edits` says what this build changed in what it kept.
    skills: carried, shipped: skills, kept, dropped, ...(edit ? { edits: [edit] } : {}) };
  writeFileSync(path.join(root, 'installation.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pins = JSON.parse(readFileSync(process.argv[2] ?? '/opt/evimed/runtime-deps-version.json', 'utf8'));
  const receipt = installLoopx({ pins });
  console.log(`Installed LoopX ${receipt.version}, DSH plugin ${receipt.pluginVersion}, ${receipt.skills.length} of ${receipt.shipped.length} workflow skills kept.`);
}
