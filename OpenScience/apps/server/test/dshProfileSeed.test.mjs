import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";

const profileName = "evimed-runtime";
const helperUrl = new URL("../../../deploy/runtime-dsh/profile-seed.mjs", import.meta.url);
const publishedSocket = JSON.parse(readFileSync(new URL("../../../packages/socket/package.json", import.meta.url), "utf8"));

// Actual pnpm file: materialization, matching the image's dsh plugin forwarding
// path and the rc.1 dsh-app-boot initProfile manifest/user-patch layout.
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "profile-seed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [new URL("../../../packages/socket/scripts/build-client.mjs", import.meta.url).pathname], { stdio: "pipe" });
  const pkg = (dir, name, client) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.1.0", exports: { "./package.json": "./package.json", ...(client ? { "./client": "./dist/client.js" } : {}) }, dsh: client ? publishedSocket.dsh : { bundle: { patch: "./cordis.patch.yml" } } }));
    writeFileSync(path.join(dir, "cordis.patch.yml"), "[]\n");
    if (client) {
      mkdirSync(path.join(dir, "dist"));
      copyFileSync(new URL("../../../packages/socket/dist/client.js", import.meta.url), path.join(dir, "dist/client.js"));
    }
  };
  pkg(path.join(root, "old-socket"), "@evimed/dsh-socket", false);
  pkg(path.join(root, "new-socket"), "@evimed/dsh-socket", true);
  pkg(path.join(root, "user-plugin"), "user-plugin", false);
  const install = (home, source, userPlugin = false) => {
    const profile = path.join(home, "profiles", profileName);
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-evimed-runtime", private: true, dependencies: {}, dsh: { profile: { bundles: userPlugin ? ["user-plugin", "@evimed/dsh-socket"] : ["@evimed/dsh-socket"], patchReload: "startup" } } }));
    writeFileSync(path.join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\n");
    const args = ["add", "--offline", "--ignore-scripts", `file:${source}`];
    if (userPlugin) args.push(`file:${path.join(root, "user-plugin")}`);
    execFileSync("pnpm", args, { cwd: profile, stdio: "pipe", env: { ...process.env, CI: "1" } });
    return profile;
  };
  const home = path.join(root, "project");
  const profile = install(home, path.join(root, "old-socket"), true);
  const seed = path.join(root, "image-v2");
  const seedProfile = install(seed, path.join(root, "new-socket"));
  const userPatch = "- id: user-entry\n  name: user-plugin\n  config:\n    preference: keep-me\n";
  writeFileSync(path.join(profile, "cordis.patch.yml"), userPatch);
  writeFileSync(path.join(profile, "session-state.json"), '{"session":"keep-session"}');
  writeFileSync(path.join(home, ".credentials.yaml"), "private-runtime-placeholder");
  writeFileSync(path.join(seed, ".credentials.yaml"), "never-copy-seed-credentials");
  assert.ok(lstatSync(path.join(profile, "node_modules/@evimed/dsh-socket")).isSymbolicLink());
  assert.ok(!readMeta(profile).dsh.client, "fixture is the old pnpm file: package copied into its profile store");
  return { root, home, profile, seed, seedProfile, userPatch };
}
const readMeta = (profile) => JSON.parse(readFileSync(path.join(profile, "node_modules/@evimed/dsh-socket/package.json"), "utf8"));

test("an actual existing pnpm file profile receives the new client face without changing user state", async (t) => {
  const f = fixture(t);
  const { sealProfileSeed, migrateProfileSeed } = await import(helperUrl);
  const protectedFiles = ["cordis.patch.yml", "pnpm-workspace.yaml", "pnpm-lock.yaml", "session-state.json"].map(name => [name, readFileSync(path.join(f.profile, name))]);
  const userLink = readlinkSync(path.join(f.profile, "node_modules/user-plugin"));
  const probe = () => JSON.parse(execFileSync(process.execPath, [new URL("../../../packages/harness-port/test/helpers/runtimeUiProfileProbe.mjs", import.meta.url).pathname, f.profile], { encoding: "utf8" }));
  assert.equal(probe().discovered, false, "published scanner must observe the old persistent package");
  const seal = sealProfileSeed(f.seed, profileName);
  assert.match(seal.digest, /^[a-f0-9]{64}$/);
  assert.equal(migrateProfileSeed(f.seed, f.home, profileName).changed, true);
  assert.deepEqual(readMeta(f.profile).dsh.client, publishedSocket.dsh.client);
  assert.equal(probe().discovered, true);
  assert.equal(probe().bootGraphIncludesClient, true);
  for (const [name, bytes] of protectedFiles) assert.deepEqual(readFileSync(path.join(f.profile, name)), bytes);
  assert.equal(readlinkSync(path.join(f.profile, "node_modules/user-plugin")), userLink);
  assert.equal(readFileSync(path.join(f.home, ".credentials.yaml"), "utf8"), "private-runtime-placeholder");
  const manifest = JSON.parse(readFileSync(path.join(f.profile, "package.json"), "utf8"));
  assert.deepEqual(manifest.dsh.profile.bundles, ["user-plugin", "@evimed/dsh-socket"]);
  const before = lstatSync(path.join(f.profile, ".evimed-seed.json")).mtimeMs;
  assert.equal(migrateProfileSeed(f.seed, f.home, profileName).changed, false);
  assert.equal(lstatSync(path.join(f.profile, ".evimed-seed.json")).mtimeMs, before);
});

