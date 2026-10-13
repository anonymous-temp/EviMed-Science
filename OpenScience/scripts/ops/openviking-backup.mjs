#!/usr/bin/env node
// The OpenViking engine's data volume: a consistent copy, its verification, and its restore.
//
// Host-only, like the PostgreSQL backup it rides beside (deploy/host/evimed-postgres-backup-openviking.conf): it holds
// Docker authority, and neither the web nor the backup container is given any.
//
//   openviking-backup.mjs run                       one capture: freeze, copy, resume, encrypt, verify, record, prune
//   openviking-backup.mjs verify ARCHIVE            decrypt and check every member against the manifest inside it
//   openviking-backup.mjs restore ARCHIVE VOLUME    into an EMPTY Docker volume, every file checked as it lands
//
// Hidden knowledge:
//
//  - **Why this volume is backed up at all.** Until v0.5.0 it held derived copies of what PostgreSQL owns and a lost
//    volume cost one `pnpm rebuild:memory-index --all`. It now holds original data — an account's native memory and
//    session archives, the documents pushed as resources, the pages and graphs compiled from them — that exists
//    nowhere else.
//  - **Why the engine is frozen for the copy.** The volume is live databases, not just files: two SQLite stores in
//    WAL mode (the task queue, the usage audit), a log-structured vector store, and the file tree they describe. A
//    copy taken while they are written is three stores caught at three different instants. `docker pause` stops
//    every process of the container at one instant, so the copy is what a power cut at that instant would have left —
//    the state each of those stores is built to recover from — and the engine resumes with its tasks intact, which
//    a stop and start would fail (a failed extraction commit is never retried upstream). The copy of a volume of a
//    few hundred megabytes takes seconds; requests that arrive meanwhile wait, and recall degrades to the term
//    matcher exactly as it does when the index is slow.
//  - **Why not the engine's own pack.** `POST /pack/backup` is a logical export: it is not atomic either, carries no
//    `k=v` tags (measured: a restored tree answers no tag query), no user settings (a paused learner would resume),
//    no account registry and no task queue. It is the right tool for moving between versions, and the wrong one for
//    "put it back as it was last night".
//  - **A limit on the freeze.** The capture is killed and the engine resumed when the copy outlasts
//    OPEN_SCIENCE_OPENVIKING_BACKUP_MAX_PAUSE_SECONDS: a backup that cannot finish must cost one missed backup, not
//    a frozen engine.
//  - **The manifest travels inside the archive.** Every file's sha256 is taken as it is read and written as the
//    archive's last member, so `verify` and `restore` check bytes against what was read at the frozen instant, with
//    no second file to lose.
//
// Not atomic with the PostgreSQL dump taken by the same timer: the two are minutes apart. What each side owns is
// separate (PostgreSQL's records are only *indexed* here, and that part is rebuilt after a restore), so a restore of
// both yields each store as of its own instant; docs/WEB_OPERATIONS_RUNBOOK.md says what to run afterwards.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip, createGzip } from "node:zlib";

const ops = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(ops, "../..");
export const OPENVIKING_ARCHIVE_NAME = /^openviking-data-\d{8}T\d{6}Z\.tar\.gz\.enc$/;
export const OPENVIKING_BACKUP_MANIFEST = ".evimed-openviking-backup-manifest.json";
const failure = (code, message = code) => Object.assign(new Error(message), { code });

/**
 * Host configuration, read from the environment the unit passes (`--env-file` of the deployment's `.env`). Absent or
 * off means no capture and no authority used.
 * @param {Record<string, string | undefined>} [env]
 */
