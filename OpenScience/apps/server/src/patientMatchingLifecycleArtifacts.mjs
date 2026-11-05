/** First-party code admission is deployment-owned and separate from the third-party tool bridge. */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { canonicalJson } from '@evimed/domain';
import { PINNED } from './pinnedVersions.mjs';
import { patientMatchingConfiguration } from './patientMatchingConfiguration.mjs';
import { HttpError, openScopedDirectoryNoFollow, openScopedFileNoFollow, readStableFileHandle, writeFileExclusiveNoFollow } from './security.mjs';

export const PATIENT_MATCHING_HOST_ABI = 'patient-matching.host.v1';
export const PATIENT_MATCHING_RUNTIME_ROOT = '/opt/evimed/patient-matching';
// Generated from the bundle's manifest; the server reads data without importing extension code.
export const PATIENT_MATCHING_TOOLS = Object.freeze(JSON.parse(readFileSync(new URL('../../../packages/domain/src/patientMatchingTools.json', import.meta.url), 'utf8')));
const HEX = /^[a-f0-9]{64}$/, DIGEST = /^sha256:[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const invalid = () => new HttpError(400, 'patient_matching_release_invalid', 'The protected patient matching release is invalid.');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** Caller supplied package coordinates, URLs, paths, tools or model profiles never enter this catalogue.
 * @param {any[]} entries */
export function patientMatchingCatalogue(entries) {
  if (!Array.isArray(entries)) throw invalid();
  const result = new Map();
  for (const original of entries) {
    const entry = structuredClone(original);
    if (!exact(entry, ['releaseId', 'packageName', 'packageVersion', 'artifactPath', 'artifactIntegrity', 'artifactDigest', 'workerImageDigest', 'hostAbi', 'dshVersion', 'modelProfile'])
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(entry.releaseId) || result.has(entry.releaseId)
      || entry.packageName !== '@evimed/dsh-patient-matching' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry.packageVersion)
      || !path.isAbsolute(entry.artifactPath) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.artifactIntegrity)
      || !DIGEST.test(entry.artifactDigest) || !DIGEST.test(entry.workerImageDigest)
      || entry.hostAbi !== PATIENT_MATCHING_HOST_ABI || entry.dshVersion !== PINNED.dsh.version
      || canonicalJson(entry.modelProfile) !== canonicalJson(patientMatchingConfiguration({}, {}))) throw invalid();
    result.set(entry.releaseId, Object.freeze(entry));
  }
  return result;
}

/** @param {any} project @param {any} reference */
export function validatePatientMatchingReference(project, reference) {
  if (!exact(reference, ['ownerHash', 'projectHash', 'generationHash']) || reference.ownerHash !== hash(project.userId)
    || reference.projectHash !== hash(project.id) || !HEX.test(reference.generationHash)) throw invalid();
  return { ...reference };
}
/** Only a verified opaque reference can select a host path. @param {any} config @param {any} reference */
export function patientMatchingGenerationRoot(config, reference) {
  if (!['ownerHash', 'projectHash', 'generationHash'].every(key => HEX.test(reference?.[key]))) throw invalid();
  return path.join(config.dataDir, '.openscience', 'patient-matching-generations', reference.ownerHash, reference.projectHash, reference.generationHash);
}
const identity = manifest => { const { reference: _reference, ...content } = manifest; return hash(canonicalJson(content)); };

/** Bounded decoding; no package scripts, package manager, customer files or provider calls.
 * Links, special files, duplicate names and traversal are refused before any write. @param {Buffer} bytes */
async function archiveFiles(bytes) {
  let decoded;
  try { decoded = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }); } catch { throw invalid(); }
  const extractor = tar.extract(), names = new Set(), files = [];
  let count = 0, total = 0;
  await new Promise((resolve, reject) => {
    extractor.on('error', reject); extractor.on('finish', resolve);
    extractor.on('entry', (header, stream, next) => {
      const name = header.name.replace(/\/$/, '');
      if (++count > 10000 || !name.startsWith('package/') && name !== 'package' || name.includes('\\') || name.includes('\0')
        || name.split('/').some(part => !part || part === '.' || part === '..') || names.has(name)
        || !['file', 'directory'].includes(header.type) || header.size > 16 * 1024 * 1024) { stream.resume(); extractor.destroy(invalid()); return; }
      names.add(name);
      const chunks = [];
      stream.on('data', chunk => { total += chunk.length; if (total > 128 * 1024 * 1024) extractor.destroy(invalid()); else chunks.push(chunk); });
      stream.on('error', reject);
      stream.on('end', () => { if (header.type === 'file') files.push({ name, bytes: Buffer.concat(chunks) }); next(); });
    });
    extractor.end(decoded);
  });
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Runs in the leased preparation worker only. The artifact is opened without following a link.
 * @param {any} config @param {any} project @param {any} scope @param {any} entry @param {string} runtimeImageDigest */
