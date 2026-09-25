// The private GEO method pack reaches the tree through one script, which
// verifies the archive against SHA256SUMS before unpacking anything, and never
// through git (the repository is public; build spec 2026-09-25 §0.6, §8.2).
//
// Archives are built here, in the test, so nothing of the owner's pack is read
// or needed: a fresh clone runs this file green.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = path.join(repoRoot, "scripts/build/vendor-geo-skills.mjs");
const { vendorGeoSkills, readZip, VENDOR_STAMP } = await import(pathToFileURL(script).href);

/**
 * A zip archive, deflated, the way the pack's own packer writes one.
 * @param {Record<string, string>} entries
 */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const PACK = {
  "geo-skills-3.0.0/README.md": "# the pack's own readme — not vendored\n",
  "geo-skills-3.0.0/docs/方案.md": "not vendored\n",
  "geo-skills-3.0.0/skills/geo-verify-product-label/SKILL.md": "---\nname: geo-verify-product-label\ndescription: d\n---\n# body\n",
  "geo-skills-3.0.0/skills/geo-care-nodes/SKILL.md": "---\nname: geo-care-nodes\ndescription: d\n---\n# body\n",
  "geo-skills-3.0.0/shared/references/evimed-platform.md": "# 在 EviMed 平台内运行\n",
  "geo-skills-3.0.0/shared/scripts/compute_metrics.py": "print('ok')\n",
  "geo-skills-3.0.0/shared/scripts/__pycache__/x.cpython-312.pyc": "cache",
  "geo-skills-3.0.0/shared/scripts/tests/test_core.py": "API_KEY = 'fixture'\n",
};

/** A dist directory holding one archive and its SHA256SUMS. */
async function dist(entries, { tamper = false, version = "3.0.0" } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "geo-dist-"));
  const bytes = zip(entries);
  const name = `geo-skills-${version}.zip`;
  await writeFile(path.join(dir, name), bytes);
  const sha = createHash("sha256").update(tamper ? Buffer.from("not the archive") : bytes).digest("hex");
  await writeFile(path.join(dir, "SHA256SUMS"), `${"0".repeat(64)}  geo-skills-${version}.tar.gz\n${sha}  ${name}\n`);
  return dir;
}

/** A private root holding its tracked README, as a clone has it. */
async function root() {
  const dir = await mkdtemp(path.join(tmpdir(), "geo-private-"));
  await writeFile(path.join(dir, "README.md"), "tracked readme\n");
  return dir;
}

async function tree(dir) {
  const out = [];
  const walk = async (at) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  await walk(dir);
  return out.sort();
}

test("a verified archive is unpacked — skills and shared only — and a second run changes nothing", async (t) => {
  const source = await dist(PACK);
  const target = await root();
  t.after(() => Promise.all([rm(source, { recursive: true, force: true }), rm(target, { recursive: true, force: true })]));

  const first = await vendorGeoSkills({ dist: source, target });
  assert.equal(first.status, "vendored");
  assert.deepEqual(await tree(target), [
    "README.md",
    VENDOR_STAMP,
    "shared/references/evimed-platform.md",
    "shared/scripts/compute_metrics.py",
    "skills/geo-care-nodes/SKILL.md",
    "skills/geo-verify-product-label/SKILL.md",
  ], "the pack's own README, docs, caches and test suite stay out; the tracked README stays as it was");
  assert.equal(await readFile(path.join(target, "README.md"), "utf8"), "tracked readme\n");
  const stamp = JSON.parse(await readFile(path.join(target, VENDOR_STAMP), "utf8"));
  assert.equal(stamp.version, "3.0.0");
  assert.match(stamp.sha256, /^[0-9a-f]{64}$/);

  const before = await readFile(path.join(target, VENDOR_STAMP), "utf8");
  assert.equal((await vendorGeoSkills({ dist: source, target })).status, "unchanged");
  assert.equal(await readFile(path.join(target, VENDOR_STAMP), "utf8"), before);
  assert.equal((await vendorGeoSkills({ dist: source, target, check: true })).status, "verified");
});

test("an archive whose sha256 does not match SHA256SUMS is refused before anything is written", async (t) => {
  const source = await dist(PACK, { tamper: true });
  const target = await root();
  t.after(() => Promise.all([rm(source, { recursive: true, force: true }), rm(target, { recursive: true, force: true })]));
  await assert.rejects(vendorGeoSkills({ dist: source, target }), /does not match SHA256SUMS/);
  assert.deepEqual(await tree(target), ["README.md"]);

  // And the command line says so and exits non-zero, which is what the release
  // script relies on.
  await assert.rejects(execFile(process.execPath, [script, "--dist", source, "--target", target]), (error) => {
    assert.equal(error.code, 1);
    assert.match(String(error.stderr), /does not match SHA256SUMS/);
    return true;
  });
});