export function openVikingBackupConfig(env = process.env) {
  if (!["1", "true", "yes"].includes(String(env.OPEN_SCIENCE_OPENVIKING_BACKUP_ENABLED ?? "").toLowerCase())) return { enabled: false };
  const directory = (name) => {
    const value = String(env[name] ?? "").trim();
    if (!value || !path.isAbsolute(value) || path.resolve(value) !== value) throw failure("openviking_backup_configuration_invalid", `${name} must be an absolute, normalized path.`);
    return value;
  };
  const dockerName = (name, fallback) => {
    const value = String(env[name] ?? fallback).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw failure("openviking_backup_configuration_invalid", `${name} is not a Docker object name.`);
    return value;
  };
  const whole = (name, fallback, min, max) => {
    const raw = String(env[name] ?? "").trim();
    const value = raw === "" ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw failure("openviking_backup_configuration_invalid", `${name} must be a whole number from ${min} to ${max}.`);
    return value;
  };
  const pin = JSON.parse(fs.readFileSync(path.join(repoRoot, "deps-version.json"), "utf8")).openviking;
  const config = {
    enabled: true,
    backupDir: directory("OPEN_SCIENCE_OPENVIKING_BACKUP_DIR"),
    statusDir: directory("OPEN_SCIENCE_OPENVIKING_BACKUP_STATUS_DIR"),
    passphraseFile: directory("OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE"),
    volume: dockerName("OPEN_SCIENCE_OPENVIKING_DATA_VOLUME", "web_evimed-openviking-data"),
    container: dockerName("OPEN_SCIENCE_OPENVIKING_CONTAINER", "web-evimed-openviking-1"),
    // The helper that reads and writes the volume is the engine's own pinned image: it is already on the host, it has
    // Python, and nothing is pulled for a backup.
    image: String(env.OPEN_SCIENCE_OPENVIKING_IMAGE ?? "").trim() || `${pin.image}:${pin.imageTag}@${pin.imageDigest}`,
    maxSets: whole("OPEN_SCIENCE_OPENVIKING_BACKUP_MAX_SETS", 14, 2, 365),
    maxPauseSeconds: whole("OPEN_SCIENCE_OPENVIKING_BACKUP_MAX_PAUSE_SECONDS", 120, 5, 3600),
    objectUri: String(env.OPEN_SCIENCE_OBJECT_BACKUP_URI ?? "").trim(),
  };
  if (config.backupDir === config.statusDir || config.backupDir.startsWith(`${config.statusDir}${path.sep}`) || config.statusDir.startsWith(`${config.backupDir}${path.sep}`)) {
    throw failure("openviking_backup_configuration_invalid", "The archive directory and the status directory must be separate: the status directory is mounted into the web container.");
  }
  return config;
}

/** The helper container's hardening: no network, a read-only root, root with exactly the capabilities named. */
const helperArgs = (name, capabilities) => ["run", "--rm", "-i", "--name", name, "--network", "none", "--read-only", "--user", "0:0",
  "--cap-drop", "ALL", ...capabilities.flatMap((capability) => ["--cap-add", capability]), "--security-opt", "no-new-privileges"];

// Reads the volume and writes one tar stream to stdout: every directory and regular file under the root it is given
// (/src in the helper), each file's sha256 taken from the bytes as they are written, and the manifest as the last
// member. Anything that is neither (a socket, a device, a link) is named in the manifest and left out. Standard library
// only: it runs on the engine's own image, and the tests run it on the host's Python.
export const OPENVIKING_CAPTURE_PROGRAM = String.raw`
import hashlib, io, json, os, stat, sys, tarfile
MANIFEST, ROOT = sys.argv[1], sys.argv[2]
class Hashing:
    def __init__(self, handle):
        self.handle, self.digest, self.count = handle, hashlib.sha256(), 0
    def read(self, size=-1):
        chunk = self.handle.read(size)
        self.digest.update(chunk); self.count += len(chunk)
        return chunk
files, skipped = [], []
with tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.PAX_FORMAT) as archive:
    for parent, directories, names in os.walk(ROOT):
        directories.sort(); names.sort()
        for name in directories + names:
            full = os.path.join(parent, name)
            relative = os.path.relpath(full, ROOT)
            info = os.lstat(full)
            member = tarfile.TarInfo(relative)
            member.mode, member.uid, member.gid, member.mtime = stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid, int(info.st_mtime)
            if stat.S_ISDIR(info.st_mode):
                member.type = tarfile.DIRTYPE
                archive.addfile(member)
            elif stat.S_ISREG(info.st_mode):
                member.size = info.st_size
                with open(full, "rb") as handle:
                    hashing = Hashing(handle)
                    archive.addfile(member, hashing)
                if hashing.count != info.st_size:
                    raise SystemExit("a file changed size while the engine was frozen: " + relative)
                files.append({"path": relative, "size": info.st_size, "sha256": hashing.digest.hexdigest(), "mode": member.mode, "uid": info.st_uid, "gid": info.st_gid})
            else:
                skipped.append(relative)
    body = json.dumps({"format": "evimed-openviking-backup", "version": 1, "files": files, "skipped": skipped}, ensure_ascii=False, sort_keys=True).encode("utf-8")
    member = tarfile.TarInfo(MANIFEST); member.size = len(body); member.mode = 0o600
    archive.addfile(member, io.BytesIO(body))
`;

