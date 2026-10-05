#!/usr/bin/env node
// Inventory the customer files, then stream them through verified open descriptors.
//
//   backup-archive.mjs inventory ROOT MANIFEST [STRICT=true]
//   backup-archive.mjs ROOT MANIFEST OUTPUT [STRICT=false]
//
// One inventory for both modes (backup-data.sh used to carry a second one of
// its own, and every rule had to be written twice): strict opens, hashes and
// re-checks every entry; not strict records what lstat sees, and the writer
// opens each entry as it is when it gets to it.
//
// Strict is for a source nobody writes (a cutover capture with the writers
// stopped; the VCR data plane was one until its recovery set stopped asking the
// platform to stop, see `vcr-backup.mjs`): any entry that differs between the two
// passes refuses the capture. Not strict is for a live product, which is never
// quiescent, and is what the scheduler runs. A running specialist job rewrites
// its state file by rename on every heartbeat, the release receipt creates and
// removes a project, a run's ledger grows; the writer used to fail the whole
// archive on the first of them (`Backup source identity changed after
// inventory.`: three failures in eleven minutes on 2026-10-03, a day without a
// backup, readiness red). Now an entry that changed or went away is handled
// where it is and said so in the manifest's `changed` list (see
// `createArchive`); what could make the archive lie stays a refusal in both.
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { isInternalProject } from "../../apps/server/src/internalProjects.mjs";
import { openScopedDirectoryNoFollow, openScopedFileNoFollow } from "../../apps/server/src/security.mjs";

const arguments_ = process.argv.slice(2);
const inventoryMode = arguments_[0] === "inventory";
const [rootArgument, manifestPath, outputPath, strictArgument = "false"] = inventoryMode
  ? [arguments_[1], arguments_[2], undefined, arguments_[3] ?? "true"] : arguments_;
const root = path.resolve(rootArgument);
const strict = strictArgument === "true";
const octalMaximum = 0o77777777777;
// The reader in backup_integrity.py shares this bounded, versioned contract.
const integrityManifestName = ".open-science-backup-manifest.json";
const integrityManifestPrefix = '{"format":"open-science-backup-inventory","version":1,"entries":[';
const maximumManifestBytes = 64 * 1024 * 1024;
const maximumManifestEntries = 1_000_000;
// Linux caps a link's target at PATH_MAX; anything longer is not a link record.
const maximumLinkTargetBytes = 4096;
// backup-scheduler.mjs reads these lines into its state; keep them in step.
const linkNotePrefix = "backup note: workspace symbolic links recorded, not followed: ";
const omittedNotePrefix = "backup note: workspace entries left out of the archive: ";
const changedNotePrefix = "backup note: entries that changed or went away while the backup ran: ";
let outputCreated = false;

// A run may `ln -s` inside its own workspace, and twice one did (2026-09-26: a
// deliverable alias; 09-27: seventeen `.evimed-sources/<id>/fulltext.md`
// aliases). Refusing the whole data directory over them stopped every
// tenant's backup, and the next release switch left the site down behind the
// unhealthy backup container. So a link strictly below
// `users/*/projects/*/workspace` is recorded — its path and target text, in
// the archive's integrity manifest — and is never followed, never archived as
// a member and never restored as a link; whatever it names inside the tree is
// archived under its own name. Anywhere else (the data root, a user or project
// root, the workspace directory itself, the native session journals) a link
// is still refused: those are the paths a link could use to point the backup
// out of the tenant's tree.
//
// The same holds for everything else a run can make there that an archive
// cannot carry (2026-09-27, found sweeping the class): a FIFO, socket or
// device node; a file the backup may not read; a name that is not UTF-8; a
// file with a second name. Each is recorded in the manifest's `omitted` list
// and left out, instead of failing every tenant's backup; outside a workspace
// each is still refused (a socket there is still skipped, as it always was).
function isBelowWorkspace(parts) {
  return parts.length > 5 && parts[0] === "users" && parts[2] === "projects" && parts[4] === "workspace";
}

function workspaceOf(relative) {
  return relative.split("/").slice(0, 5).join("/");
}

const omittedKinds = new Set([
  "fifo", "socket", "character-device", "block-device", "unreadable", "hardlink", "hardlink-dropped", "non-utf8-name",
]);
// Kinds whose bytes are in the archive under no name at all. A `hardlink`
// record's bytes are archived under the name it is `of`; a special file has none.
const contentNotArchivedKinds = new Set(["unreadable", "hardlink-dropped", "non-utf8-name"]);
const unreadableCodes = new Set(["EACCES", "EPERM"]);

