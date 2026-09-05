/** Image-owned package reconciliation. Caller holds the project's exclusive flock. */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEAL = ".evimed-profile-seed.json";
const MARKER = ".evimed-seed.json";
const JOURNAL = ".evimed-seed-journal";
const STAGING = ".evimed-seed-staging";
const CLEANUP = ".evimed-seed-cleanup";
const PROFILE = /^[A-Za-z0-9_-]+$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = detail => { throw new Error(`profile_seed: ${detail}`); };
function stat(file) {
  try { return lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function directory(dir) {
  const info = stat(dir);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) fail("directory cannot be a symlink or non-directory");
  if (!info) mkdirSync(dir, { mode: 0o700 });
}
function profileDir(home, profile) {
  if (!PROFILE.test(profile)) fail("invalid profile name");
  directory(home);
  directory(path.join(home, "profiles"));
  const dir = path.join(home, "profiles", profile);
  directory(dir);
  return dir;
}
function syncDirectory(dir) {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeDurable(file, data) {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
function readObject(file) {
  const info = stat(file);
  if (!info?.isFile() || info.isSymbolicLink()) fail("metadata must be a regular file");
  let value;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { return fail("invalid metadata JSON"); }
  if (!record(value)) fail("metadata must be an object");
  return value;
}
function hashTree(root) {
  const hash = createHash("sha256");
  function visit(file, relative) {
    const info = lstatSync(file);
    if (info.isSymbolicLink()) { hash.update(JSON.stringify([relative, "link", readlinkSync(file)])); return; }
    if (info.isFile()) {
      hash.update(JSON.stringify([relative, "file", info.size])); hash.update(readFileSync(file)); return;
    }
    if (!info.isDirectory()) fail("unexpected seed file type");
    hash.update(JSON.stringify([relative, "directory"]));
    for (const name of readdirSync(file).sort()) visit(path.join(file, name), `${relative}/${name}`);
  }
  visit(root, "");
  return hash.digest("hex");
}
function fingerprint(file) {
  const info = stat(file);
  if (!info) return null;
  if (info.isSymbolicLink()) return `link:${readlinkSync(file)}`;
  if (info.isFile()) return `file:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  if (info.isDirectory()) return `directory:${hashTree(file)}`;
  return fail("unsupported migration entry");
}

/** Seal only immutable package/config inputs; home credentials and user patches are excluded. */
export function sealProfileSeed(seedHome, profile) {
  if (!PROFILE.test(profile)) fail("invalid profile name");
  const seed = path.resolve(seedHome);
  const dir = path.join(seed, "profiles", profile);
  const manifest = readObject(path.join(dir, "package.json"));
  const packages = Object.keys(manifest.dependencies ?? {}).sort();
  if (!packages.length || packages.some(name => !PACKAGE.test(name))) fail("invalid managed package list");
  const rootHash = createHash("sha256");
  for (const name of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "node_modules"]) {
    const file = path.join(dir, name);
    if (stat(file)) rootHash.update(JSON.stringify([name, hashTree(file)]));
  }
  for (const name of packages) {
    const pkg = readObject(path.join(realpathSync(path.join(dir, "node_modules", name)), "package.json"));
    if (pkg.name !== name) fail("managed package identity mismatch");
  }
  const seal = { version: 1, profile, digest: rootHash.digest("hex"), packages };
  const target = path.join(seed, SEAL);
  if (stat(target)?.isSymbolicLink()) fail("seed seal cannot be a symlink");
  writeFileSync(target, `${JSON.stringify(seal)}\n`, { mode: 0o644 });
  return seal;
}

function safeTarget(profile, relative) {
  const config = ["package.json", "pnpm-workspace.yaml", MARKER].includes(relative);
  if (!config && (!relative.startsWith("node_modules/") || !PACKAGE.test(relative.slice("node_modules/".length)))) fail("invalid journal target");
  const parts = relative.split("/");
  let current = profile;
  for (const part of parts.slice(0, -1)) { current = path.join(current, part); directory(current); }
  return path.join(profile, relative);
}
function discardScratch(profile, name) {
  const dir = path.join(profile, name);
  const info = stat(dir);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) fail("invalid migration scratch directory");
  rmSync(dir, { recursive: true }); syncDirectory(profile);
}
function finishJournal(profile) {
  discardScratch(profile, CLEANUP);
  renameSync(path.join(profile, JOURNAL), path.join(profile, CLEANUP));
  syncDirectory(profile);
  discardScratch(profile, CLEANUP);
}
function recover(profile, managedPackages) {
  const root = path.join(profile, JOURNAL);
  if (!stat(root)) return false;
  if (!stat(root).isDirectory() || stat(root).isSymbolicLink()) fail("invalid journal directory");
  for (const name of ["backup", "stage"]) {
    const info = stat(path.join(root, name));
    if (!info?.isDirectory() || info.isSymbolicLink()) fail("invalid journal directory");
  }
  let journal;
  try { journal = readObject(path.join(root, "journal.json")); } catch { return fail("invalid journal metadata"); }
  if (journal.version !== 1 || !Array.isArray(journal.operations) || journal.operations.length > 1000) fail("invalid journal schema");
  const seen = new Set();
  // Validate every backup/target before restoring any of them. Dirty journals
  // need operator attention; they must never become permission to erase data.
  for (const [index, operation] of journal.operations.entries()) {
    if (!record(operation) || typeof operation.target !== "string" || seen.has(operation.target)
      || ![null, "string"].includes(operation.before === null ? null : typeof operation.before)
      || typeof operation.after !== "string") fail("invalid journal operation");
    seen.add(operation.target);
    if (operation.target.startsWith("node_modules/") && !managedPackages.includes(operation.target.slice("node_modules/".length))) fail("unmanaged journal package");
    const target = safeTarget(profile, operation.target);
    const backup = path.join(root, "backup", String(index));
    const current = fingerprint(target);
    if (stat(backup)) {
      if (fingerprint(backup) !== operation.before || (current !== null && current !== operation.after)) fail("dirty journal target");
    } else if (current !== operation.before && !(operation.before === null && current === operation.after)) fail("dirty journal target");
  }
  for (const [index, operation] of [...journal.operations.entries()].reverse()) {
    const target = safeTarget(profile, operation.target);
    const backup = path.join(root, "backup", String(index));
    if (stat(backup)) { rmSync(target, { recursive: true, force: true }); renameSync(backup, target); }
    else if (operation.before === null) rmSync(target, { recursive: true, force: true });
    syncDirectory(path.dirname(target));
  }
  finishJournal(profile);
  return true;
}

/** Reconcile managed package roots only; all user files and package order survive. */
export function migrateProfileSeed(seedHome, targetHome, profile, { checkpoint = (_step) => {} } = {}) {
  const seed = path.resolve(seedHome);
  const home = path.resolve(targetHome);
  if (seed === home) fail("image seed and runtime home must differ");
  const seal = readObject(path.join(seed, SEAL));
  if (seal.version !== 1 || seal.profile !== profile || !/^[a-f0-9]{64}$/.test(seal.digest)
    || !Array.isArray(seal.packages) || !seal.packages.length || seal.packages.some(name => typeof name !== "string" || !PACKAGE.test(name))) fail("invalid seed seal");
  const source = path.join(seed, "profiles", profile);
  const desired = readObject(path.join(source, "package.json"));
  if (JSON.stringify(Object.keys(desired.dependencies ?? {}).sort()) !== JSON.stringify(seal.packages)) fail("seed package manifest mismatch");
  const dir = profileDir(home, profile);
  recover(dir, seal.packages);
  discardScratch(dir, STAGING);
  discardScratch(dir, CLEANUP);
  const original = stat(path.join(dir, "package.json")) ? readObject(path.join(dir, "package.json")) : desired;
  if (!record(original.dependencies ?? {}) || !record(original.dsh ?? {}) || !record(original.dsh?.profile ?? {})
    || !Array.isArray(original.dsh?.profile?.bundles ?? [])) fail("invalid profile manifest");
  const bundles = [...(original.dsh?.profile?.bundles ?? [])];
  for (const bundle of desired.dsh?.profile?.bundles ?? []) if (!bundles.includes(bundle)) bundles.push(bundle);
  const merged = { ...original, dependencies: { ...original.dependencies, ...desired.dependencies },
    dsh: { ...original.dsh, profile: { ...original.dsh?.profile, bundles } } };
  const markerPath = path.join(dir, MARKER);
  const marker = stat(markerPath) ? readObject(markerPath) : null;
  const links = seal.packages.map(name => ({ target: `node_modules/${name}`, link: path.join(source, "node_modules", name) }));
  for (const link of links) {
    const pkg = readObject(path.join(realpathSync(link.link), "package.json"));
    if (pkg.name !== link.target.slice("node_modules/".length)) fail("seed package identity mismatch");
    safeTarget(dir, link.target);
  }
  if (marker?.version === 1 && marker.digest === seal.digest
    && JSON.stringify(original) === JSON.stringify(merged)
    && links.every(link => fingerprint(safeTarget(dir, link.target)) === `link:${link.link}`)) return { changed: false, digest: seal.digest };
  let root = path.join(dir, STAGING);
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(path.join(root, "stage"), { mode: 0o700 });
  mkdirSync(path.join(root, "backup"), { mode: 0o700 });
  /** @type {Array<{target:string, link?:string, body?:string}>} */
  const entries = [...links, { target: "package.json", body: `${JSON.stringify(merged, null, 2)}\n` }];
  if (!stat(path.join(dir, "pnpm-workspace.yaml")) && stat(path.join(source, "pnpm-workspace.yaml"))) {
    entries.push({ target: "pnpm-workspace.yaml", body: readFileSync(path.join(source, "pnpm-workspace.yaml"), "utf8") });
  }
  entries.push({ target: MARKER, body: `${JSON.stringify({ version: 1, digest: seal.digest })}\n` });
  const operations = entries.map(entry => ({ target: entry.target, before: fingerprint(safeTarget(dir, entry.target)),
    after: entry.link ? `link:${entry.link}` : `file:${createHash("sha256").update(entry.body).digest("hex")}` }));
  writeDurable(path.join(root, "journal.json"), `${JSON.stringify({ version: 1, operations })}\n`);
  syncDirectory(root); syncDirectory(dir);
  for (const [index, entry] of entries.entries()) {
    const staged = path.join(root, "stage", String(index));
    if (entry.link) symlinkSync(entry.link, staged);
    else writeDurable(staged, entry.body);
  }
  syncDirectory(path.join(root, "stage")); checkpoint("prepared");
  renameSync(root, path.join(dir, JOURNAL)); syncDirectory(dir);
  root = path.join(dir, JOURNAL);
  checkpoint("staged");
  for (const [index, operation] of operations.entries()) {
    const target = safeTarget(dir, operation.target);
    if (fingerprint(target) !== operation.before) fail("dirty migration target");
    if (operation.before !== null) renameSync(target, path.join(root, "backup", String(index)));
    syncDirectory(path.dirname(target)); syncDirectory(path.join(root, "backup")); checkpoint(`backed-up:${index}`);
    renameSync(path.join(root, "stage", String(index)), target);
    syncDirectory(path.dirname(target)); checkpoint(`installed:${index}`);
  }
  finishJournal(dir);
  checkpoint("committed");
  return { changed: true, digest: seal.digest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, seed, homeOrProfile, profile] = process.argv.slice(2);
  try {
    if (mode === "seal") sealProfileSeed(seed, homeOrProfile);
    else if (mode === "sync") migrateProfileSeed(seed, homeOrProfile, profile);
    else fail("usage: seal <seed> <profile> | sync <seed> <home> <profile>");
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
