// The OpenViking engine volume's backup: the capture, its verification, the restore, and what readiness reads of it.
//
// The volume became a store of record with v0.5.0 (native memory, session archives, pushed documents, compiled pages),
// so a copy has to be consistent — the engine is frozen with `docker pause` while a helper reads the volume — and has
// to be checked before it is believed. The real cycle was run against a running engine on 2026-10-13 (capture, verify,
// restore into a new volume, the engine started on it with 180 of 180 files byte-identical, tags and search unchanged;
// live/ovbase/backup-restore/RESULT.txt). Here the same code runs against a fake `docker` that executes the two helper
// programs with this host's Python, so what is asserted is the order of freeze, copy and resume, the receipt, and the
// refusals — not Docker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openVikingBackupReadiness } from "../src/openVikingBackupReadiness.mjs";
import {
  OPENVIKING_ARCHIVE_NAME, OPENVIKING_BACKUP_MANIFEST, OPENVIKING_CAPTURE_PROGRAM, OPENVIKING_RESTORE_PROGRAM,
  openVikingBackupConfig, pruneOpenVikingArchives, restoreOpenVikingArchive, runOpenVikingBackup, verifyOpenVikingArchive,
} from "../../../scripts/ops/openviking-backup.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const versions = JSON.parse(await readFile(path.join(repoRoot, "deps-version.json"), "utf8"));
const python = ["python3", "python"].find((command) => spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"], { stdio: "ignore" }).status === 0);
const withPython = { skip: !python && "Python 3 is required to run the helper programs" };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function scratch(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "evimed-ov-backup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A small engine volume: nested directories, a binary file, an empty one, a CJK name, a SQLite-like WAL pair, a link. */
async function engineVolume(root) {
  const files = {
    "data/viking/evimed/user/u-0f1e2d3c4b5a69788796a5b4/memories/profile.md": "# 用户\n- 后端工程师\n",
    "data/viking/evimed/user/u-0f1e2d3c4b5a69788796a5b4/resources/p/p-3c2b1a0998877665ffeeddcc/wiki/entity/Beta网关.md": "---\ntype: entity\n---\n# Beta 网关\n",
    "data/_system/queue/queue.db": Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0xff, 0x10]),
    "data/_system/queue/queue.db-wal": Buffer.alloc(4096, 7),
    "data/vectordb/context/store/000006.log": Buffer.alloc(0),
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  await chmod(path.join(root, "data/_system/queue/queue.db"), 0o640);
  // A link is not something the engine writes; one found is named in the manifest and not followed.
  await symlink("/etc/hostname", path.join(root, "data/stray-link"));
  return files;
}

function runPython(program, args, { input = null } = {}) {
  return spawnSync(python, ["-I", "-c", program, ...args], { input, maxBuffer: 64 * 1024 * 1024 });
}

test("the capture writes every file with its digest and a manifest last, and the restore puts back exactly that", withPython, async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "volume");
  const files = await engineVolume(source);
  const captured = runPython(OPENVIKING_CAPTURE_PROGRAM, [OPENVIKING_BACKUP_MANIFEST, source]);
  assert.equal(captured.status, 0, String(captured.stderr));
  const tar = captured.stdout;

  // Verify only: every member against the manifest, nothing written.
  const verified = runPython(OPENVIKING_RESTORE_PROGRAM, [OPENVIKING_BACKUP_MANIFEST], { input: tar });
  assert.equal(verified.status, 0, String(verified.stderr));
  const counts = JSON.parse(String(verified.stdout));
  assert.equal(counts.files, Object.keys(files).length);
  assert.equal(counts.bytes, Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content), 0));
  assert.equal(counts.restored, false);

  // Into an empty directory: the same bytes, the same modes, the link left out.
  const destination = path.join(root, "restored");
  await mkdir(destination);
  const restored = runPython(OPENVIKING_RESTORE_PROGRAM, [OPENVIKING_BACKUP_MANIFEST, destination], { input: tar });
  assert.equal(restored.status, 0, String(restored.stderr));
  for (const [relative, content] of Object.entries(files)) {
    assert.equal(sha256(await readFile(path.join(destination, relative))), sha256(Buffer.from(content)), relative);
  }
  assert.equal((await stat(path.join(destination, "data/_system/queue/queue.db"))).mode & 0o777, 0o640);
  await assert.rejects(() => stat(path.join(destination, "data/stray-link")), { code: "ENOENT" });
  await assert.rejects(() => stat(path.join(destination, OPENVIKING_BACKUP_MANIFEST)), { code: "ENOENT" }, "the manifest was restored as a file of the volume");

  // The manifest names the link it left out.
  const manifestAt = tar.lastIndexOf(Buffer.from('{"files"'));
  assert.ok(manifestAt > 0);
  const manifest = JSON.parse(tar.subarray(manifestAt, tar.indexOf(0, manifestAt)).toString("utf8"));
  assert.equal(manifest.format, "evimed-openviking-backup");
  assert.deepEqual(manifest.skipped, ["data/stray-link"]);
  assert.ok(manifest.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)));

  // A second restore into the same, now non-empty, directory is refused: a restore never merges into a live volume.
  const again = runPython(OPENVIKING_RESTORE_PROGRAM, [OPENVIKING_BACKUP_MANIFEST, destination], { input: tar });
  assert.notEqual(again.status, 0);
  assert.match(String(again.stderr), /not empty/);
});