// What a live tree did under the backup, anywhere in the data directory (the
// `omitted` list above is what an archive cannot carry, and only below a
// workspace). A `changed-during-backup` entry IS an archived file: it was not
// the file the inventory saw (replaced, rewritten, re-permissioned) or it kept
// changing while it was read, so the archive holds the bytes the writer read
// and the manifest's digest is of those bytes, never the inventory's. A
// `vanished` entry is not in the archive at all: it was gone when the writer
// got to it, and so is everything below it. The restore verifies exactly what
// the manifest says was captured, and counts both. The reader's list of the two
// kinds is `CHANGED_KINDS` in backup_integrity.py.

/** An entry the walk could not find when it looked: not a failure on a live tree. */
const wentMissing = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";

function specialKind(metadata) {
  if (metadata.isFIFO()) return "fifo";
  if (metadata.isSocket()) return "socket";
  if (metadata.isCharacterDevice()) return "character-device";
  if (metadata.isBlockDevice()) return "block-device";
  return null;
}

async function linkTarget(full) {
  return (await readlink(full, { encoding: "buffer" })).toString("utf8");
}

const managedRuntimePrefix = ["users", null, "projects", null, "runtime", "container-runtime"];
const managedRuntimeIncludedTree = ["dsh-home", "sessions"];

function managedRuntimeDecision(parts) {
  const managed = parts.length >= managedRuntimePrefix.length
    && managedRuntimePrefix.every((part, index) => part === null || parts[index] === part);
  if (!managed) return { managed: false, included: true };
  const suffix = parts.slice(managedRuntimePrefix.length);
  const included = suffix.slice(0, managedRuntimeIncludedTree.length)
    .every((part, index) => managedRuntimeIncludedTree[index] === part);
  return { managed: true, included };
}

// The platform's own atomic writes, in the shapes this codebase makes them: the
// specialist adapter's and the MR queue's `.<name>.<16 hex>.tmp`, the control
// plane's `.<name>.<pid>.<ms>.tmp_<32 hex>` (`writeFileAtomicNoFollow`), and a
// `.<name>.<anything>.tmpdir` working directory. Each exists for the moments
// between a write and its rename, and a restored one is nobody's.
const inFlightTemporary = /^\..+\.(?:[0-9a-f]{16}\.tmp|\d+\.\d+\.tmp_[0-9a-f]{32}|[^/]+\.tmpdir)$/;

const vcrPartialFile = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;

/** Paths the backup never looks at, decided from the path alone.
 *
 *  Volatile control state is excluded by rule, so it can never fail a backup:
 *  - runtime control sockets (`.runtime-sockets`, `*.sock`);
 *  - the specialist slot directory (`.openscience/specialist-slots`): `flock`
 *    files that exist while a job holds or waits for a slot and are deleted
 *    with it, created and removed on every job on every engine container;
 *  - in-flight temporaries of the platform's own atomic writes (above);
 *  - the VCR data plane's own scratch, which that tree is also archived while the
 *    platform runs (`vcr-backup.mjs`): a record's conversion copy under
 *    `studies/<study>/.intake/` (removed after each attempt, patient-level bytes
 *    nothing restores) and a file mid-write, `<name>.<uuid>.part`, which is
 *    renamed to its final name or removed (`vcrDataPlane.mjs`
 *    `writeContentAddressed` and the identity map). A restored copy of either is
 *    nobody's.
 *  Only outside a workspace: there a name is ours. Inside one it is the
 *  tenant's to choose, so nothing is excluded by name and the entry's type
 *  decides; one that is gone by the time the writer gets to it is recorded as
 *  vanished like any other. */
function excludedFromBackup(parts) {
  // The platform's own background projects (learning, document
  // understanding, the paired evaluation's cells) are scratch: what they
  // produce is kept in the product database, and the store rebuilds their
  // trees on first use. Their files change whenever that work is running —
  // most of the time once it runs around the clock — and one changed file
  // failed the whole strict backup (2026-09-21, every cycle for hours).
  if (parts.length === 4 && parts[0] === "users" && parts[2] === "projects" && isInternalProject(parts[3])) return true;
  if (!managedRuntimeDecision(parts).included) return true;
  if (parts[0] === ".openscience" && parts[1] === "specialist-slots") return true;
  const name = parts.at(-1) ?? "";
  if (parts[0] === "studies" && (parts[2] === ".intake" || vcrPartialFile.test(name))) return true;
  return !isBelowWorkspace(parts)
    && (name === ".runtime-sockets" || name.endsWith(".sock") || inFlightTemporary.test(name));
}

function metadataFields(metadata) {
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    size: String(metadata.size),
    mtimeNs: String(metadata.mtimeNs),
    ctimeNs: String(metadata.ctimeNs),
    mode: String(metadata.mode),
    uid: String(metadata.uid),
    gid: String(metadata.gid),
    nlink: String(metadata.nlink),
  };
}

function completeIdentityMatches(metadata, entry) {
  const fields = metadataFields(metadata);
  return Object.entries(fields).every(([key, value]) => entry[key] === value);
}