test("fresh initialization copies no home credentials and an older image can restore its own package generation", async (t) => {
  const f = fixture(t);
  const { sealProfileSeed, migrateProfileSeed } = await import(helperUrl);
  sealProfileSeed(f.seed, profileName);
  const fresh = path.join(f.root, "fresh");
  migrateProfileSeed(f.seed, fresh, profileName);
  assert.ok(readMeta(path.join(fresh, "profiles", profileName)).dsh.client);
  assert.equal(existsSync(path.join(fresh, ".credentials.yaml")), false);
  const oldSeed = path.join(f.root, "image-v1");
  cpSync(f.home, oldSeed, { recursive: true, dereference: false, verbatimSymlinks: true });
  sealProfileSeed(oldSeed, profileName);
  migrateProfileSeed(f.seed, f.home, profileName);
  migrateProfileSeed(oldSeed, f.home, profileName);
  assert.equal(readMeta(f.profile).dsh.client, undefined);
  assert.equal(readFileSync(path.join(f.profile, "cordis.patch.yml"), "utf8"), f.userPatch);
});

test("interrupted journal migration rolls back before retrying the new image", async (t) => {
  const f = fixture(t);
  const { sealProfileSeed, migrateProfileSeed } = await import(helperUrl);
  sealProfileSeed(f.seed, profileName);
  assert.throws(() => migrateProfileSeed(f.seed, f.home, profileName, { checkpoint(step) { if (step === "installed:0") throw new Error("simulated interruption"); } }), /interruption/);
  assert.ok(existsSync(path.join(f.profile, ".evimed-seed-journal/journal.json")));
  assert.equal(migrateProfileSeed(f.seed, f.home, profileName).changed, true);
  assert.ok(readMeta(f.profile).dsh.client);
  assert.equal(existsSync(path.join(f.profile, ".evimed-seed-journal")), false);
  assert.equal(readFileSync(path.join(f.profile, "session-state.json"), "utf8"), '{"session":"keep-session"}');
});

test("dirty or escaping migration journals fail closed without touching credentials", async (t) => {
  const f = fixture(t);
  const { sealProfileSeed, migrateProfileSeed } = await import(helperUrl);
  sealProfileSeed(f.seed, profileName);
  const journal = path.join(f.profile, ".evimed-seed-journal");
  mkdirSync(journal);
  mkdirSync(path.join(journal, "backup")); mkdirSync(path.join(journal, "stage"));
  writeFileSync(path.join(journal, "journal.json"), JSON.stringify({ version: 1, operations: [{ target: "../../.credentials.yaml" }] }));
  assert.throws(() => migrateProfileSeed(f.seed, f.home, profileName), /journal/i);
  assert.equal(readFileSync(path.join(f.home, ".credentials.yaml"), "utf8"), "private-runtime-placeholder");
  assert.ok(!readMeta(f.profile).dsh.client);
});

test("managed package parent symlinks cannot redirect profile migration into another directory", async (t) => {
  const f = fixture(t);
  const { sealProfileSeed, migrateProfileSeed } = await import(helperUrl);
  sealProfileSeed(f.seed, profileName);
  const scope = path.join(f.profile, "node_modules/@evimed");
  const outside = path.join(f.root, "outside");
  mkdirSync(outside); rmSync(scope, { recursive: true }); symlinkSync(outside, scope);
  assert.throws(() => migrateProfileSeed(f.seed, f.home, profileName), /symlink|directory/i);
  assert.deepEqual(readdirSync(outside), []);
});

test("pre-publication interruptions discard only staged files and dirty installed links refuse recovery", async (t) => {
  const f = fixture(t);
  const { sealProfileSeed, migrateProfileSeed } = await import(helperUrl);
  sealProfileSeed(f.seed, profileName);
  assert.throws(() => migrateProfileSeed(f.seed, f.home, profileName, { checkpoint(step) { if (step === "prepared") throw new Error("interrupted preparation"); } }), /interrupted/);
  assert.equal(readMeta(f.profile).dsh.client, undefined);
  migrateProfileSeed(f.seed, f.home, profileName);
  assert.equal(existsSync(path.join(f.profile, ".evimed-seed-staging")), false);
  // Force a new generation and interrupt after installation but before commit.
  writeFileSync(path.join(f.seedProfile, "extra-unmanaged-file"), "not part of the digest");
  writeFileSync(path.join(f.seedProfile, "node_modules/.fixture-generation"), "next");
  sealProfileSeed(f.seed, profileName);
  assert.throws(() => migrateProfileSeed(f.seed, f.home, profileName, { checkpoint(step) { if (step === "installed:0") throw new Error("interrupted installation"); } }), /interrupted/);
  const link = path.join(f.profile, "node_modules/@evimed/dsh-socket");
  assert.ok(lstatSync(link).isSymbolicLink());
  unlinkSync(link); symlinkSync(path.join(f.root, "unrelated"), link);
  assert.throws(() => migrateProfileSeed(f.seed, f.home, profileName), /dirty journal/);
  assert.equal(readlinkSync(link), path.join(f.root, "unrelated"));
  assert.equal(readFileSync(path.join(f.home, ".credentials.yaml"), "utf8"), "private-runtime-placeholder");
});