test("an entry that would leave the root is refused, and a damaged entry is caught by its CRC", async (t) => {
  const source = await dist({ ...PACK, "geo-skills-3.0.0/skills/../../../escape.md": "x" });
  const target = await root();
  t.after(() => Promise.all([rm(source, { recursive: true, force: true }), rm(target, { recursive: true, force: true })]));
  await assert.rejects(vendorGeoSkills({ dist: source, target }), /would leave the root/);
  assert.equal(existsSync(path.join(target, "skills")), false);

  // One byte of the compressed body flipped: a local header is 30 bytes, then
  // the name, then the data.
  const name = "geo-skills-3.0.0/skills/a/SKILL.md";
  const damaged = zip({ [name]: "some text that deflates, long enough to have a body worth damaging" });
  damaged[30 + Buffer.byteLength(name) + 1] ^= 0xff;
  assert.throws(() => readZip(damaged));
});

test("a new version replaces the old tree whole: a skill the new pack dropped is gone", async (t) => {
  const target = await root();
  const old = await dist(PACK);
  const next = await dist({
    "geo-skills-3.1.0/skills/geo-care-nodes/SKILL.md": "---\nname: geo-care-nodes\ndescription: d2\n---\n",
    "geo-skills-3.1.0/shared/references/evimed-platform.md": "# v3.1\n",
  }, { version: "3.1.0" });
  t.after(() => Promise.all([old, next, target].map((dir) => rm(dir, { recursive: true, force: true }))));
  await vendorGeoSkills({ dist: old, target });
  assert.equal((await vendorGeoSkills({ dist: next, target })).status, "vendored");
  assert.deepEqual(await tree(target), ["README.md", VENDOR_STAMP, "shared/references/evimed-platform.md", "skills/geo-care-nodes/SKILL.md"]);
  assert.equal((await vendorGeoSkills({ dist: old, target, check: true })).status, "stale");
});