async function digestHandle(handle, size) {
  const digest = createHash("sha256");
  let read = 0;
  if (size > 0) {
    for await (const chunk of handle.createReadStream({ start: 0, end: size - 1, autoClose: false })) {
      read += chunk.length;
      digest.update(chunk);
    }
  }
  if (read !== size) throw new Error("Backup source changed during its bounded read.");
  return digest.digest("hex");
}

async function createInventory() {
  const entries = [];
  const omitted = [];
  // Hard-linked files below a workspace, by inode, until the walk is over:
  // only then is it known whether every name the inode has was walked.
  const hardLinked = new Map();
  const omit = (record) => {
    omitted.push(record);
    return false;
  };
  // Below a workspace a read the tenant's own permissions refuse is recorded;
  // anywhere else it fails the backup, as it always did.
  const unreadable = (parts, relative, error) => {
    if (isBelowWorkspace(parts) && unreadableCodes.has(error?.code)) return omit({ path: relative, kind: "unreadable" });
    throw error;
  };

  async function childNames(full, parts, relative) {
    const names = [];
    // As bytes: a name that is not UTF-8 decodes to one that does not exist,
    // and the lstat of that decoded name failed the whole backup.
    for (const raw of await readdir(full, { encoding: "buffer" })) {
      const name = raw.toString("utf8");
      if (Buffer.from(name, "utf8").equals(raw)) {
        names.push(name);
        continue;
      }
      const childParts = [...parts, name];
      if (excludedFromBackup(childParts)) continue;
      if (!isBelowWorkspace(childParts)) {
        throw new Error(`Refusing to back up a data entry whose name is not UTF-8: ${full}/<${raw.toString("hex")}>`);
      }
      omit({ parent: relative, kind: "non-utf8-name", nameHex: raw.toString("hex") });
    }
    return names.sort();
  }

  async function inventoryFile({ relative, parts, full, metadata }, hardLinks = null) {
    const linked = hardLinks ? { hardLinks } : {};
    if (!strict) {
      // The writer opens it. Below a workspace, whether it can is asked now so
      // an unreadable file is a record; anywhere else the writer's own open
      // still fails the backup (exit 2, with the permission diagnostic).
      if (isBelowWorkspace(parts)) {
        try {
          await access(full, fsConstants.R_OK);
        } catch (error) {
          // Gone since the walk listed it: nothing to carry, and not a failure.
          if (wentMissing(error)) return false;
          return unreadable(parts, relative, error);
        }
      }
      entries.push({ path: relative, type: "file", ...metadataFields(metadata), ...linked });
      return true;
    }
    let opened;
    try {
      opened = await openScopedFileNoFollow(root, full, { allowHardLinks: Boolean(hardLinks) });
    } catch (error) {
      return unreadable(parts, relative, error);
    }
    try {
      const before = await opened.handle.stat({ bigint: true });
      const size = Number(before.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Backup source is too large for an exact size.");
      const sha256 = await digestHandle(opened.handle, size);
      const after = await opened.handle.stat({ bigint: true });
      if (!completeIdentityMatches(after, { ...metadataFields(before) })
        || (hardLinks && String(before.nlink) !== hardLinks)) {
        throw new Error("Backup source identity changed during inventory.");
      }
      entries.push({ path: relative, type: "file", ...metadataFields(before), sha256, ...linked });
      return true;
    } finally {
      await opened.handle.close();
    }
  }

  async function collect(relative) {
    if (relative === integrityManifestName) throw new Error("Refusing a reserved backup manifest path in customer data.");
    const parts = relative ? relative.split("/") : [];
    if (excludedFromBackup(parts)) return false;
    const decision = managedRuntimeDecision(parts);
    const below = isBelowWorkspace(parts);
    const full = path.join(root, relative);
    // Not strict, a name the walk listed and that is gone when it is looked at
    // is the live tree changing under the walk: it is not part of the inventory,
    // and strict (a source nobody writes) still says so.
    const gone = (error) => !strict && wentMissing(error);
    let pathMetadata;
    try {
      pathMetadata = await lstat(full, { bigint: true });
    } catch (error) {
      if (gone(error)) return false;
      return unreadable(parts, relative, error);
    }
    if (pathMetadata.isSymbolicLink()) {
      if (!below) throw new Error(`Refusing to back up data directory containing symbolic links: ${full}`);
      let target;
      try {
        target = await linkTarget(full);
      } catch (error) {
        // Removed, or replaced by something that is not a link, since the lstat.
        if (gone(error) || (!strict && error?.code === "EINVAL")) return false;
        throw error;
      }
      entries.push({ path: relative, type: "link", ...metadataFields(pathMetadata), target });
      return true;
    }
    const special = specialKind(pathMetadata);
    if (special) {
      if (below) return omit({ path: relative, kind: special });
      if (special === "socket") return false;
      throw new Error(`Refusing to back up a non-file data entry: ${full}`);
    }
    if (pathMetadata.isDirectory()) {
      let opened = null;
      try {
        let before = pathMetadata;
        let names;
        try {
          if (strict) {
            opened = await openScopedDirectoryNoFollow(root, full);
            before = await opened.handle.stat({ bigint: true });
          }
          names = await childNames(full, parts, relative);
        } catch (error) {
          if (gone(error)) return false;
          return unreadable(parts, relative, error);
        }
        let retained = false;
        for (const child of names) {
          if (await collect(relative ? `${relative}/${child}` : child)) retained = true;
        }
        if (opened) {
          const after = await opened.handle.stat({ bigint: true });
          if (!completeIdentityMatches(after, { ...metadataFields(before) })) {
            throw new Error("Backup source identity changed during inventory.");
          }
        }
        if (decision.managed && parts.length < managedRuntimePrefix.length + managedRuntimeIncludedTree.length && !retained) {
          return false;
        }
        entries.push({ path: relative || ".", type: "directory", ...metadataFields(before) });
        return true;
      } finally {
        await opened?.handle.close();
      }
    }
    if (!pathMetadata.isFile()) throw new Error(`Refusing to back up a non-file data entry: ${full}`);
    const file = { relative, parts, full, metadata: pathMetadata };
    if (pathMetadata.nlink > 1n) {
      if (!below) throw new Error(`Refusing to back up a hard-linked data file outside a workspace: ${full}`);
      const key = `${pathMetadata.dev}:${pathMetadata.ino}`;
      hardLinked.set(key, [...(hardLinked.get(key) ?? []), file]);
      return true;
    }
    return inventoryFile(file);
  }

  await collect("");
  // A hard-linked file is archived once, under the first of its names, when
  // every name the inode has was walked in one workspace: then its bytes are
  // that workspace's and nobody else's, and its other names are recorded as
  // aliases of the first. A name the walk did not reach may be anywhere on
  // the volume — another tenant's tree, the runtime's package cache — so such
  // an inode is not archived at all, and each of its names here says so.
  for (const names of hardLinked.values()) {
    const [first, ...others] = names;
    const contained = names.every(({ metadata }) => metadata.nlink === BigInt(names.length))
      && new Set(names.map(({ relative }) => workspaceOf(relative))).size === 1;
    const archived = contained && await inventoryFile(first, String(first.metadata.nlink));
    if (!contained) omit({ path: first.relative, kind: "hardlink-dropped" });
    for (const other of others) {
      omit(archived ? { path: other.relative, kind: "hardlink", of: first.relative } : { path: other.relative, kind: "hardlink-dropped" });
    }
  }
  await writeFile(manifestPath, JSON.stringify({ entries, omitted }), { mode: 0o600 });
}

function validPathParts(value) {
  const text = typeof value === "string" ? value : "";
  const parts = text.split("/");
  if (!text || text.includes("\0") || path.isAbsolute(text)
    || (text !== "." && parts.some(part => !part || part === "." || part === ".."))) {
    throw new Error("Invalid backup inventory entry.");
  }
  if (parts[0] === integrityManifestName) throw new Error("Refusing a reserved backup manifest path in customer data.");
  return parts;
}

function validateEntry(entry) {
  if (!entry || !["file", "directory", "link"].includes(entry.type)
    || ![entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.mode, entry.uid, entry.gid]
      .every(value => typeof value === "string" && /^\d+$/.test(value))) {
    throw new Error("Invalid backup inventory entry.");
  }
  const parts = validPathParts(entry.path);
  if (entry.type === "link" && (!isBelowWorkspace(parts) || typeof entry.target !== "string" || !entry.target
    || entry.target.includes("\0") || Buffer.byteLength(entry.target) > maximumLinkTargetBytes)) {
    throw new Error("Invalid backup inventory link entry.");
  }
  if (entry.hardLinks !== undefined && (entry.type !== "file" || !isBelowWorkspace(parts)
    || typeof entry.hardLinks !== "string" || !/^\d+$/.test(entry.hardLinks) || BigInt(entry.hardLinks) < 2n)) {
    throw new Error("Invalid backup inventory entry.");
  }
  if (strict && (!(typeof entry.ctimeNs === "string" && /^\d+$/.test(entry.ctimeNs))
    || !(typeof entry.nlink === "string" && /^\d+$/.test(entry.nlink))
    || (entry.type === "file" && !(typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256))))) {
    throw new Error("Invalid strict backup inventory entry.");
  }
}

