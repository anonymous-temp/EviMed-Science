/** Build-only YAML4 security backport. No serving or customer-controlled entry point. */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sealProfileSeed } from './profile-seed.mjs';

const MAX_ARCHIVE = 2 * 1024 * 1024;
const metadataFile = '/opt/evimed/runtime-deps-version.json';
const cacheRoot = '/opt/evimed/runtime-security';
const globalRoot = '/usr/local/lib/node_modules';
const seedHome = '/opt/evimed/dsh-home-seed';
const profile = 'evimed-runtime';
const fail = message => { throw new Error('runtime_yaml_security: ' + message); };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))));

/** Only the explicitly owned parser package participates. @param {string} file */
export function securityYamlPin(file) {
  const policy = json(file), pin = policy.$runtimeSecurity?.['js-yaml'];
  if (Object.keys(policy.$runtimeSecurity ?? {}).join(',') !== 'js-yaml' || !/^4\.\d+\.\d+$/.test(pin?.version ?? '')
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin?.integrity ?? '')) fail('invalid single-source pin');
  return { name: 'js-yaml', version: pin.version, integrity: pin.integrity };
}

/** Integrity precedes decompression; the maintained stdlib decoder bounds the entire expanded stream before tar parsing.
 * @param {string} archive @param {any} pin @param {string} destination */
export function extractVerifiedYamlPackage(archive, pin, destination) {
  try { fs.lstatSync(destination);fail('fresh extraction required'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stat = fs.lstatSync(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ARCHIVE) fail('archive size/type');
  const integrity = 'sha512-' + createHash('sha512').update(fs.readFileSync(archive)).digest('base64');
  if (integrity !== pin.integrity) fail('archive integrity');
  const decoder = `import gzip,io,json,pathlib,tarfile,sys,re
archive,destination=sys.argv[1:]
with gzip.open(archive,'rb') as f: data=f.read(4*1024*1024+1)
if len(data)>4*1024*1024: raise ValueError('expanded archive exceeds bound')
root=pathlib.Path(destination)
if root.exists(): raise ValueError('fresh extraction required')
with tarfile.open(fileobj=io.BytesIO(data),mode='r:') as tar:
 entries=tar.getmembers()
 if len(entries)>128: raise ValueError('entry bound')
 total=0;seen=set()
 for entry in entries:
  parts=entry.name.split('/')
  if parts[-1]=='': parts=parts[:-1]
  if len(parts)<1 or parts[0]!='package' or any(not p or p in ('.','..') or '\\\\' in p or ':' in p for p in parts) or len(parts)>12: raise ValueError('archive path')
  key='/'.join(parts).lower()
  if any(not re.fullmatch(r'[A-Za-z0-9_.-]+',p) for p in parts): raise ValueError('package path spelling')
  if key in seen or not (entry.isfile() or entry.isdir()): raise ValueError('duplicate/link/special archive entry')
  seen.add(key);total+=entry.size
  if entry.size>512*1024 or total>2*1024*1024: raise ValueError('file/total bound')
 root.mkdir()
 for entry in entries:
  target=root.joinpath(*entry.name.split('/')[1:])
  if entry.isdir(): target.mkdir(parents=True,exist_ok=True)
  else:
   target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(tar.extractfile(entry).read());target.chmod(0o555 if entry.mode&0o111 else 0o444)
`;
  try { execFileSync('python3', ['-c', decoder, archive, destination], { timeout: 5000, maxBuffer: 65536 }); }
  catch { fs.rmSync(destination, { recursive: true, force: true }); fail('archive decoder refused'); }
  const manifest = json(path.join(destination, 'package.json'));
  if (manifest.name !== pin.name || manifest.version !== pin.version || canonical(manifest.dependencies) !== canonical({ argparse: '^2.0.1' })) fail('official package identity/dependencies');
}

/** Physical package directories are visited once; pnpm links resolve through their containing immutable installation.
 * @param {string} root */
export function yamlInstallation(root) {
  const base = fs.realpathSync(root), packages = []; let entries = 0;
  function visit(dir, depth) {
    if (depth > 24) fail('installation depth');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++entries > 100000) fail('installation entry bound');
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.isFile() && entry.name === 'package.json') {
        if (fs.statSync(full).size > 1024 * 1024) fail('manifest bound');
        const value = json(full);
        if (typeof value.name === 'string' && typeof value.version === 'string') packages.push({ file: full, dir: dir, manifest: value });
      }
    }
  }
  visit(base, 0);
  const native = packages.filter(p => p.manifest.name.startsWith('@deepseek-ai/')).map(p => [p.file, p.manifest.name, p.manifest.version, createHash('sha256').update(fs.readFileSync(p.file)).digest('hex')]);
  native.sort((a,b)=>a[0].localeCompare(b[0]));
  return { base, packages, native, yaml: packages.filter(p => p.manifest.name === 'js-yaml') };
}