test("an archive whose bytes are not the ones its manifest names, or that reaches outside the volume, is refused", withPython, async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "volume");
  await engineVolume(source);
  const tar = runPython(OPENVIKING_CAPTURE_PROGRAM, [OPENVIKING_BACKUP_MANIFEST, source]).stdout;

  // One byte of a file's content flipped (inside the WAL's run of sevens).
  const tampered = Buffer.from(tar);
  const at = tampered.indexOf(Buffer.alloc(64, 7));
  assert.ok(at > 0);
  tampered[at + 10] = 8;
  const changed = runPython(OPENVIKING_RESTORE_PROGRAM, [OPENVIKING_BACKUP_MANIFEST], { input: tampered });
  assert.notEqual(changed.status, 0);
  assert.match(String(changed.stderr), /does not hold what its manifest names/);

  // Cut before the manifest: no manifest, no verdict.
  const cut = runPython(OPENVIKING_RESTORE_PROGRAM, [OPENVIKING_BACKUP_MANIFEST], { input: tar.subarray(0, tar.lastIndexOf(Buffer.from(OPENVIKING_BACKUP_MANIFEST)) - 1) });
  assert.notEqual(cut.status, 0);

  // A member that climbs out of the volume.
  const escape = runPython(String.raw`
import io, sys, tarfile
out = io.BytesIO()
with tarfile.open(fileobj=out, mode="w") as archive:
    member = tarfile.TarInfo("../outside.txt"); body = b"x"; member.size = len(body)
    archive.addfile(member, io.BytesIO(body))
sys.stdout.buffer.write(out.getvalue())
`, []).stdout;
  const destination = path.join(root, "restored");
  await mkdir(destination);
  const refused = runPython(OPENVIKING_RESTORE_PROGRAM, [OPENVIKING_BACKUP_MANIFEST, destination], { input: escape });
  assert.notEqual(refused.status, 0);
  assert.match(String(refused.stderr), /outside the volume/);
  await assert.rejects(() => stat(path.join(root, "outside.txt")), { code: "ENOENT" });
});

/**
 * A `docker` that runs the helper programs on this host: `-v VOLUME:/x` maps to a directory of `FAKE_DOCKER_VOLUMES`,
 * every call is appended to `FAKE_DOCKER_LOG`, and `FAKE_DOCKER_STATUS`, `FAKE_DOCKER_FAIL` (`pause`, `capture`,
 * `unpause`) and `FAKE_DOCKER_CAPTURE_DELAY_MS` shape the answers.
 */