function validateOmitted(record) {
  if (!record || !omittedKinds.has(record.kind)) throw new Error("Invalid backup inventory record.");
  if (record.kind === "non-utf8-name") {
    const parts = validPathParts(record.parent);
    if (!isBelowWorkspace([...parts, "-"]) || typeof record.nameHex !== "string"
      || !/^(?:[0-9a-f]{2}){1,255}$/.test(record.nameHex)) {
      throw new Error("Invalid backup inventory record.");
    }
    return;
  }
  const parts = validPathParts(record.path);
  if (!isBelowWorkspace(parts) || (record.kind === "hardlink"
    && (typeof record.of !== "string" || workspaceOf(record.of) !== workspaceOf(record.path)))) {
    throw new Error("Invalid backup inventory record.");
  }
}

function recordKey(record) {
  return record.kind === "non-utf8-name" ? `${record.parent}/\u0000${record.nameHex}` : record.path;
}

function recordLabel(record) {
  return record.kind === "non-utf8-name" ? `${record.parent}/<non-utf8 ${record.nameHex}>` : record.path;
}

/** Whether a recorded link is still the link the inventory read. It is never
 *  opened: lstat and readlink describe the link itself, not what it names. */
async function linkUnchanged(entry) {
  const full = path.join(root, entry.path);
  const metadata = await lstat(full, { bigint: true }).catch((error) => {
    if (wentMissing(error)) return null;
    throw error;
  });
  if (!metadata?.isSymbolicLink() || String(metadata.dev) !== entry.dev || String(metadata.ino) !== entry.ino) return false;
  const target = await linkTarget(full).catch((error) => {
    if (wentMissing(error) || error?.code === "EINVAL") return null;
    throw error;
  });
  return target === entry.target;
}