test("with two versions shipped side by side, the newest one present is taken, and a version can be pinned", async (t) => {
  // The owner ships a new version beside the old one (3.0.1 beside 3.0.0,
  // 2026-09-25), with both in SHA256SUMS.
  const dir = await mkdtemp(path.join(tmpdir(), "geo-dist-two-"));
  const target = await root();
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(target, { recursive: true, force: true })]));
  const archives = {
    "3.0.0": zip({ "geo-skills-3.0.0/skills/geo-care-nodes/SKILL.md": "---\nname: geo-care-nodes\ndescription: old\n---\n" }),
    "3.0.1": zip({ "geo-skills-3.0.1/skills/geo-care-nodes/SKILL.md": "---\nname: geo-care-nodes\ndescription: new\n---\n" }),
    "3.1.0": zip({ "geo-skills-3.1.0/skills/geo-care-nodes/SKILL.md": "---\nname: geo-care-nodes\ndescription: listed, not shipped\n---\n" }),
  };
  const sums = Object.entries(archives).map(([version, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  geo-skills-${version}.zip`).join("\n");
  await writeFile(path.join(dir, "SHA256SUMS"), `${sums}\n`);
  await writeFile(path.join(dir, "geo-skills-3.0.0.zip"), archives["3.0.0"]);
  await writeFile(path.join(dir, "geo-skills-3.0.1.zip"), archives["3.0.1"]);

  const newest = await vendorGeoSkills({ dist: dir, target });
  assert.equal(newest.version, "3.0.1", "3.1.0 is listed but not in the directory; 3.0.1 is the newest present");
  assert.match(await readFile(path.join(target, "skills/geo-care-nodes/SKILL.md"), "utf8"), /description: new/);

  const pinned = await vendorGeoSkills({ dist: dir, target, version: "3.0.0" });
  assert.equal(pinned.status, "vendored");
  assert.match(await readFile(path.join(target, "skills/geo-care-nodes/SKILL.md"), "utf8"), /description: old/);
  await assert.rejects(vendorGeoSkills({ dist: dir, target, version: "3.1.0" }), /not in/);
});

test("the repository tracks only the root's README, and the image copies the root as a skill root", async () => {
  // The negative half of the rule: whatever a build machine vendored, git
  // sees one file here. Asked of git, not of a pattern in .gitignore.
  let tracked = null;
  let ignored = null;
  try {
    tracked = execFileSync("git", ["ls-files", "runtime/skills/geo-private"], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
    ignored = execFileSync("git", ["check-ignore", "runtime/skills/geo-private/skills/x/SKILL.md", "runtime/skills/geo-private/shared/rules/catalogue.yaml", `runtime/skills/geo-private/${VENDOR_STAMP}`], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return; // no git on this machine: nothing to ask
    throw error;
  }
  // The README may still be uncommitted on a working branch; nothing else may
  // ever be tracked.
  assert.ok(tracked.every((file) => file === "runtime/skills/geo-private/README.md"), `tracked: ${tracked.join(", ")}`);
  assert.equal(ignored.length, 3, "every vendored path must be ignored");
  assert.ok(existsSync(path.join(repoRoot, "runtime/skills/geo-private/README.md")), "the README keeps the root present in a clone");

  const dockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  const delta = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile.delta"), "utf8");
  const agentbay = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile.agentbay"), "utf8");
  const install = await readFile(path.join(repoRoot, "deploy/runtime-dsh/install-runtime.sh"), "utf8");
  const preset = await readFile(path.join(repoRoot, "packages/socket/presets/evimed-universal/agent.cordis.yml"), "utf8");
  for (const [name, text] of [["Dockerfile", dockerfile], ["Dockerfile.delta", delta], ["Dockerfile.agentbay", agentbay]]) {
    assert.match(text, /^COPY runtime\/skills\/geo-private \/opt\/evimed\/skills\/geo-private$/m, `${name} does not copy the private root`);
  }
  assert.match(install, /cp -a \/opt\/evimed\/skills\/geo-private \/opt\/evimed\/socket\/presets\/evimed-universal\/skills\/geo-private/);
  assert.match(delta, /cp -a \/opt\/evimed\/skills\/geo-private \/opt\/evimed\/socket\/presets\/evimed-universal\/skills\/geo-private/);
  assert.match(preset, /EVIMED_PRESET_SKILLS_DIR \+ '\/geo-private\/skills'/);
});

test("with the private root holding only its README, the GEO capabilities still load and name the fallback", async () => {
  // What a fresh clone ships: the capabilities are the platform's, the method
  // pack is not, and each skill says what a run does without it.
  const { validateCapabilityManifest } = await import("@evimed/domain");
  for (const id of ["geo-insight", "geo-strategy", "geo-content", "geo-proposal"]) {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "deploy/runtime-dsh/capabilities", `${id}.json`), "utf8"));
    assert.equal(validateCapabilityManifest(manifest).ok, true, id);
    assert.ok(!manifest.skills.some((skill) => skill.startsWith("geo-") && skill !== id), `${id} names a private skill in skills[]; only repository skills belong there`);
    const body = await readFile(path.join(repoRoot, "capability-skills", id, "SKILL.md"), "utf8");
    assert.match(body, /本部署未安装 GEO 方法包/, `${id} does not say what happens without the method pack`);
    assert.match(body, /\$GEO_LIB/, `${id} does not say where the pack's shared layer is`);
  }
  // The skills a capability body tells the run to load are skills the pack
  // ships — asked of the vendored tree only where one exists.
  const vendored = path.join(repoRoot, "runtime/skills/geo-private/skills");
  if (!existsSync(vendored)) return;
  const shipped = new Set(await readdir(vendored));
  for (const id of ["geo-insight", "geo-strategy", "geo-content", "geo-proposal"]) {
    const body = await readFile(path.join(repoRoot, "capability-skills", id, "SKILL.md"), "utf8");
    const named = [...body.matchAll(/`((?:geo|patient|pharma)-[a-z0-9-]+)`/g)].map((match) => match[1])
      .filter((name) => !["geo-private", "geo-insight", "geo-strategy", "geo-content", "geo-proposal"].includes(name));
    assert.ok(named.length >= 3, `${id} names ${named.length} method skills`);
    const missing = named.filter((name) => !shipped.has(name));
    assert.deepEqual(missing, [], `${id} names method skills the vendored pack does not have`);
  }
});

test("the release script is not part of the repository; the vendored root is what it must carry", async () => {
  // A static guard on what the release depends on: the image COPYs the root,
  // and only the script knows the archive. Nothing in the repository may refer
  // to the owner's archive by a path inside the repository.
  const source = await readFile(script, "utf8");
  assert.match(source, /\.evimed-local\/geo\/dist/);
  assert.doesNotMatch(source, /runtime\/skills\/geo-private\/(skills|shared)\/[a-z]/, "the script names no file of the pack");
  const tmp = await mkdtemp(path.join(tmpdir(), "geo-empty-"));
  await mkdir(path.join(tmp, "dist"));
  await assert.rejects(vendorGeoSkills({ dist: path.join(tmp, "dist"), target: path.join(tmp, "root") }), /no SHA256SUMS/);
  await rm(tmp, { recursive: true, force: true });
});