// Reads a tar stream from stdin and checks every member against the manifest that ends it. With a destination, each file
// is written under it first (refusing a destination that holds anything), and ownership is given last, children first,
// because this process holds CAP_CHOWN and not CAP_DAC_OVERRIDE: what it gave away it can no longer enter.
export const OPENVIKING_RESTORE_PROGRAM = String.raw`
import hashlib, json, os, sys, tarfile
MANIFEST, DESTINATION = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
if DESTINATION and os.listdir(DESTINATION):
    raise SystemExit("the destination volume is not empty; restore only into a new volume")
seen, manifest, owners = {}, None, []
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
    for member in archive:
        name = member.name
        if name.startswith("/") or ".." in name.split("/"):
            raise SystemExit("the archive names a path outside the volume: " + name)
        if member.isdir():
            if DESTINATION:
                os.makedirs(os.path.join(DESTINATION, name), mode=0o700, exist_ok=True)
                owners.append((name, member.mode, member.uid, member.gid))
            continue
        if not member.isreg():
            raise SystemExit("the archive holds a member that is neither a file nor a directory: " + name)
        source = archive.extractfile(member)
        digest, size = hashlib.sha256(), 0
        if name == MANIFEST:
            body = source.read()
            manifest = json.loads(body.decode("utf-8"))
            continue
        target = open(os.path.join(DESTINATION, name), "xb") if DESTINATION else None
        while True:
            chunk = source.read(1 << 20)
            if not chunk:
                break
            digest.update(chunk); size += len(chunk)
            if target:
                target.write(chunk)
        if target:
            target.flush(); os.fsync(target.fileno()); target.close()
            owners.append((name, member.mode, member.uid, member.gid))
        seen[name] = (size, digest.hexdigest())
if manifest is None or manifest.get("format") != "evimed-openviking-backup" or manifest.get("version") != 1:
    raise SystemExit("the archive carries no manifest of this format")
expected = {entry["path"]: (entry["size"], entry["sha256"]) for entry in manifest["files"]}
if expected != seen:
    wrong = sorted(set(expected) ^ set(seen)) or sorted(name for name in expected if expected[name] != seen.get(name))
    raise SystemExit("the archive does not hold what its manifest names, first difference: " + wrong[0])
for name, mode, uid, gid in sorted(owners, key=lambda entry: entry[0].count("/"), reverse=True):
    full = os.path.join(DESTINATION, name)
    os.chmod(full, mode); os.chown(full, uid, gid)
print(json.dumps({"files": len(seen), "bytes": sum(size for size, _ in seen.values()), "restored": bool(DESTINATION)}))
`;

/** @param {string[]} args @param {{ input?: import("node:stream").Readable, output?: import("node:stream").Writable, signal?: AbortSignal }} [io] */
function docker(args, { input, output, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    if (output) child.stdout.pipe(output, { end: false }); else child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    if (input) { input.pipe(child.stdin); child.stdin.on("error", () => {}); }
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(failure("openviking_backup_docker_failed", `docker ${args[0]} ${args[1] ?? ""} failed (${code}): ${stderr.trim().split("\n").pop() ?? ""}`))));
  });
}

async function privateDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fsp.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("openviking_backup_directory_invalid", `${directory} is not a directory.`);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

function crypto(mode, input, output, config) {
  const result = spawnSync(process.execPath, [path.join(ops, "archive-crypto.mjs"), mode, input, output],
    { env: { PATH: process.env.PATH, OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: config.passphraseFile }, encoding: "utf8" });
  if (result.status !== 0) throw failure("openviking_backup_crypto_failed", `archive ${mode}ion failed: ${String(result.stderr).trim().split("\n").pop()}`);
}

/** Decrypt an archive into a private scratch file beside it and hand the tar stream to `use`. */
async function withPlainTar(archive, config, use) {
  const scratch = `${archive}.plain.${process.pid}`;
  try {
    crypto("decrypt", archive, scratch, config);
    return await use(fs.createReadStream(scratch).pipe(createGunzip()));
  } finally {
    await fsp.rm(scratch, { force: true });
  }
}