// What a failed open says about the name, as opposed to the file: `ENOENT`, and
// the refusals of a name that is not what the walk saw (a link or a file where
// a directory is, `ENOTDIR`/`ELOOP` raw and as security.mjs words them, and a
// directory or special file where a file is).
const nameConflictCodes = new Set(["ENOTDIR", "ELOOP", "path_forbidden", "not_a_file"]);

/** What `relative` is right now, by lstat alone and without following anything:
 *  "gone", "link", "directory", "file" or "special". */
async function lookNow(relative) {
  let metadata = await lstat(root, { bigint: true });
  let current = root;
  for (const part of relative === "." ? [] : relative.split("/")) {
    if (metadata.isSymbolicLink()) return "link";
    if (!metadata.isDirectory()) return "gone"; // nothing is below a file
    current = path.join(current, part);
    try {
      metadata = await lstat(current, { bigint: true });
    } catch (error) {
      if (wentMissing(error)) return "gone";
      throw error;
    }
  }
  if (metadata.isSymbolicLink()) return "link";
  return metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "special";
}

/** Whether an entry that could not be opened as what the inventory saw is simply
 *  no longer there: removed, or replaced by a directory where there was a file
 *  or a file where there was a directory. A link in its place, a special file,
 *  a second name for a file and a path that escapes are not: they are what the
 *  no-follow open exists to refuse, and they stay refusals. */
async function wentAway(entry, error) {
  if (error?.code === "ENOENT") return true;
  if (!nameConflictCodes.has(error?.code)) return false;
  const now = await lookNow(entry.path);
  return now === "gone" || (entry.type === "directory" ? now === "file" : now === "directory");
}

/** The entry opened through verified descriptors, or null when it is gone (not
 *  strict only: a source nobody writes has no entry that goes away). Not strict,
 *  a file or directory that is not the inode, size, time or permission the
 *  inventory recorded is opened as it is now: the header and the bytes both
 *  come from the descriptor, so the archive never describes one file with
 *  another's bytes. What is still refused, in both modes: another filesystem
 *  under the same name, a name the inventory did not count on a hard-linked
 *  file, a type that changed under the open. */
async function openEntry(entry) {
  const full = path.join(root, entry.path);
  let opened;
  try {
    opened = entry.type === "directory"
      ? await openScopedDirectoryNoFollow(root, full)
      : await openScopedFileNoFollow(root, full, { allowHardLinks: entry.hardLinks !== undefined });
  } catch (error) {
    if (!strict && entry.path !== "." && await wentAway(entry, error)) return null;
    throw error;
  }
  try {
    const metadata = await opened.handle.stat({ bigint: true });
    const identityChanged = strict
      ? !completeIdentityMatches(metadata, entry) || (entry.hardLinks !== undefined && String(metadata.nlink) !== entry.hardLinks)
      : String(metadata.dev) !== entry.dev || (entry.hardLinks !== undefined && metadata.nlink > BigInt(entry.hardLinks));
    if (identityChanged || (entry.type === "directory" ? !metadata.isDirectory() : !metadata.isFile())) {
      throw new Error("Backup source identity changed after inventory.");
    }
    return { handle: opened.handle, metadata };
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}

/** Whether the file in hand is not the one the inventory saw. */
function differsFromInventory(metadata, entry) {
  return ["ino", "size", "mtimeNs", "mode", "uid", "gid"].some((key) => String(metadata[key]) !== entry[key]);
}

function stringField(header, offset, length, value) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length > length) throw new Error("Backup tar header field overflow.");
  bytes.copy(header, offset);
}