async function fakeDocker(directory) {
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const volumes = JSON.parse(process.env.FAKE_DOCKER_VOLUMES || "{}");
const fail = (process.env.FAKE_DOCKER_FAIL || "").split(",");
const program = args.includes("-c") ? args[args.indexOf("-c") + 1] : "";
const kind = args[0] === "run" ? (program.includes("Hashing") ? "capture" : args.some((a) => a.endsWith(":/dst")) ? "restore" : "verify") : args[0];
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ kind, args: args.filter((a) => a !== program) }) + "\\n");
if (kind === "inspect") { if (process.env.FAKE_DOCKER_STATUS === "absent") process.exit(1); process.stdout.write((process.env.FAKE_DOCKER_STATUS || "running") + "\\n"); process.exit(0); }
if (["pause", "unpause"].includes(kind) && fail.includes(kind)) { process.stderr.write(kind + " refused\\n"); process.exit(1); }
if (kind !== "run" && !["capture", "restore", "verify"].includes(kind)) process.exit(0);
if (kind === "capture" && fail.includes("capture")) { process.stderr.write("the helper could not read the volume\\n"); process.exit(3); }
const mounts = {};
for (let i = 0; i < args.length; i += 1) if (args[i] === "-v") { const [source, target] = args[i + 1].split(":"); mounts[target] = volumes[source]; }
const rest = args.slice(args.indexOf("-c") + 2).map((a) => mounts[a] ?? a);
setTimeout(() => {
  const child = spawn(process.env.FAKE_DOCKER_PYTHON, ["-I", "-c", program, ...rest], { stdio: ["pipe", "inherit", "inherit"] });
  process.stdin.pipe(child.stdin);
  child.on("close", (code) => process.exit(code ?? 1));
}, kind === "capture" ? Number(process.env.FAKE_DOCKER_CAPTURE_DELAY_MS || 0) : 0);
`, { mode: 0o755 });
  return bin;
}

async function cycleFixture(t, env = {}) {
  const root = await scratch(t);
  const volume = path.join(root, "volume");
  const files = await engineVolume(volume);
  const restoredVolume = path.join(root, "restored-volume");
  await mkdir(restoredVolume);
  const bin = await fakeDocker(root);
  const passphrase = path.join(root, "passphrase");
  await writeFile(passphrase, "test-only-backup-passphrase-0123456789abcdef\n", { mode: 0o600 });
  const log = path.join(root, "docker.log");
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  Object.assign(process.env, {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_LOG: log, FAKE_DOCKER_PYTHON: python,
    FAKE_DOCKER_VOLUMES: JSON.stringify({ "web_evimed-openviking-data": volume, "evimed-openviking-restored": restoredVolume }), ...env,
  });
  const config = openVikingBackupConfig({
    OPEN_SCIENCE_OPENVIKING_BACKUP_ENABLED: "true", OPEN_SCIENCE_OPENVIKING_BACKUP_DIR: path.join(root, "archives"),
    OPEN_SCIENCE_OPENVIKING_BACKUP_STATUS_DIR: path.join(root, "status"), OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: passphrase,
    OPEN_SCIENCE_OPENVIKING_BACKUP_MAX_SETS: "2", OPEN_SCIENCE_OPENVIKING_BACKUP_MAX_PAUSE_SECONDS: env.MAX_PAUSE ?? "60",
  });
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const receipt = async () => JSON.parse(await readFile(path.join(config.statusDir, "state.json"), "utf8"));
  let tick = Date.parse("2026-10-13T02:30:00.000Z");
  const now = () => new Date((tick += 1_000));
  return { root, files, config, calls, receipt, restoredVolume, now };
}

test("a capture freezes the engine for the copy alone, then encrypts, verifies and records the copy it kept", withPython, async (t) => {
  const { files, config, calls, receipt, now } = await cycleFixture(t);
  const lines = [];
  const state = await runOpenVikingBackup(config, { now, log: (line) => lines.push(line) });
  // Frozen, copied, resumed — and only then the slow parts, while the engine answers again.
  assert.deepEqual((await calls()).map((call) => call.kind), ["inspect", "pause", "capture", "unpause", "verify"]);
  const capture = (await calls()).find((call) => call.kind === "capture").args;
  for (const flag of ["--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]) assert.ok(capture.includes(flag), flag);
  assert.ok(capture.includes("web_evimed-openviking-data:/src:ro"), "the volume is not mounted read-only for the copy");
  assert.ok(capture.includes(`${versions.openviking.image}:${versions.openviking.imageTag}@${versions.openviking.imageDigest}`), "the helper is not the pinned engine image");

  assert.equal(state.status, "healthy");
  assert.equal(state.consistency, "paused");
  assert.equal(state.files, Object.keys(files).length);
  assert.equal(state.encrypted, true);
  assert.match(state.archive, OPENVIKING_ARCHIVE_NAME);
  assert.deepEqual(await receipt(), { schemaVersion: 1, ...state });
  assert.match(lines[0], /^openviking backup: openviking-data-\d{8}T\d{6}Z\.tar\.gz\.enc \(\d+ files/);

  // What is kept is encrypted: neither a gzip stream nor a tar is readable from it.
  const archive = path.join(config.backupDir, state.archive);
  const bytes = await readFile(archive);
  assert.notDeepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
  assert.ok(!bytes.includes(Buffer.from("profile.md")));
  assert.equal((await stat(archive)).mode & 0o077, 0, "the archive is readable by others");
  assert.equal((await readFile(`${archive}.sha256`, "utf8")).trim(), `${sha256(bytes)}  ${state.archive}`);
  assert.deepEqual((await readdir(config.backupDir)).sort(), [state.archive, `${state.archive}.sha256`], "a plaintext scratch file was left behind");
  // The receipt is world-readable (it is mounted into the web container) and names no secret.
  assert.equal((await stat(path.join(config.statusDir, "state.json"))).mode & 0o777, 0o644);
  assert.ok(!JSON.stringify(state).includes("passphrase") && !JSON.stringify(state).includes(config.backupDir));
});

test("the archive restores into an empty volume byte for byte, and only into an empty one", withPython, async (t) => {
  const { files, config, restoredVolume, now } = await cycleFixture(t);
  const state = await runOpenVikingBackup(config, { now, log: () => {} });
  const archive = path.join(config.backupDir, state.archive);
  assert.deepEqual(await verifyOpenVikingArchive(archive, config), { files: Object.keys(files).length, bytes: state.contentBytes, restored: false });
  const restored = await restoreOpenVikingArchive(archive, "evimed-openviking-restored", config);
  assert.equal(restored.restored, true);
  for (const [relative, content] of Object.entries(files)) {
    assert.equal(sha256(await readFile(path.join(restoredVolume, relative))), sha256(Buffer.from(content)), relative);
  }
  await assert.rejects(() => restoreOpenVikingArchive(archive, "evimed-openviking-restored", config), /not empty/);
  await assert.rejects(() => restoreOpenVikingArchive(archive, "not a volume name", config), { code: "openviking_backup_configuration_invalid" });
  await assert.rejects(() => verifyOpenVikingArchive(path.join(config.backupDir, "something-else.tar.gz.enc"), config), { code: "openviking_backup_archive_name_invalid" });
  // A wrong passphrase decrypts nothing.
  const wrong = path.join(path.dirname(config.passphraseFile), "wrong-passphrase");
  await writeFile(wrong, "another-passphrase-of-a-plausible-length-0123\n", { mode: 0o600 });
  await assert.rejects(() => verifyOpenVikingArchive(archive, { ...config, passphraseFile: wrong }), { code: "openviking_backup_crypto_failed" });
});

test("a copy that fails resumes the engine, keeps the last success in the receipt and leaves nothing half-written", withPython, async (t) => {
  const { config, calls, receipt, now } = await cycleFixture(t);
  const first = await runOpenVikingBackup(config, { now, log: () => {} });
  process.env.FAKE_DOCKER_FAIL = "capture";
  await assert.rejects(() => runOpenVikingBackup(config, { now, log: () => {} }), { code: "openviking_backup_docker_failed" });
  const kinds = (await calls()).map((call) => call.kind);
  assert.deepEqual(kinds.slice(-3), ["pause", "capture", "unpause"], "the engine was left frozen after a failed copy");
  const failed = await receipt();
  assert.equal(failed.status, "failed");
  assert.equal(failed.code, "openviking_backup_docker_failed");
  assert.equal(failed.lastSuccessAt, first.lastSuccessAt, "a failed capture erased the last good one from the receipt");
  assert.equal(failed.archive, first.archive);
  assert.deepEqual((await readdir(config.backupDir)).sort(), [first.archive, `${first.archive}.sha256`]);
});

test("a copy that outlasts the freeze limit is abandoned and the engine resumed; one that cannot resume it is a failure", withPython, async (t) => {
  const { config, calls, receipt, now } = await cycleFixture(t, { FAKE_DOCKER_CAPTURE_DELAY_MS: "3000", MAX_PAUSE: "5" });
  const limited = { ...config, maxPauseSeconds: 1 };
  const started = Date.now();
  await assert.rejects(() => runOpenVikingBackup(limited, { now, log: () => {} }), { code: "openviking_backup_pause_limit" });
  assert.ok(Date.now() - started < 2_900, "the freeze lasted as long as the copy, not as long as the limit");
  assert.ok((await calls()).some((call) => call.kind === "unpause"), "the engine was left frozen");
  assert.ok((await calls()).some((call) => call.kind === "rm"), "the helper was not removed");
  assert.equal((await receipt()).code, "openviking_backup_pause_limit");

  delete process.env.FAKE_DOCKER_CAPTURE_DELAY_MS;
  process.env.FAKE_DOCKER_FAIL = "unpause";
  const lines = [];
  await assert.rejects(() => runOpenVikingBackup(config, { now, log: (line) => lines.push(line) }), { code: "openviking_backup_resume_failed" });
  assert.match(lines.join("\n"), /could NOT be resumed/);
  assert.equal((await receipt()).status, "failed");
});

test("an engine that is not running is copied as it lies, and the newest copies are the ones kept", withPython, async (t) => {
  const { config, calls } = await cycleFixture(t, { FAKE_DOCKER_STATUS: "exited" });
  const kept = [];
  for (let index = 0; index < 3; index += 1) kept.push((await runOpenVikingBackup(config, { now: () => new Date(Date.parse("2026-10-13T02:30:00Z") + index * 60_000), log: () => {} })).archive);
  assert.ok(!(await calls()).some((call) => call.kind === "pause" || call.kind === "unpause"), "a stopped engine was paused");
  // Two kept (OPEN_SCIENCE_OPENVIKING_BACKUP_MAX_SETS), the oldest gone with its checksum.
  assert.deepEqual((await readdir(config.backupDir)).sort(), [kept[1], `${kept[1]}.sha256`, kept[2], `${kept[2]}.sha256`]);
  assert.deepEqual(await pruneOpenVikingArchives(config), []);
});

test("the host configuration: off unless enabled, absolute paths, separate directories, Docker names, pinned image", async () => {
  assert.deepEqual(openVikingBackupConfig({}), { enabled: false });
  assert.deepEqual(openVikingBackupConfig({ OPEN_SCIENCE_OPENVIKING_BACKUP_ENABLED: "false" }), { enabled: false });
  const base = { OPEN_SCIENCE_OPENVIKING_BACKUP_ENABLED: "true", OPEN_SCIENCE_OPENVIKING_BACKUP_DIR: "/srv/b/openviking",
    OPEN_SCIENCE_OPENVIKING_BACKUP_STATUS_DIR: "/srv/s/openviking-status", OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: "/srv/secrets/backup-passphrase" };
  const config = openVikingBackupConfig(base);
  assert.equal(config.volume, "web_evimed-openviking-data");
  assert.equal(config.container, "web-evimed-openviking-1");
  assert.equal(config.image, `${versions.openviking.image}:${versions.openviking.imageTag}@${versions.openviking.imageDigest}`);
  assert.equal(config.maxSets, 14);
  assert.equal(config.maxPauseSeconds, 120);
  for (const [name, value] of [
    ["OPEN_SCIENCE_OPENVIKING_BACKUP_DIR", "relative/dir"], ["OPEN_SCIENCE_OPENVIKING_BACKUP_DIR", "/srv/b/../escape"],
    ["OPEN_SCIENCE_OPENVIKING_BACKUP_STATUS_DIR", "/srv/b/openviking/status"], ["OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE", ""],
    ["OPEN_SCIENCE_OPENVIKING_DATA_VOLUME", "volume;rm"], ["OPEN_SCIENCE_OPENVIKING_CONTAINER", "-v"],
    ["OPEN_SCIENCE_OPENVIKING_BACKUP_MAX_SETS", "1"], ["OPEN_SCIENCE_OPENVIKING_BACKUP_MAX_PAUSE_SECONDS", "4000"],
  ]) {
    assert.throws(() => openVikingBackupConfig({ ...base, [name]: value }), { code: "openviking_backup_configuration_invalid" }, `${name}=${value}`);
  }
  // The data archives' object storage takes these archives too, and only encrypted.
  const objectBackup = await readFile(path.join(repoRoot, "scripts/ops/object-backup.mjs"), "utf8");
  const pattern = new RegExp(/archivePattern = \/(.+)\/;/.exec(objectBackup)[1]);
  assert.ok(pattern.test("openviking-data-20261013T015017Z.tar.gz.enc"));
  assert.ok(!pattern.test("openviking-data-20261013T015017Z.tar.gz"), "a plaintext engine archive would be uploadable");
  assert.ok(pattern.test("open-science-data-20261013T015017Z.tar.gz.enc"));
});

test("the host timer runs the capture after the platform database's dump, with nothing but its two directories writable", async () => {
  const dropIn = await readFile(path.join(repoRoot, "deploy/host/evimed-postgres-backup-openviking.conf"), "utf8");
  assert.match(dropIn, /^\[Service\]$/m);
  assert.match(dropIn, /^ExecStartPost=\/usr\/bin\/env node --env-file=\/srv\/evimed-science\/current\/OpenScience\/deploy\/web\/\.env \/srv\/evimed-science\/current\/OpenScience\/scripts\/ops\/openviking-backup\.mjs run$/m);
  assert.match(dropIn, /^ReadWritePaths=\/srv\/evimed-science\/shared\/backups\/openviking \/srv\/evimed-science\/shared\/openviking-backup-status$/m);
  const unit = await readFile(path.join(repoRoot, "deploy/host/evimed-postgres-backup.service"), "utf8");
  assert.match(unit, /ProtectSystem=strict/);
  // The web container gets the receipt's directory, read-only, and nothing else of the capture.
  const YAML = (await import("yaml")).default;
  const overlay = YAML.parse(await readFile(path.join(repoRoot, "deploy/web/docker-compose.backup.yml"), "utf8"));
  const web = overlay.services["open-science-web"];
  assert.equal(web.environment.OPEN_SCIENCE_OPENVIKING_BACKUP_STATE_FILE, "/run/openviking-backup-status/state.json");
  const mount = web.volumes.find((entry) => entry.target === "/run/openviking-backup-status");
  assert.deepEqual(mount, { type: "bind", source: "${OPEN_SCIENCE_OPENVIKING_BACKUP_STATUS_DIR:-./openviking-backup-status}", target: "/run/openviking-backup-status", read_only: true, bind: { create_host_path: false } });
  assert.ok((await stat(path.join(repoRoot, "deploy/web/openviking-backup-status/.gitkeep"))).isFile(), "the default directory the overlay mounts is not in the release");
  assert.ok(!JSON.stringify(overlay).includes("docker.sock"), "the overlay hands a container the Docker socket");
});

// --- what readiness reads -------------------------------------------------------------------------------------------

async function receiptFixture(t, state, mode = 0o644) {
  const directory = await scratch(t);
  const file = path.join(directory, "state.json");
  if (state !== undefined) await writeFile(file, typeof state === "string" ? state : JSON.stringify(state), { mode });
  if (state !== undefined) await chmod(file, mode);
  return { file, config: { openVikingBackupStateFile: file, openVikingBackupMaxAgeSeconds: 90_000 } };
}

const NOW = Date.parse("2026-10-13T03:00:00.000Z");
const healthyReceipt = {
  schemaVersion: 1, status: "healthy", lastAttemptAt: "2026-10-13T02:30:00.000Z", lastSuccessAt: "2026-10-13T02:30:03.000Z",
  lastDrillAt: "2026-10-13T02:30:03.000Z", archive: "openviking-data-20261013T023000Z.tar.gz.enc", files: 275, contentBytes: 11_420_366,
  consistency: "paused", pausedMs: 1330, encrypted: true, offBox: false,
};

test("readiness reports a verified, recent copy, and every other receipt as a named notice that never fails the check", async (t) => {
  assert.deepEqual(await openVikingBackupReadiness({}, NOW), { required: false, healthy: false, configured: false, code: "openviking_backup_state_unconfigured" });
  const healthy = await openVikingBackupReadiness((await receiptFixture(t, healthyReceipt)).config, NOW);
  assert.deepEqual(healthy, {
    required: false, healthy: true, configured: true, lastAttemptAt: healthyReceipt.lastAttemptAt, lastSuccessAt: healthyReceipt.lastSuccessAt,
    ageSeconds: 1797, maxAgeSeconds: 90_000, lastDrillAt: healthyReceipt.lastDrillAt, encrypted: true, consistency: "paused",
    files: 275, contentBytes: 11_420_366, pausedMs: 1330, offBox: false,
  });
  const cases = [
    [undefined, "openviking_backup_state_missing"],
    ["{not json", "openviking_backup_state_invalid"],
    [{ ...healthyReceipt, schemaVersion: 2 }, "openviking_backup_state_invalid"],
    [{ ...healthyReceipt, encrypted: false }, "openviking_backup_state_invalid"],
    [{ ...healthyReceipt, lastDrillAt: null }, "openviking_backup_state_invalid"],
    [{ ...healthyReceipt, consistency: "live" }, "openviking_backup_state_invalid"],
    [{ ...healthyReceipt, lastSuccessAt: "2026-10-14T03:00:00.000Z" }, "openviking_backup_state_invalid"],
    [{ ...healthyReceipt, status: "failed", code: "openviking_backup_pause_limit" }, "openviking_backup_unhealthy"],
    [{ ...healthyReceipt, lastSuccessAt: "2026-10-11T02:00:00.000Z", lastDrillAt: "2026-10-11T02:00:00.000Z" }, "openviking_backup_stale"],
  ];
  for (const [state, code] of cases) {
    const result = await openVikingBackupReadiness((await receiptFixture(t, state)).config, NOW);
    assert.equal(result.healthy, false, JSON.stringify(state));
    assert.equal(result.code, code, JSON.stringify(state));
    assert.equal(result.required, false, "a backup notice was made a requirement");
  }
  const failed = await openVikingBackupReadiness((await receiptFixture(t, { ...healthyReceipt, status: "failed", code: "openviking_backup_pause_limit" })).config, NOW);
  assert.equal(failed.lastCode, "openviking_backup_pause_limit");
  assert.equal(failed.lastSuccessAt, healthyReceipt.lastSuccessAt, "the last good copy is not reported beside the failure");
  // A receipt another uid could have written is not the host's.
  const writable = await receiptFixture(t, healthyReceipt, 0o666);
  assert.equal((await openVikingBackupReadiness(writable.config, NOW)).code, "openviking_backup_state_invalid");
  // A link is not followed.
  const linked = await receiptFixture(t, healthyReceipt);
  const link = path.join(path.dirname(linked.file), "link.json");
  await symlink(linked.file, link);
  assert.equal((await openVikingBackupReadiness({ ...linked.config, openVikingBackupStateFile: link }, NOW)).code, "openviking_backup_state_invalid");
  assert.equal((await openVikingBackupReadiness({ openVikingBackupStateFile: "relative/state.json" }, NOW)).code, "openviking_backup_state_invalid");
});

test("the backup check carries the engine's copy only when the engine is the deployment's, and stays green on a notice", async (t) => {
  const { readinessBackup } = await import("../src/server.mjs");
  const directory = await scratch(t);
  const backupDir = path.join(directory, "backups");
  await mkdir(backupDir);
  const backupStateFile = path.join(backupDir, ".open-science-backup-state.json");
  await writeFile(backupStateFile, JSON.stringify({ schemaVersion: 1, status: "healthy", lastSuccessAt: new Date().toISOString(), lastDrillAt: new Date().toISOString() }));
  const { config: receipt } = await receiptFixture(t, { ...healthyReceipt, status: "failed", code: "openviking_backup_docker_failed" });
  const production = {
    production: true, backupMode: "local", backupDir, backupStateFile, dataDir: path.join(directory, "data"), backupRetentionDays: 30,
    backupPassphraseConfigured: true, restoreDrillAck: true, backupIntervalSeconds: 86_400, backupHealthGraceSeconds: 1_800, stateStore: "file", ...receipt,
  };
  const withEngine = await readinessBackup({ ...production, openVikingUrl: "http://evimed-openviking:1933", openVikingApiKey: "root-key-of-a-fixture" });
  assert.equal(withEngine.schedulerHealthy, true, "a failed engine copy made the backup check fail");
  assert.equal(withEngine.openviking.code, "openviking_backup_unhealthy");
  const withoutEngine = await readinessBackup({ ...production, openVikingUrl: "http://evimed-openviking:1933", openVikingApiKey: "root-key-of-a-fixture", memoryIndexProvider: "builtin" });
  assert.ok(!("openviking" in withoutEngine), "a deployment that pinned the term matcher was asked about an engine it does not use");
});