/** Check every member of an archive against the manifest inside it. @returns {Promise<{ files: number, bytes: number }>} */
export async function verifyOpenVikingArchive(archive, config) {
  if (!OPENVIKING_ARCHIVE_NAME.test(path.basename(archive))) throw failure("openviking_backup_archive_name_invalid");
  return withPlainTar(archive, config, async (tar) => JSON.parse(await docker(
    [...helperArgs(`evimed-openviking-backup-verify-${process.pid}`, []), "--entrypoint", "python", config.image, "-c", OPENVIKING_RESTORE_PROGRAM, OPENVIKING_BACKUP_MANIFEST], { input: tar })));
}

/**
 * Restore an archive into an empty volume. The files land owned as they were (the engine's uid); the compose file's
 * init step would give them away again in any case.
 */
export async function restoreOpenVikingArchive(archive, volume, config) {
  if (!OPENVIKING_ARCHIVE_NAME.test(path.basename(archive))) throw failure("openviking_backup_archive_name_invalid");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(volume)) throw failure("openviking_backup_configuration_invalid", "The destination is not a Docker volume name.");
  return withPlainTar(archive, config, async (tar) => JSON.parse(await docker(
    // CHOWN gives the files to the engine's uid; DAC_OVERRIDE is not held, which is why ownership is given last.
    [...helperArgs(`evimed-openviking-backup-restore-${process.pid}`, ["CHOWN"]), "-v", `${volume}:/dst`, "--entrypoint", "python", config.image, "-c", OPENVIKING_RESTORE_PROGRAM, OPENVIKING_BACKUP_MANIFEST, "/dst"],
    { input: tar })));
}

async function writeState(config, state) {
  await privateDirectory(config.statusDir);
  // Readable by the web container's uid through the status mount: no secret is in it.
  await fsp.chmod(config.statusDir, 0o755);
  const target = path.join(config.statusDir, "state.json");
  const temporary = `${target}.tmp.${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, ...state }, null, 1)}\n`, { mode: 0o644 });
  await fsp.rename(temporary, target);
}