function octalField(header, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid backup tar metadata.");
  stringField(header, offset, length - 1, value.toString(8).padStart(length - 1, "0"));
}

function tarHeader(name, { gid = 0, mode = 0o600, mtime = 0, size = 0, type = "0", uid = 0 }) {
  const header = Buffer.alloc(512);
  stringField(header, 0, 100, name);
  octalField(header, 100, 8, mode);
  octalField(header, 108, 8, uid);
  octalField(header, 116, 8, gid);
  octalField(header, 124, 12, size);
  octalField(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  stringField(header, 257, 6, "ustar");
  stringField(header, 263, 2, "00");
  stringField(header, 148, 6, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"));
  header[155] = 0x20;
  return header;
}

function padding(size) { return Buffer.alloc((512 - (size % 512)) % 512); }

// POSIX extended headers preserve valid deep paths and Unicode names beyond
// USTAR's 100-byte name field without truncating customer paths.
function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 2;
  while (length !== Buffer.byteLength(`${length} ${body}`)) length = Buffer.byteLength(`${length} ${body}`);
  return Buffer.from(`${length} ${body}`, "utf8");
}

function* headers(entry, metadata, index) {
  const name = entry.type === "directory" && entry.path !== "." ? `${entry.path}/` : entry.path;
  const size = entry.type === "file" ? Number(metadata.size) : 0;
  const mtime = Number(metadata.mtimeNs / 1_000_000_000n);
  const uid = Number(metadata.uid);
  const gid = Number(metadata.gid);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Backup source is too large for an exact size.");
  if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid backup owner metadata.");
  const extended = [];
  if (Buffer.byteLength(name) > 100) extended.push(paxRecord("path", name));
  if (size > octalMaximum) extended.push(paxRecord("size", size));
  if (mtime < 0 || mtime > octalMaximum) extended.push(paxRecord("mtime", mtime));
  if (uid > 0o7777777) extended.push(paxRecord("uid", uid));
  if (gid > 0o7777777) extended.push(paxRecord("gid", gid));
  if (extended.length) {
    const data = Buffer.concat(extended);
    yield tarHeader(`PaxHeaders/${index}`, { size: data.length, type: "x" });
    yield data;
    yield padding(data.length);
  }
  yield tarHeader(Buffer.byteLength(name) <= 100 ? name : `entry-${index}`, {
    gid: gid <= 0o7777777 ? gid : 0, mode: Number(metadata.mode & 0o7777n),
    mtime: mtime >= 0 && mtime <= octalMaximum ? mtime : 0,
    size: size <= octalMaximum ? size : 0, type: entry.type === "directory" ? "5" : "0",
    uid: uid <= 0o7777777 ? uid : 0,
  });
}

async function createArchive() {
  const inventory = JSON.parse(await readFile(manifestPath, "utf8"));
  const entries = inventory?.entries;
  const omittedRecords = inventory?.omitted;
  if (!Array.isArray(entries) || !Array.isArray(omittedRecords)) throw new Error("Invalid backup inventory.");
  if (!entries.length) throw new Error("Backup inventory is empty.");
  entries.forEach(validateEntry);
  omittedRecords.forEach(validateOmitted);
  const rootEntry = entries.find(entry => entry.path === "." && entry.type === "directory");
  const keys = [...entries.map(entry => entry.path), ...omittedRecords.map(recordKey)];
  if (!rootEntry || keys.length > maximumManifestEntries || new Set(keys).size !== keys.length) {
    throw new Error("Invalid or oversized backup inventory.");
  }
  const archivedEntries = [];
  const archivedFiles = new Set();
  let manifestBytes = Buffer.byteLength(integrityManifestPrefix) + 2;
  const recordArchived = (entry) => {
    const serialized = JSON.stringify(entry);
    manifestBytes += Buffer.byteLength(serialized) + (archivedEntries.length ? 1 : 0);
    if (manifestBytes > maximumManifestBytes) throw new Error("Backup integrity manifest exceeds its size limit.");
    archivedEntries.push(serialized);
    if (entry.type === "file") archivedFiles.add(entry.path);
  };
  const recordedLinks = [];
  const recordLink = (entry) => {
    const serialized = JSON.stringify({ path: entry.path, target: entry.target });
    manifestBytes += Buffer.byteLength(serialized) + (recordedLinks.length ? 1 : Buffer.byteLength(',"links":[]'));
    if (manifestBytes > maximumManifestBytes) throw new Error("Backup integrity manifest exceeds its size limit.");
    recordedLinks.push({ path: entry.path, serialized });
  };
  // The inventory's records, plus files that became unreadable after it.
  const demoted = [];
  let records = [];
  let changedRecords = [];
  const directories = entries.filter(entry => entry.type === "directory");

  // What a live tree did while the archive was written (not strict).
  //  - gone: entries that were not there when the writer reached them.
  //  - changedFiles: archived files that were not the file the inventory saw,
  //    or kept changing as they were read.
  //  - archivedBelow: every directory that has an archived member beneath it.
  const gone = new Set();
  const changedFiles = [];
  const archivedBelow = new Set();
  const markArchived = (relative) => {
    for (let at = relative.lastIndexOf("/"); at > 0; at = relative.lastIndexOf("/", at - 1)) {
      const parent = relative.slice(0, at);
      if (archivedBelow.has(parent)) break; // its own parents were marked with it
      archivedBelow.add(parent);
    }
  };
  /** Whether a directory above `relative` (or `relative` itself, with `self`) is gone. */
  const withinGone = (relative, self = false) => {
    if (self && gone.has(relative)) return true;
    for (let at = relative.lastIndexOf("/"); at > 0; at = relative.lastIndexOf("/", at - 1)) {
      if (gone.has(relative.slice(0, at))) return true;
    }
    return false;
  };

  // Opens every directory the inventory listed. A link in place of one, or any
  // other substitution that is not just the live tree, fails here, before a
  // byte is written; a directory that is gone or was replaced by another is
  // the live tree and is dealt with when its turn comes. Strict: all of it.
  const verifyEntries = async (items) => {
    for (const entry of items) {
      if (entry.type === "link") {
        if (!(await linkUnchanged(entry))) throw new Error("Backup source identity changed after inventory.");
        continue;
      }
      const opened = await openEntry(entry);
      await opened?.handle.close();
    }
  };
  let changed = 0;
  async function* chunks() {
    await verifyEntries(directories);
    for (const [index, entry] of entries.entries()) {
      // Recorded in the manifest, never a tar member: the archive carries no
      // link for a restore to create, and nothing here reads what it names.
      if (entry.type === "link") {
        if (!(await linkUnchanged(entry))) changed++;
        recordLink(entry);
        continue;
      }
      let opened;
      try {
        opened = await openEntry(entry);
      } catch (error) {
        // Readable when inventoried and refused now: the tenant changed its
        // own permissions under the backup. Recorded, and a changed source.
        if (entry.type === "file" && isBelowWorkspace(entry.path.split("/")) && unreadableCodes.has(error?.code)) {
          changed++;
          demoted.push({ path: entry.path, kind: "unreadable" });
          continue;
        }
        throw error;
      }
      if (opened === null) {
        gone.add(entry.path);
        continue;
      }
      const { handle, metadata } = opened;
      try {
        yield* headers(entry, metadata, index);
        if (entry.type === "directory") {
          recordArchived({ path: entry.path, type: "directory", size: 0 });
          markArchived(entry.path);
          continue;
        }
        const size = Number(metadata.size);
        let written = 0;
        const contentDigest = createHash("sha256");
        if (size > 0) {
          for await (const chunk of handle.createReadStream({ start: 0, end: size - 1, autoClose: false })) {
            written += chunk.length;
            contentDigest.update(chunk);
            yield chunk;
          }
        }
        // A file that shrank under the read: the header has declared `size`
        // and the first bytes are on the stream, so, as GNU tar does, the
        // member is padded to the size it declared. The digest covers the
        // padding, and the manifest lists the file as changed. Strict refuses.
        let shrank = false;
        if (written !== size) {
          if (strict) throw new Error("Backup source changed during its bounded read.");
          shrank = true;
          for (let missing = size - written; missing > 0;) {
            const zeros = Buffer.alloc(Math.min(missing, 1024 * 1024));
            contentDigest.update(zeros);
            yield zeros;
            missing -= zeros.length;
          }
        }
        const sha256 = contentDigest.digest("hex");
        const after = await handle.stat({ bigint: true });
        // A name added while it was read may be anywhere on the volume.
        if (after.nlink > BigInt(entry.hardLinks ?? 1)) throw new Error("Backup source became hard-linked while being read.");
        if (shrank || differsFromInventory(metadata, entry)
          || after.size !== metadata.size || after.mtimeNs !== metadata.mtimeNs || after.nlink === 0n
          || (strict && (sha256 !== entry.sha256 || !completeIdentityMatches(after, entry)))) {
          changed++;
          changedFiles.push(entry.path);
        }
        recordArchived({ path: entry.path, type: "file", size, sha256 });
        markArchived(entry.path);
        yield padding(size);
      } finally {
        await handle.close();
      }
    }
    // No archive is accepted after a directory substitution, even if a file
    // descriptor safely retained the original bytes while its name moved.
    const demotedPaths = new Set(demoted.map(record => record.path));
    await verifyEntries(strict ? entries.filter(entry => !demotedPaths.has(entry.path)) : directories);
    // A directory that is gone but has archived members beneath it is still a
    // member of the archive, as the inventory recorded it: its children cannot
    // be restored into nothing, and the manifest must name every parent. What
    // is gone with nothing archived beneath it is not archived at all.
    for (const [index, entry] of entries.entries()) {
      if (entry.type !== "directory" || !gone.has(entry.path) || !archivedBelow.has(entry.path)) continue;
      gone.delete(entry.path);
      yield* headers(entry, {
        size: 0n, mtimeNs: BigInt(entry.mtimeNs), uid: BigInt(entry.uid), gid: BigInt(entry.gid), mode: BigInt(entry.mode),
      }, index);
      recordArchived({ path: entry.path, type: "directory", size: 0 });
    }
    // Everything below a directory that is gone went with it, and is said once,
    // by the directory: the links and left-out records beneath it, and the
    // entries that were missing one by one.
    const kept = (record) => !withinGone(record.kind === "non-utf8-name" ? record.parent : record.path, record.kind === "non-utf8-name");
    for (const link of recordedLinks.splice(0)) if (!withinGone(link.path)) recordedLinks.push(link);
    // An alias whose first name was not archived after all has no bytes here.
    records = [...omittedRecords.map(record => (record.kind === "hardlink" && !archivedFiles.has(record.of)
      ? { path: record.path, kind: "hardlink-dropped" } : record)), ...demoted].filter(kept);
    const omitted = records.map(record => JSON.stringify(record));
    manifestBytes += omitted.length ? Buffer.byteLength(`,"omitted":[${omitted.join(",")}]`) : 0;
    changedRecords = [
      ...changedFiles.map(file => ({ path: file, kind: "changed-during-backup" })),
      ...[...gone].filter(file => !withinGone(file)).sort().map(file => ({ path: file, kind: "vanished" })),
    ];
    const changedList = changedRecords.map(record => JSON.stringify(record));
    manifestBytes += changedList.length ? Buffer.byteLength(`,"changed":[${changedList.join(",")}]`) : 0;
    if (manifestBytes > maximumManifestBytes) throw new Error("Backup integrity manifest exceeds its size limit.");
    // Each list only when it has members, so an archive without any is
    // byte-for-byte the format every earlier reader already verifies.
    const links = recordedLinks.length ? `,"links":[${recordedLinks.map(link => link.serialized).join(",")}]` : "";
    const omittedList = omitted.length ? `,"omitted":[${omitted.join(",")}]` : "";
    const changedJson = changedList.length ? `,"changed":[${changedList.join(",")}]` : "";
    const integrityManifest = Buffer.from(`${integrityManifestPrefix}${archivedEntries.join(",")}]${links}${omittedList}${changedJson}}`, "utf8");
    yield* headers({ path: integrityManifestName, type: "file" }, {
      size: BigInt(integrityManifest.length), mode: 0o600n, mtimeNs: 0n,
      uid: BigInt(rootEntry.uid), gid: BigInt(rootEntry.gid),
    }, entries.length);
    yield integrityManifest;
    yield padding(integrityManifest.length);
    yield Buffer.alloc(1024);
  }
  const output = await open(outputPath, "wx", 0o600);
  outputCreated = true;
  try {
    await pipeline(Readable.from(chunks()), createGzip(), output.createWriteStream());
  } finally {
    await output.close();
  }
  for (let index = 0; index < changed; index++) process.stderr.write("backup archive: file changed as we read it\n");
  // One bounded line each, however many: how many, and the first few by name.
  if (recordedLinks.length) {
    const note = { count: recordedLinks.length, paths: recordedLinks.slice(0, 5).map(link => link.path) };
    process.stderr.write(`${linkNotePrefix}${JSON.stringify(note)}\n`);
  }
  if (records.length) {
    const kinds = {};
    for (const record of records) kinds[record.kind] = (kinds[record.kind] ?? 0) + 1;
    const note = {
      count: records.length,
      kinds,
      // Said outright: these are entries whose bytes this archive does not hold.
      contentNotArchived: records.filter(record => contentNotArchivedKinds.has(record.kind)).length,
      paths: records.slice(0, 5).map(recordLabel),
    };
    process.stderr.write(`${omittedNotePrefix}${JSON.stringify(note)}\n`);
  }
  if (changedRecords.length) {
    const kinds = {};
    for (const record of changedRecords) kinds[record.kind] = (kinds[record.kind] ?? 0) + 1;
    const note = { count: changedRecords.length, kinds, paths: changedRecords.slice(0, 5).map(record => record.path) };
    process.stderr.write(`${changedNotePrefix}${JSON.stringify(note)}\n`);
  }
  process.exitCode = changed ? 1 : 0;
}

const operation = inventoryMode ? createInventory() : createArchive();
operation.catch(async (error) => {
  if (outputCreated) await rm(outputPath, { force: true }).catch(() => {});
  process.stderr.write(`${error.code ?? (inventoryMode ? "backup_inventory_failed" : "backup_archive_failed")}: ${error.message}\n`);
  process.exitCode = 2;
});