function packageBytes(root) {
  const rows = [];
  function walk(dir, relative) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (relative === '' && entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name), name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(full, name);
      else if (entry.isFile()) rows.push([name, createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
      else fail('package contains link/special entry');
    }
  }
  walk(root, ''); return JSON.stringify(rows);
}

/** Replace the complete official package; nested dependency providers retain their original resolution.
 * @param {string} root @param {string} official @param {any} pin */
export function patchYamlInstallation(root, official, pin) {
  const before = yamlInstallation(root);
  if (!before.yaml.length) fail('no installed YAML parser');
  const dependencies = canonical(json(path.join(official, 'package.json')).dependencies);
  const providers = new Map();
  for (const target of before.yaml) {
    if (!/^4\./.test(target.manifest.version) || canonical(target.manifest.dependencies) !== dependencies) fail('unsupported original parser dependency semantics');
    providers.set(target.dir, createRequire(target.file).resolve('argparse/package.json'));
  }
  for (const target of before.yaml) {
    if (target.manifest.version === pin.version && packageBytes(target.dir) === packageBytes(official)) continue;
    const originalProvider = providers.get(target.dir);
    const stage = target.dir + '.evimed-security-' + randomUUID(), backup = stage + '-original';
    fs.cpSync(official, stage, { recursive: true });
    const nested = path.join(target.dir, 'node_modules');
    if (fs.existsSync(nested)) fs.cpSync(nested, path.join(stage, 'node_modules'), { recursive: true, dereference: false });
    try { fs.renameSync(target.dir, backup); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      // OverlayFS cannot rename a directory from a cached lower image layer.
      // This build-only step has no concurrent serving reader. Preserve the
      // complete original for rollback before replacing that lower directory.
      fs.cpSync(target.dir, backup, { recursive: true, dereference: false, verbatimSymlinks: true });
      fs.rmSync(target.dir, { recursive: true });
    }
    try { fs.renameSync(stage, target.dir); }
    catch (error) { fs.renameSync(backup, target.dir); throw error; }
    if (createRequire(path.join(target.dir, 'package.json')).resolve('argparse/package.json') !== originalProvider) fail('dependency provider drift');
    fs.rmSync(backup, { recursive: true });
  }
  const after = yamlInstallation(root);
  if (JSON.stringify(before.native) !== JSON.stringify(after.native)) fail('native namespace drift');
  return verifyYamlInstallation(root, official, pin);
}

/** Verify every physical parser and every installed consumer's actual require resolution.
 * @param {string} root @param {string} official @param {any} pin */