async function readState(config) {
  try {
    return JSON.parse(await fsp.readFile(path.join(config.statusDir, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Keep the newest `maxSets` archives (and their checksum files); never the one just written. */
export async function pruneOpenVikingArchives(config) {
  const names = (await fsp.readdir(config.backupDir)).filter((name) => OPENVIKING_ARCHIVE_NAME.test(name)).sort();
  const removed = names.slice(0, Math.max(0, names.length - config.maxSets));
  for (const name of removed) {
    await fsp.rm(path.join(config.backupDir, name), { force: true });
    await fsp.rm(path.join(config.backupDir, `${name}.sha256`), { force: true });
  }
  return removed;
}

/**
 * One capture. Resolves with the state that was written; a failed capture is recorded as failed (keeping the last
 * success) and rejected, and the engine is resumed whatever happened.
 * @param {ReturnType<typeof openVikingBackupConfig>} config
 * @param {{ now?: () => Date, log?: (line: string) => void }} [options]
 */
export async function runOpenVikingBackup(config, { now = () => new Date(), log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  if (!config.enabled) return { enabled: false };
  await privateDirectory(config.backupDir);
  const startedAt = now();
  const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const archive = path.join(config.backupDir, `openviking-data-${stamp}.tar.gz.enc`);
  const plain = `${archive.slice(0, -4)}.tmp.${process.pid}`;
  const previous = await readState(config);
  const captureName = `evimed-openviking-backup-capture-${process.pid}`;
  let paused = false;
  let pausedMs = 0;
  /** @type {Error | null} */
  let resumeError = null;
  const resume = async () => {
    if (!paused) return;
    paused = false;
    await docker(["unpause", config.container]).catch((error) => {
      resumeError = error;
      log(`openviking backup: the engine could NOT be resumed: ${error.message}`);
    });
  };
  const onSignal = () => { void resume().finally(() => process.exit(1)); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    if (fs.existsSync(archive)) throw failure("openviking_backup_archive_exists", "An archive for this second already exists.");
    // `running` is frozen for the copy; a container that is stopped or absent is copied as it lies, which is a clean copy;
    // one that somebody else paused is copied and left as it was found.
    const status = await docker(["inspect", "--format", "{{.State.Status}}", config.container]).catch(() => "absent");
    const consistency = status === "running" ? "paused" : status === "paused" ? "found-paused" : "stopped";
    const limit = new AbortController();
    const frozenAt = Date.now();
    const watchdog = setTimeout(() => limit.abort(), config.maxPauseSeconds * 1000);
    try {
      if (status === "running") { await docker(["pause", config.container]); paused = true; }
      const gzip = createGzip({ level: 6 });
      const written = pipeline(gzip, fs.createWriteStream(plain, { mode: 0o600, flags: "wx" }));
      await docker([...helperArgs(captureName, ["DAC_READ_SEARCH"]), "-v", `${config.volume}:/src:ro`,
        "--entrypoint", "python", config.image, "-c", OPENVIKING_CAPTURE_PROGRAM, OPENVIKING_BACKUP_MANIFEST, "/src"], { output: gzip, signal: limit.signal })
        .finally(() => gzip.end());
      await written;
    } catch (error) {
      if (limit.signal.aborted) {
        // Killing the client does not always stop what it started.
        await docker(["rm", "-f", captureName]).catch(() => {});
        throw failure("openviking_backup_pause_limit", `The copy outlasted ${config.maxPauseSeconds} s; the engine was resumed and nothing was kept.`);
      }
      throw error;
    } finally {
      clearTimeout(watchdog);
      await resume();
      pausedMs = status === "running" ? Date.now() - frozenAt : 0;
    }
    // A copy that left the engine frozen is not a success, whatever it holds: say so where readiness and the operator look.
    if (resumeError) throw failure("openviking_backup_resume_failed", `The engine could not be resumed after the copy: ${resumeError.message}`);
    crypto("encrypt", plain, archive, config);
    await fsp.rm(plain, { force: true });
    const sha256 = await sha256File(archive);
    await fsp.writeFile(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`, { mode: 0o600 });
    // The drill: the encrypted archive that will be kept is decrypted again and every file's bytes are checked against
    // what was read while the engine was frozen.
    const verified = await verifyOpenVikingArchive(archive, config);
    const removed = await pruneOpenVikingArchives(config);
    if (config.objectUri) {
      const upload = spawnSync(process.execPath, [path.join(ops, "object-backup.mjs"), "upload", archive, config.objectUri], { env: process.env, encoding: "utf8" });
      if (upload.status !== 0) throw failure("openviking_backup_upload_failed", String(upload.stderr).trim().split("\n").pop());
    }
    const state = {
      status: "healthy", lastAttemptAt: startedAt.toISOString(), lastSuccessAt: now().toISOString(), lastDrillAt: now().toISOString(),
      archive: path.basename(archive), sha256, archiveBytes: (await fsp.stat(archive)).size, files: verified.files, contentBytes: verified.bytes,
      consistency, pausedMs, encrypted: true, volume: config.volume, image: config.image, kept: config.maxSets, pruned: removed.length,
      offBox: Boolean(config.objectUri),
    };
    await writeState(config, state);
    log(`openviking backup: ${state.archive} (${verified.files} files, ${verified.bytes} bytes, engine frozen ${pausedMs} ms, ${consistency})`);
    return state;
  } catch (error) {
    await fsp.rm(plain, { force: true }).catch(() => {});
    await writeState(config, {
      status: "failed", lastAttemptAt: startedAt.toISOString(), lastSuccessAt: previous?.lastSuccessAt ?? null, lastDrillAt: previous?.lastDrillAt ?? null,
      archive: previous?.archive ?? null, code: typeof error?.code === "string" ? error.code : "openviking_backup_failed",
    }).catch(() => {});
    throw error;
  } finally {
    await resume();
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second] = process.argv.slice(2);
  try {
    const config = openVikingBackupConfig();
    if (!config.enabled) {
      process.stdout.write("openviking backup: not enabled (OPEN_SCIENCE_OPENVIKING_BACKUP_ENABLED)\n");
    } else if (command === "run") {
      await runOpenVikingBackup(config);
    } else if (command === "verify" && first) {
      process.stdout.write(`${JSON.stringify(await verifyOpenVikingArchive(path.resolve(first), config))}\n`);
    } else if (command === "restore" && first && second) {
      process.stdout.write(`${JSON.stringify(await restoreOpenVikingArchive(path.resolve(first), second, config))}\n`);
    } else {
      process.stderr.write("Usage: openviking-backup.mjs run | verify ARCHIVE | restore ARCHIVE VOLUME\n");
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${error?.code ?? "openviking_backup_failed"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
