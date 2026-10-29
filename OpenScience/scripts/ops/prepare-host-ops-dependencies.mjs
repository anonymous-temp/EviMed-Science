#!/usr/bin/env node
/** Prepare the zero-download workspace resolver needed by source-only host CLI releases. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function need(value) {
  if (!value) throw new Error('host_ops_dependency_invalid');
}
function metadata(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function directory(folder) {
  const info = fs.lstatSync(folder);
  need(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o022));
  need(fs.realpathSync(folder) === folder);
}
function regular(file) {
  const info = fs.lstatSync(file);
  need(info.isFile() && info.uid === process.getuid() && !(info.mode & 0o022));
  need(fs.realpathSync(file) === file);
  return info;
}
function resolverAt(base, domain) {
  const modules = path.join(base, 'node_modules'), scope = path.join(modules, '@evimed'), link = path.join(scope, 'domain');
  if (!metadata(modules)) return false;
  directory(modules);
  if (!metadata(scope)) return false;
  directory(scope);
  const info = metadata(link);
  if (!info) return false;
  need(info.isSymbolicLink() && info.uid === process.getuid() && fs.realpathSync(link) === domain);
  return true;
}

export function prepareHostOpsDependencies(sourceRoot) {
  need(typeof sourceRoot === 'string' && path.isAbsolute(sourceRoot) && path.resolve(sourceRoot) === sourceRoot);
  directory(sourceRoot);
  const packages = path.join(sourceRoot, 'packages'), domain = path.join(packages, 'domain');
  directory(packages); directory(domain);
  const packageFile = path.join(domain, 'package.json');
  need(regular(packageFile).size <= 1024**2);
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  need(manifest.name === '@evimed/domain' && manifest.type === 'module' && manifest.exports?.['.'] === './index.mjs');
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies', 'imports']) {
    need(manifest[key] == null || typeof manifest[key] === 'object' && Object.keys(manifest[key]).length === 0);
  }
  for (const target of Object.values(manifest.exports)) {
    need(typeof target === 'string' && target.startsWith('./') && !target.split('/').includes('..'));
    const file = path.resolve(domain, target);
    need(file.startsWith(domain + path.sep));
    regular(file);
  }
  const importers = ['internalProjects.mjs', 'security.mjs'].map(name => path.join(sourceRoot, 'apps/server/src', name));
  for (const importer of importers) {
    regular(importer);
    // A nearer workspace installation wins over root/node_modules. Refuse a
    // shadow before creating anything; valid pnpm links to this domain survive.
    for (let parent = path.dirname(importer); parent !== path.dirname(sourceRoot); parent = path.dirname(parent)) {
      directory(parent);
      resolverAt(parent, domain);
    }
  }
  const createdDirectories = [];
  for (const folder of [path.join(sourceRoot, 'node_modules'), path.join(sourceRoot, 'node_modules/@evimed')]) {
    if (!metadata(folder)) {
      fs.mkdirSync(folder, { mode: 0o755 });
      // Explicit permissions only for the directory this invocation created:
      // the operator's umask may be 077, while release ancestors stay private.
      fs.chmodSync(folder, 0o755);
      createdDirectories.push(folder);
    }
    directory(folder);
  }
  const link = path.join(sourceRoot, 'node_modules/@evimed/domain');
  const createdLink = !resolverAt(sourceRoot, domain);
  if (createdLink) fs.symlinkSync(path.relative(path.dirname(link), domain), link);
  resolverAt(sourceRoot, domain);
  for (const importer of importers) {
    const resolved = createRequire(importer).resolve('@evimed/domain');
    need(fs.realpathSync(resolved) === path.join(domain, 'index.mjs'));
  }
  return { sourceRoot, packageName: '@evimed/domain', dependencyLink: link, target: domain, createdLink, createdDirectories };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    need(process.argv.length === 4 && process.argv[2] === '--source-root');
    console.log(JSON.stringify(prepareHostOpsDependencies(process.argv[3])));
  } catch {
    console.error('host_ops_dependency_invalid');
    process.exitCode = 1;
  }
}