export function verifyYamlInstallation(root, official, pin) {
  const inventory = yamlInstallation(root), expected = packageBytes(official), resolved = new Set();
  if (!inventory.yaml.length) fail('no installed YAML parser');
  for (const installed of inventory.yaml) {
    if (installed.manifest.version !== pin.version || packageBytes(installed.dir) !== expected) fail('parser version/full bytes mismatch');
    resolved.add(fs.realpathSync(installed.dir));
  }
  const consumers = inventory.packages.filter(p => Object.hasOwn(p.manifest.dependencies ?? {}, pin.name));
  for (const consumer of consumers) {
    const actual = fs.realpathSync(createRequire(consumer.file).resolve('js-yaml/package.json'));
    if (!resolved.has(path.dirname(actual))) fail('consumer resolves outside verified parser closure');
  }
  return { roots: inventory.base, version: pin.version, copies: resolved.size, consumers: consumers.length, native: inventory.native };
}

/** Trusted build/probe configuration only; neither path is a serving request.
 * @param {string} policyFile @param {string} storageRoot */
export async function officialYamlPackage(policyFile, storageRoot) {
  const pin = securityYamlPin(policyFile);fs.mkdirSync(storageRoot, { recursive: true });
  const archive = path.join(storageRoot, 'js-yaml.tgz'), official = path.join(storageRoot, 'js-yaml');
  if (!fs.existsSync(archive)) {
    const bytes = await new Promise((resolve, reject) => {
      const request = https.get(`https://registry.npmjs.org/js-yaml/-/js-yaml-${pin.version}.tgz`, { signal: AbortSignal.timeout(30000) }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error('official registry response')); return; }
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length;if (size > MAX_ARCHIVE) request.destroy(new Error('archive bound'));else chunks.push(chunk); });
        response.on('error', reject);response.on('end', () => resolve(Buffer.concat(chunks)));
      });
      request.setTimeout(30000, () => request.destroy(new Error('registry timeout')));request.on('error', reject);
    });
    fs.writeFileSync(archive, bytes, { flag: 'wx', mode: 0o444 });
  }
  const extracted = fs.mkdtempSync(path.join(storageRoot, 'verified-'));fs.rmdirSync(extracted);
  extractVerifiedYamlPackage(archive, pin, extracted);
  if (fs.existsSync(official)) { if (packageBytes(official) !== packageBytes(extracted)) fail('cached official package drift');fs.rmSync(extracted, { recursive: true }); }
  else fs.renameSync(extracted, official);
  return { pin, official };
}

function assertKernelClosure(root, policy) {
  const native = yamlInstallation(root).native, kernels = native.filter(row => /^@deepseek-ai\/dsh(?:-|$)/.test(row[1]));
  if (new Set(kernels.map(row=>row[1])).size<100 || kernels.some(row=>row[2]!==policy.dsh.version)
    || !native.some(row=>row[1]==='@deepseek-ai/cordis'&&row[2]===policy.dsh.cordis)) fail('fixed kernel namespace mismatch');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2];if (process.argv.length !== 3 || !['global', 'verify'].includes(mode)) fail('usage: runtime-yaml-security.mjs global|verify');
  const policy = json(metadataFile);assertKernelClosure(globalRoot, policy);
  const { pin, official } = await officialYamlPackage(metadataFile, cacheRoot);
  if (mode === 'verify') assertKernelClosure(path.join(seedHome, 'profiles', profile, 'node_modules'), policy);
  const result = mode === 'global' ? patchYamlInstallation(globalRoot, official, pin)
    : [verifyYamlInstallation(globalRoot, official, pin), verifyYamlInstallation(path.join(seedHome, 'profiles', profile, 'node_modules'), official, pin)];
  if (mode === 'verify') {
    const oldSeal = json(path.join(seedHome, '.evimed-profile-seed.json'));
    const temporary = fs.mkdtempSync(path.join(cacheRoot, 'seal-check-'));
    try {
      fs.mkdirSync(path.join(temporary, 'profiles'));fs.symlinkSync(path.join(seedHome, 'profiles', profile), path.join(temporary, 'profiles', profile));
      const calculated = sealProfileSeed(temporary, profile);
      if (calculated.digest !== oldSeal.digest) fail('profile seal mismatch');
    } finally { fs.rmSync(temporary, { recursive: true }); }
  }
  console.log(JSON.stringify({ package: pin.name, version: pin.version, result }));
}
