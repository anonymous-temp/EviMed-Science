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
const { GEO_PACK_INDEX_FILE, buildGeoPackIndex, geoPackIndexIsCurrent } = await import(pathToFileURL(path.join(repoRoot, "scripts/build/geo-pack-index.mjs")).href);

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
    GEO_PACK_INDEX_FILE,
    "shared/references/evimed-platform.md",
    "shared/scripts/compute_metrics.py",
    "skills/geo-care-nodes/SKILL.md",
    "skills/geo-verify-product-label/SKILL.md",
  ], "the pack's own README, docs, caches and test suite stay out, the index is written beside the pack; the tracked README stays as it was");
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
  assert.deepEqual(await tree(target), ["README.md", VENDOR_STAMP, GEO_PACK_INDEX_FILE, "shared/references/evimed-platform.md", "skills/geo-care-nodes/SKILL.md"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(target, GEO_PACK_INDEX_FILE), "utf8")).skills.map((skill) => skill.name), ["geo-care-nodes"],
    "the index follows the tree: a skill the new pack dropped is not listed");
  assert.equal((await vendorGeoSkills({ dist: old, target, check: true })).status, "stale");
});

test("the index holds each skill's name and the first sentence of its description and nothing of its body", async (t) => {
  // The web image carries this file and none of the pack (R19, runtime inventory): the skills page lists the method pack from it, so it
  // must be enough to say what a skill is for and must never be a way to read one.
  const source = await dist({
    "geo-skills-3.0.0/skills/geo-care-nodes/SKILL.md": "---\nname: geo-care-nodes\ndescription: Maps the nodes of a patient's care pathway. Then writes one card per node, which the page never shows.\n---\n# the body text, which the index must not hold\n",
    "geo-skills-3.0.0/skills/geo-verify-product-label/SKILL.md": "---\nname: Verify the product label\ndescription: Checks the claim against the label.\n---\n# another body\n",
    "geo-skills-3.0.0/shared/references/evimed-platform.md": "# a shared reference the index must not hold\n",
  });
  const target = await root();
  t.after(() => Promise.all([rm(source, { recursive: true, force: true }), rm(target, { recursive: true, force: true })]));

  await vendorGeoSkills({ dist: source, target });
  const text = await readFile(path.join(target, GEO_PACK_INDEX_FILE), "utf8");
  const index = JSON.parse(text);
  assert.equal(index.package, "geo-skills");
  assert.equal(index.version, "3.0.0");
  assert.deepEqual(index.skills, [
    { name: "geo-care-nodes", title: "geo-care-nodes", use: "Maps the nodes of a patient's care pathway." },
    { name: "geo-verify-product-label", title: "Verify the product label", use: "Checks the claim against the label." },
  ]);
  assert.doesNotMatch(text, /body text|another body|shared reference|which the page never shows/, "nothing of a body, a reference or a second sentence");
  assert.equal(await geoPackIndexIsCurrent(target), true);
  assert.equal((await vendorGeoSkills({ dist: source, target, check: true })).status, "verified");

  // A root vendored before the index existed is stale for the release's check and mended by the one `--index` step the web image runs.
  await rm(path.join(target, GEO_PACK_INDEX_FILE));
  assert.equal((await vendorGeoSkills({ dist: source, target, check: true })).status, "stale");
  const written = await execFile(process.execPath, [script, "--index", "--target", target]);
  assert.match(written.stdout, /written: .*geo-pack-index\.json \(2 skills\)/);
  assert.equal((await vendorGeoSkills({ dist: source, target, check: true })).status, "verified");

  // A tree with no pack gets an index of no skills, so the image's one COPY of it never fails and the group is not drawn.
  const bare = await root();
  t.after(() => rm(bare, { recursive: true, force: true }));
  assert.deepEqual((await buildGeoPackIndex(bare)).skills, []);
  await execFile(process.execPath, [script, "--index", "--target", bare]);
  assert.deepEqual(JSON.parse(await readFile(path.join(bare, GEO_PACK_INDEX_FILE), "utf8")).skills, []);
});

test("the web image carries the pack's index and not the pack", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/web/Dockerfile"), "utf8");
  const copies = dockerfile.split("\n").filter((line) => /^COPY\b/.test(line) && /geo-private/.test(line));
  assert.deepEqual(copies, ["COPY --from=build /app/runtime/skills/geo-private/geo-pack-index.json ./runtime/skills/geo-private/geo-pack-index.json"],
    "one COPY names the private root, and it names the index file");
  assert.match(dockerfile, /^RUN node scripts\/build\/vendor-geo-skills\.mjs --index$/m, "the build stage writes the index it copies, from the pack the context holds or from none");
  const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
  assert.doesNotMatch(runtime, /runtime\/skills\/geo-private\/(skills|shared)/, "no skill, rule or script of the pack reaches the web image");
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
  const repositorySkills = new Set((await readdir(path.join(repoRoot, "capability-skills")))
    .filter((name) => existsSync(path.join(repoRoot, "capability-skills", name, "SKILL.md"))));
  for (const id of ["geo-insight", "geo-strategy", "geo-content", "geo-proposal"]) {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "deploy/runtime-dsh/capabilities", `${id}.json`), "utf8"));
    assert.equal(validateCapabilityManifest(manifest).ok, true, id);
    assert.ok(manifest.skills.includes("geo-drug-value"), `${id} must load the shared drug-value method`);
    assert.ok(!manifest.skills.some((skill) => skill.startsWith("geo-") && !repositorySkills.has(skill)), `${id} names a private skill in skills[]; only repository skills belong there`);
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
      .filter((name) => name !== "geo-private" && !repositorySkills.has(name));
    assert.ok(named.length >= 3, `${id} names ${named.length} method skills`);
    const missing = named.filter((name) => !shipped.has(name));
    assert.deepEqual(missing, [], `${id} names method skills the vendored pack does not have`);
  }
});

test("no GEO skill asks a run to write a placement plan while no part of the market reads one; the tool and the table stay (G10g)", async () => {
  // The strategy skill used to list `placement_plan` — preferred layers and outlets, "a proposal; the control plane decides" — and the
  // market never read it (review M-5): a run spent an answer on a preference nobody weighed. The owner ruled on 2026-10-10 that the skill
  // stops asking until the market reads it. The tool, its vocabulary and its table are untouched, so the day the market ranks by it the
  // skill can ask again; this is the test to change then.
  const ids = ["geo-insight", "geo-strategy", "geo-content", "geo-proposal"];
  for (const directory of ["capabilities", "capability-skills"]) {
    for (const id of ids) {
      const body = await readFile(path.join(repoRoot, directory, id, "SKILL.md"), "utf8");
      assert.doesNotMatch(body, /placement[_ ]plan/i, `${directory}/${id}/SKILL.md asks for a placement plan`);
    }
  }
  const { GEO_WRITE_WHATS } = await import("@evimed/domain");
  assert.ok(GEO_WRITE_WHATS.includes("placement_plan"), "the tool still takes a placement plan");
  const read = /placement_?plan|latestPlacementPlan/i;
  for (const file of ["geoMarket.mjs", "geoMarketStore.mjs", "geoMarketOperations.mjs", "geoMarketText.mjs"]) {
    assert.doesNotMatch(await readFile(path.join(repoRoot, "apps/server/src", file), "utf8"), read,
      `${file} reads a placement plan: the strategy skill can ask a run for one again`);
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