test("the actual runtime entrypoint invokes digest migration for existing and fresh profiles", async (t) => {
  const f = fixture(t);
  const { sealProfileSeed } = await import(helperUrl);
  sealProfileSeed(f.seed, profileName);
  const entrypoint = readFileSync(new URL("../../../deploy/runtime-dsh/open-science-dsh-serve.sh", import.meta.url), "utf8").split("# Telemetry off")[0];
  // flock is supplied by util-linux in the Linux image. This host fixture runs
  // the real pre-boot script sequentially while preserving its helper call.
  const boot = `flock() { shift; shift; "$@"; };\n${entrypoint.replace("/usr/local/bin/evimed-profile-seed.mjs", helperUrl.pathname)}`;
  for (const home of [f.home, path.join(f.root, "fresh-boot")]) {
    execFileSync("bash", ["-c", boot], { env: { ...process.env, DSH_HOME: home, DSH_HOME_SEED: f.seed, OPEN_SCIENCE_RUNTIME_SOCKET: path.join(f.root, "control/dsh.sock") }, stdio: "pipe" });
    assert.ok(readMeta(path.join(home, "profiles", profileName)).dsh.client);
    assert.notEqual(existsSync(path.join(home, ".credentials.yaml")) && readFileSync(path.join(home, ".credentials.yaml"), "utf8"), "never-copy-seed-credentials");
  }
});


test("a killed migration process recovers its journal on the next boot", async (t) => {
  const f = fixture(t);
  const { sealProfileSeed, migrateProfileSeed } = await import(helperUrl);
  sealProfileSeed(f.seed, profileName);
  const script = `import {migrateProfileSeed} from ${JSON.stringify(helperUrl.href)}; migrateProfileSeed(${JSON.stringify(f.seed)}, ${JSON.stringify(f.home)}, ${JSON.stringify(profileName)}, {checkpoint(step) {if (step === "backed-up:0") process.kill(process.pid, "SIGKILL");}});`;
  assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" }), error => error.signal === "SIGKILL");
  assert.equal(migrateProfileSeed(f.seed, f.home, profileName).changed, true);
  assert.ok(readMeta(f.profile).dsh.client);
  assert.equal(readFileSync(path.join(f.profile, "cordis.patch.yml"), "utf8"), f.userPatch);
  assert.equal(existsSync(path.join(f.profile, ".evimed-seed-journal")), false);
});

test("Linux flock serializes the real helper against a read-only image seed", { skip: !process.env.EVIMED_PROFILE_MIGRATION_DOCKER_IMAGE, timeout: 30000 }, async (t) => {
  const f = fixture(t);
  const { sealProfileSeed } = await import(helperUrl);
  sealProfileSeed(f.seed, profileName);
  const script = `
    import {execFileSync, spawn} from 'node:child_process';
    import {readFileSync, statSync} from 'node:fs';
    const args=['-x','/project/.evimed-seed.lock','node','/migration.mjs','sync','/image-seed','/project','evimed-runtime'];
    execFileSync('flock', args);
    const marker='/project/profiles/evimed-runtime/.evimed-seed.json';
    const before=statSync(marker).mtimeMs;
    await Promise.all([1,2].map(()=>new Promise((resolve,reject)=>{
      const child=spawn('flock',args,{stdio:'inherit'});
      child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('migration failed')));
    })));
    const pkg=JSON.parse(readFileSync('/project/profiles/evimed-runtime/node_modules/@evimed/dsh-socket/package.json','utf8'));
    process.stdout.write(JSON.stringify({nativeClient:Boolean(pkg.dsh.client),unchanged:statSync(marker).mtimeMs===before}));
  `;
  const result = execFileSync("docker", ["run", "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL",
    "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    "--mount", `type=bind,src=${f.seed},dst=/image-seed,readonly`,
    "--mount", `type=bind,src=${f.home},dst=/project`,
    "--mount", `type=bind,src=${helperUrl.pathname},dst=/migration.mjs,readonly`,
    "--entrypoint", "node", process.env.EVIMED_PROFILE_MIGRATION_DOCKER_IMAGE, "--input-type=module", "-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.deepEqual(JSON.parse(result), { nativeClient: true, unchanged: true });
  assert.equal(readFileSync(path.join(f.profile, "cordis.patch.yml"), "utf8"), f.userPatch);
});