export async function preparePatientMatchingGeneration(config, project, scope, entry, runtimeImageDigest) {
  if (!DIGEST.test(runtimeImageDigest)) throw invalid();
  const artifact = await openScopedFileNoFollow(path.dirname(entry.artifactPath), entry.artifactPath);
  let bytes;
  try { if (artifact.stat.size > 32 * 1024 * 1024) throw invalid(); bytes = await readStableFileHandle(artifact.handle, artifact.stat); }
  finally { await artifact.handle.close(); }
  if (`sha256:${hash(bytes)}` !== entry.artifactDigest || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== entry.artifactIntegrity) throw invalid();
  const files = await archiveFiles(bytes), packageFile = files.find(file => file.name === 'package/package.json');
  let metadata; try { metadata = JSON.parse(packageFile?.bytes.toString() ?? ''); } catch { throw invalid(); }
  if (metadata.name !== entry.packageName || metadata.version !== entry.packageVersion || metadata.type !== 'module'
    || !['package/index.mjs', 'package/skills/patient-matching/SKILL.md', 'package/node_modules/@evimed/harness-port/package.json', 'package/node_modules/@evimed/patient-matching-core/package.json'].every(name => files.some(file => file.name === name))) throw invalid();
  const { artifactPath: _artifactPath, ...release } = entry;
  const content = { schemaVersion: 1, scope, release, runtimeImageDigest, tools: [...PATIENT_MATCHING_TOOLS], files: files.map(file => ({ name: file.name, digest: `sha256:${hash(file.bytes)}`, size: file.bytes.length })) };
  const reference = { ownerHash: hash(project.userId), projectHash: hash(project.id), generationHash: hash(canonicalJson(content)) };
  const manifest = { ...content, reference }, root = patientMatchingGenerationRoot(config, reference);
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  if (manifestBytes.length > 1024 * 1024) throw invalid();
  const generationDirectory = await openScopedDirectoryNoFollow(config.dataDir, root, { create: true }); await generationDirectory.handle.close();
  // Exclusive creates allow an identical interrupted preparation to resume. Existing bytes must agree exactly.
  for (const file of [...files.map(entryFile => ({ name: `selected/${entryFile.name}`, bytes: entryFile.bytes })), { name: 'manifest.json', bytes: manifestBytes }]) {
    try { await writeFileExclusiveNoFollow(config.dataDir, path.join(root, file.name), file.bytes, { mode: 0o444 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const current = await openScopedFileNoFollow(config.dataDir, path.join(root, file.name));
    try { if (!file.bytes.equals(await readStableFileHandle(current.handle, current.stat))) throw invalid(); await current.handle.chmod(file.name === 'manifest.json' ? 0o400 : 0o444); }
    finally { await current.handle.close(); }
  }
  // Only the mounted subtree is traversable by the runtime's unprivileged user.
  const seal = async directoryPath => {
    const directory = await openScopedDirectoryNoFollow(config.dataDir, directoryPath);
    try { await directory.handle.chmod(0o755); } finally { await directory.handle.close(); }
    for (const item of await fs.readdir(directoryPath, { withFileTypes: true })) if (item.isDirectory()) await seal(path.join(directoryPath, item.name));
  };
  await seal(path.join(root, 'selected'));
  return verifyPatientMatchingGeneration(config, project, reference);
}

/** Independent controller/API verification includes every code byte and rejects extra files. Catalogue removal
 * does not change a historical immutable manifest, but new admission still requires the protected catalogue.
 * @param {any} config @param {any} project @param {any} reference */
export async function verifyPatientMatchingGeneration(config, project, reference) {
  const checked = validatePatientMatchingReference(project, reference), root = patientMatchingGenerationRoot(config, checked);
  for (const directoryPath of [path.dirname(path.dirname(root)), path.dirname(root), root]) {
    const directory = await openScopedDirectoryNoFollow(config.dataDir, directoryPath);
    try { if ((directory.stat.mode & 0o7777) !== 0o700) throw invalid(); } finally { await directory.handle.close(); }
  }
  const file = await openScopedFileNoFollow(config.dataDir, path.join(root, 'manifest.json'));
  let bytes;
  try { if (file.stat.size > 1024 * 1024 || (file.stat.mode & 0o7777) !== 0o400) throw invalid(); bytes = await readStableFileHandle(file.handle, file.stat); }
  finally { await file.handle.close(); }
  let manifest; try { manifest = JSON.parse(bytes.toString()); } catch { throw invalid(); }
  if (manifest.schemaVersion !== 1 || canonicalJson(manifest.reference) !== canonicalJson(checked) || identity(manifest) !== checked.generationHash
    || bytes.toString() !== `${canonicalJson(manifest)}\n` || manifest.scope.ownerId !== project.userId || manifest.scope.projectId !== project.id
    || manifest.release.hostAbi !== PATIENT_MATCHING_HOST_ABI || manifest.release.dshVersion !== PINNED.dsh.version
    || canonicalJson(manifest.release.modelProfile) !== canonicalJson(patientMatchingConfiguration({}, {}))
    || canonicalJson(manifest.tools) !== canonicalJson(PATIENT_MATCHING_TOOLS) || !DIGEST.test(manifest.runtimeImageDigest)) throw invalid();
  const seen = [];
  const walk = async directoryPath => {
    const directory = await openScopedDirectoryNoFollow(config.dataDir, directoryPath);
    try { if ((directory.stat.mode & 0o7777) !== 0o755) throw invalid(); } finally { await directory.handle.close(); }
    for (const item of await fs.readdir(directoryPath, { withFileTypes: true })) {
      const target = path.join(directoryPath, item.name);
      if (item.isDirectory()) await walk(target);
      else if (item.isFile()) {
        const name = path.relative(path.join(root, 'selected'), target).split(path.sep).join('/'), expected = manifest.files.find(entry => entry.name === name);
        if (!expected) throw invalid();
        const current = await openScopedFileNoFollow(config.dataDir, target);
        try { if ((current.stat.mode & 0o7777) !== 0o444 || current.stat.size !== expected.size || `sha256:${hash(await readStableFileHandle(current.handle, current.stat))}` !== expected.digest) throw invalid(); }
        finally { await current.handle.close(); }
        seen.push(name);
      } else throw invalid();
    }
  };
  await walk(path.join(root, 'selected'));
  if (seen.length !== manifest.files.length || (await fs.readdir(root)).sort().join(',') !== 'manifest.json,selected') throw invalid();
  return manifest;
}
