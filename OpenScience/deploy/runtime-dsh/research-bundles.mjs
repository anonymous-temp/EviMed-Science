/** Build-time DSH installation and read-only first-party image inspection.
 * No user-selected command, module or path is accepted by inspect. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PROFILE = '/opt/evimed/dsh-home-seed/profiles/evimed-runtime';
const DEFAULT_ROOT = '/opt/evimed/research-bundles';
const COMMON = ['@evimed/design-tokens', '@evimed/domain', '@evimed/harness-port', '@evimed/research-plugin-runtime'];
const IDS = ['virtual-trial', 'virtual-cohort', 'virtual-patient', 'synthetic-control', 'virtual-research-suite'];
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonical = value => JSON.stringify(value);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`research_bundle_command_failed:${command}`);
}
function files(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name === '.DS_Store') return [];
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const target = path.join(root, name);
    if (entry.isSymbolicLink()) throw new Error('research_package_symlink');
    if (entry.isDirectory()) return files(root, name);
    if (!entry.isFile()) throw new Error('research_package_file_invalid');
    return [{ name, sha256: hash(fs.readFileSync(target)) }];
  });
}
function installedRoot(name, from) {
  // Resolve at the actual importing package. A hoisted package with the same
  // name is not evidence of what a nested dependency imports.
  const require = createRequire(path.join(from, 'package.json'));
  for (const search of require.resolve.paths(name) ?? []) {
    const candidate = path.join(search, name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
  }
  throw new Error(`research_dependency_identity_invalid:${name}`);
}
export function measureClosure(profile, id) {
  if (!IDS.includes(id)) throw new Error('research_native_id_invalid');
  const name = `@evimed/${id}`, own = installedRoot(name, profile);
  const nodes = [], seen = new Map();
  function visit(root) {
    if (seen.has(root)) return seen.get(root);
    const index = nodes.length;
    seen.set(root, index);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const node = { name: pkg.name, version: pkg.version, files: files(root), dependencies: [] };
    nodes.push(node);
    const declared = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const dependency of Object.keys(declared).sort()) {
      let resolved;
      try { resolved = installedRoot(dependency, root); }
      catch (error) {
        if (!Object.hasOwn(pkg.optionalDependencies ?? {}, dependency) &&
            !(pkg.peerDependenciesMeta?.[dependency]?.optional && !Object.hasOwn(pkg.dependencies ?? {}, dependency))) throw error;
        node.dependencies.push({ name: dependency, node: null });
        continue;
      }
      node.dependencies.push({ name: dependency, node: visit(resolved) });
    }
    return index;
  }
  visit(own);
  if (nodes[0].name !== name) throw new Error('research_installed_identity_invalid');
  return { closureDigest: hash(canonical(nodes)), version: nodes[0].version };
}

export function record(profile = DEFAULT_PROFILE, root = DEFAULT_ROOT) {
  const profilePackage = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  const receipts = IDS.map(id => {
    const name = `@evimed/${id}`;
    if (!profilePackage.dsh?.profile?.bundles?.includes(name)) throw new Error('research_bundle_not_installed');
    const measured = measureClosure(profile, id);
    const tarball = path.join(root, 'tarballs', `evimed-${id}-${measured.version}.tgz`);
    const prefix = id.replaceAll('-', '_');
    return { schemaVersion: 1, id, coordinate: { kind: 'npm', name, version: measured.version },
      integrity: hash(fs.readFileSync(tarball)), closureDigest: measured.closureDigest, row: `evimed-${id}`,
      tools: id === 'virtual-research-suite' ? ['virtual_research_available'] : ['describe','start','read','cancel','report'].map(action => `${prefix}_${action}`) };
  });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, receipts }, null, 2) + '\n', { mode: 0o444, flag: 'wx' });
  return receipts;
}

export function inspect(id, profile = DEFAULT_PROFILE, root = DEFAULT_ROOT) {
  if (!IDS.includes(id)) throw new Error('research_native_id_invalid');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.receipts)) throw new Error('research_receipt_invalid');
  const found = manifest.receipts.filter(receipt => receipt.id === id);
  if (found.length !== 1) throw new Error('research_receipt_invalid');
  const receipt = found[0], measured = measureClosure(profile, id);
  const installed = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  if (!installed.dsh?.profile?.bundles?.includes(`@evimed/${id}`) || receipt.closureDigest !== measured.closureDigest
      || receipt.coordinate?.version !== measured.version || receipt.integrity !== hash(fs.readFileSync(path.join(root, 'tarballs', `evimed-${id}-${measured.version}.tgz`)))) throw new Error('research_receipt_mismatch');
  return receipt;
}

async function install() {
  const profile = DEFAULT_PROFILE, root = DEFAULT_ROOT;
  fs.mkdirSync(path.join(root, 'tarballs'), { recursive: true });
  for (const id of IDS) run('pnpm', ['--dir', `/opt/evimed/research-source/${id}`, 'pack', '--pack-destination', path.join(root, 'tarballs')]);
  const cliRequire = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
  const yaml = cliRequire('yaml');
  const workspaceFile = path.join(profile, 'pnpm-workspace.yaml');
  const workspace = yaml.parse(fs.readFileSync(workspaceFile, 'utf8'));
  workspace.overrides ??= {};
  for (const name of COMMON) workspace.overrides[name] = `file:/opt/evimed/socket/node_modules/${name}`;
  fs.writeFileSync(workspaceFile, yaml.stringify(workspace));
  const tarballs = IDS.map(id => {
    const pkg = JSON.parse(fs.readFileSync(`/opt/evimed/research-source/${id}/package.json`, 'utf8'));
    return path.join(root, 'tarballs', `evimed-${id}-${pkg.version}.tgz`);
  });
  run('dsh', ['plugin', '--profile', 'evimed-runtime', 'add', '--save-prod', '--save-exact', '--ignore-scripts', ...tarballs],
    { env: { ...process.env, DSH_HOME: path.dirname(path.dirname(profile)) } });
  const packageFile = path.join(profile, 'package.json'), pkg = JSON.parse(fs.readFileSync(packageFile,'utf8'));
  const nativeNames = IDS.map(id => `@evimed/${id}`);
  const bundles = pkg.dsh.profile.bundles;
  const before = bundles.filter(name => !nativeNames.includes(name));
  const socket = before.indexOf('@evimed/dsh-socket');
  if (socket < 0) throw new Error('research_socket_not_installed');
  before.splice(socket, 0, ...nativeNames);pkg.dsh.profile.bundles = before;
  fs.writeFileSync(packageFile, JSON.stringify(pkg,null,2)+'\n');
  // The upstream manager writes 0600. Runtime and inspector run unprivileged;
  // the immutable image manifest contains public package coordinates only.
  fs.chmodSync(packageFile, 0o644);
  record(profile,root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action,id,...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('research_command_invalid');
  if (action === 'install' && !id) await install();
  else if (action === 'inspect' && id) console.log(JSON.stringify(inspect(id)));
  else if (action === 'record' && !id) record();
  else throw new Error('research_command_invalid');
}
