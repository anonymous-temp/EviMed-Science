// The CI that runs 「虚拟临研」's engine-backed tests, held to what it claims.
//
// CI cannot be run from here, so what can be checked is checked: that the jobs
// are wired to one R library, that the tests which need R are the ones the
// generic durable-state step leaves out and the engine job runs, that a missing
// R is a failure rather than a skip, that every file a step names exists, and
// that the scripts the steps call do what their comments say. A workflow that
// parses is not a workflow that works; the last time this module's CI was
// written, the two tests that need R ran in a step with no R, skipped, and read
// as green.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { ENGINE_BACKED_INTEGRATION_TESTS, productIntegrationTests } from "../../../scripts/ops/test-product-state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const openScience = path.resolve(HERE, "../../..");
const repoRoot = path.resolve(openScience, "..");
const engineRoot = path.join(repoRoot, "项目代码", "vcr-engine");
const testDir = path.join(openScience, "apps/server/test");

/** @returns {Promise<any>} */
const workflow = async () => parse(await readFile(path.join(repoRoot, ".github/workflows/web.yml"), "utf8"));
/** Every shell script a job runs, in order. @param {any} job */
const scriptsOf = (job) => job.steps.map((/** @type {any} */ step) => step.run ?? "").join("\n");
/** @param {string} file */
const exists = (file) => access(file).then(() => true, () => false);

test("the tests that need the engine's R and Python are exactly the ones the durable-state step leaves out", async () => {
  const files = (await readdir(testDir)).filter((name) => name.endsWith(".integration.test.mjs"));
  // The walk has to have walked: a directory that read as empty would find no
  // engine-backed test and pass.
  assert.ok(files.length > 50, `only ${files.length} integration tests were found`);
  const needsEngine = [];
  for (const name of files) {
    const source = await readFile(path.join(testDir, name), "utf8");
    if (/Rscript|uvicorn|run_job\.R/.test(source)) needsEngine.push(name);
  }
  assert.deepEqual(needsEngine.sort(), [...ENGINE_BACKED_INTEGRATION_TESTS].sort(),
    "an integration test that starts R or the service belongs in ENGINE_BACKED_INTEGRATION_TESTS, and only such a test does");
  const generic = productIntegrationTests().map((file) => path.basename(file));
  for (const name of ENGINE_BACKED_INTEGRATION_TESTS) {
    assert.ok(files.includes(name), `${name} is named but does not exist`);
    assert.ok(!generic.includes(name), `${name} would run in the step that has no R`);
  }
  assert.ok(generic.length >= files.length - ENGINE_BACKED_INTEGRATION_TESTS.length - 1, "everything else still runs there");

  // And they run where R is: the seam job names each of them, and nothing else.
  const seam = (await workflow()).jobs["vcr-seam"];
  assert.ok(seam, "the workflow has no vcr-seam job");
  const step = seam.steps.find((/** @type {any} */ entry) => entry.name === "Test the control plane against the real engine");
  assert.ok(step?.run, "no step runs the engine-backed tests");
  const named = [...String(step.run).matchAll(/apps\/server\/test\/(\S+\.test\.mjs)/g)].map((match) => match[1]);
  assert.deepEqual(named.sort(), [...ENGINE_BACKED_INTEGRATION_TESTS].sort());
  assert.match(step.env.OPEN_SCIENCE_TEST_POSTGRES_URL, /^postgresql:\/\/postgres@127\.0\.0\.1:5432\/evimed_test/, "a loopback test database the tests accept");
  assert.equal(seam.env.OPEN_SCIENCE_TEST_RESULT_ENGINES, "1");
  assert.equal(seam.env.EVIMED_RESULT_REPLAY_SIGNED_VCR, "1");
  assert.match(step.run, /skipped 0/, "the required numerical proof cannot appear green by skipping itself");
  assert.match(step.run, /receipt.*signed/, "the R proof must verify signed HTTP receipts");
  const python = seam.steps.find(entry => entry.name === "Install the fixed Python numerical replay environment from existing locks");
  assert.ok(python, "the deterministic Python engines need their existing pinned numerical environment");
  assert.match(python.run, /specialist-adapter\/requirements\.lock/);
  assert.match(python.run, /meta\/requirements\.lock/);
  assert.match(python.run, /文献剂量分析\/requirements\.lock/);
  const receipts = seam.steps.find(entry => entry.name === "Preserve five-path numerical replay receipts and log");
  assert.equal(receipts?.if, "always()"); assert.equal(receipts?.with?.["if-no-files-found"], "error");
});

test("the three engine jobs are wired to one R library, and a missing R is a red job rather than a skipped test", async () => {
  const jobs = (await workflow()).jobs;
  const library = jobs["vcr-r-library"];
  assert.ok(library && jobs["vcr-engine"] && jobs["vcr-seam"], "the workflow lacks one of vcr-r-library, vcr-engine, vcr-seam");
  assert.ok(library.outputs.key, "the library job publishes the key its cache is under");
  for (const name of ["vcr-engine", "vcr-seam"]) {
    const job = jobs[name];
    assert.equal(job.needs, "vcr-r-library", `${name} must wait for the library`);
    assert.equal(job.env.VCR_ENGINE_TESTS, "required", `${name}: without this a missing R skips the tests that need it`);
    const restore = job.steps.find((/** @type {any} */ step) => String(step.uses ?? "").startsWith("actions/cache/restore@"));
    assert.ok(restore, `${name} does not restore the library`);
    assert.equal(restore.with.key, "${{ needs.vcr-r-library.outputs.key }}", `${name} must read the key the library job published, not compute its own`);
    assert.equal(restore.with["fail-on-cache-miss"], true, `${name}: a miss here means the library job did not save it`);
    assert.match(scriptsOf(job), /r-library\.sh verify/, `${name} must prove the restored library is the locks`);
    assert.match(scriptsOf(job), /ci-system-deps\.sh/, `${name} installs R itself`);
  }
  for (const job of [library, jobs["vcr-engine"], jobs["vcr-seam"]]) {
    assert.equal(job.env.VCR_R_LIBS, "${{ github.workspace }}/.vcr-rlib", "one library path, from the workflow's own workspace");
    assert.match(job["runs-on"], /^ubuntu-24\.04$/, "the image whose own R is the one the locks name");
  }
  // Built once, saved only on a miss, and saved before any test can fail.
  const save = library.steps.find((/** @type {any} */ step) => String(step.uses ?? "").startsWith("actions/cache/save@"));
  assert.ok(save && save.if === "steps.restore.outputs.cache-hit != 'true'");
  assert.equal(save.with.key, "${{ steps.key.outputs.key }}");
  const text = await readFile(path.join(repoRoot, ".github/workflows/web.yml"), "utf8");
  assert.ok(!/\/home\/[a-z]+\//.test(text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n")), "no machine path in a step");
  assert.ok(!/VCR_TEST_ONLY/.test(text), "the numeric run is the whole suite");
});

test("the engine job runs every numeric case, fails with the suite, and checks that a green run was whole", async () => {
  const job = (await workflow()).jobs["vcr-engine"];
  const names = job.steps.map((/** @type {any} */ step) => step.name);
  const run = names.indexOf("Run every numeric acceptance case");
  const check = names.indexOf("Check the run was whole");
  const service = names.indexOf("Test the engine service");
  assert.ok(run >= 0 && check > run && service > check, `the steps are ${JSON.stringify(names)}`);
  assert.match(job.steps[run].run, /bash tests\/run_all\.sh/);
  assert.equal(job.steps[run].shell, "bash", "the default shell has no pipefail, so `| tee` would hide a failing suite");
  assert.equal(job.steps[run]["working-directory"], "项目代码/vcr-engine");
  assert.match(job.steps[check].run, /check-numeric-log\.sh "\$RUNNER_TEMP\/vcr-numeric\.log"/);
  assert.equal(job.steps[service].shell, "bash");
  assert.match(job.steps[service].run, /pytest tests\/service/);
  assert.match(job.steps[service].run, /SKIPPED\.\*\(Rscript\|R library\)/, "the service's smoke test may not skip itself silently");
  // Node and Python are installed before the cases that need them.
  const node = names.indexOf("Install Node");
  const python = names.indexOf("Install the engine service's Python requirements");
  assert.ok(node >= 0 && node < run && python >= 0 && python < run);
  assert.match(job.steps[python].run, /requirements\.txt pytest==\S+ httpx==\S+/, "the service's requirements, and the two test-only packages, pinned");
});

test("every repository file a vcr step runs exists, and the seam job's database is the production image", async () => {
  const value = await workflow();
  for (const name of ["vcr-r-library", "vcr-engine", "vcr-seam"]) {
    const job = value.jobs[name];
    const script = scriptsOf(job);
    const referenced = new Set([...script.matchAll(/scripts\/vcr\/[\w.-]+/g)].map((match) => path.join(openScience, match[0])));
    for (const match of script.matchAll(/(?:\.\.\/)?(项目代码\/vcr-engine\/[\w./-]+)/g)) referenced.add(path.join(repoRoot, match[1]));
    if (/bash tests\/run_all\.sh/.test(script)) referenced.add(path.join(engineRoot, "tests/run_all.sh"));
    if (/pytest tests\/service/.test(script)) referenced.add(path.join(engineRoot, "tests/service/test_service.py"));
    assert.ok(referenced.size > 0, `${name} names no repository file: the scan read nothing`);
    for (const file of referenced) assert.ok(await exists(file), `${name} runs ${path.relative(repoRoot, file)}, which does not exist`);
    for (const step of job.steps) {
      const directory = step["working-directory"];
      if (directory) assert.ok(await exists(path.join(repoRoot, directory)), `${name}: ${directory} does not exist`);
      const cache = step.with?.["cache-dependency-path"];
      if (cache && !cache.startsWith("OpenScience/")) assert.ok(await exists(path.join(repoRoot, cache)), `${name}: ${cache} does not exist`);
    }
  }
  const web = value.jobs.web.services.postgres;
  const seam = value.jobs["vcr-seam"].services.postgres;
  assert.equal(seam.image, web.image, "the same PostgreSQL the web job tests against");
  assert.match(seam.env.POSTGRES_DB, /^evimed_test/);
});

test("the R library script names its library or refuses, keys its cache by what it is built from, and reads the snapshot date from the image", async () => {
  const script = path.join(openScience, "scripts/vcr/r-library.sh");
  const runIn = (/** @type {string[]} */ args, /** @type {Record<string, string>} */ env = {}) => spawnSync("bash", [script, ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir(), ...env },
  });
  const noLibrary = runIn(["verify"]);
  assert.notEqual(noLibrary.status, 0);
  assert.match(noLibrary.stderr, /VCR_R_LIBS must name the R library directory; there is no default/);
  assert.notEqual(runIn(["bogus"]).status, 0);
  const one = runIn(["key"]);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout.trim(), /^vcr-rlib-[a-z0-9.-]+-[0-9a-f]{40}$/);
  assert.equal(runIn(["key"]).stdout, one.stdout, "the same inputs are the same key");
  assert.notEqual(runIn(["key"], { VCR_R_LOCKS: "runtime" }).stdout, one.stdout, "a different set of locks is a different library");

  const text = await readFile(script, "utf8");
  assert.match(text, /ARG CRAN_SNAPSHOT_DATE=/, "the date CI installs from is the Dockerfile's own");
  const dockerfile = await readFile(path.join(engineRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^ARG CRAN_SNAPSHOT_DATE=\d{4}-\d{2}-\d{2}$/m);
  assert.match(text, /__linux__\/\$codename\/\$date/, "binaries where the snapshot has them");
  for (const name of ["r-library.sh", "ci-system-deps.sh", "check-numeric-log.sh"]) {
    const syntax = spawnSync("bash", ["-n", path.join(openScience, "scripts/vcr", name)], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `${name}: ${syntax.stderr}`);
  }
});

test("the migration rehearsal runs in CI on the test database and refuses any database that is not a clone", async () => {
  const seam = (await workflow()).jobs["vcr-seam"];
  const step = seam.steps.find((/** @type {any} */ entry) => entry.name === "Rehearse the migration script");
  assert.ok(step, "the seam job does not run the migration rehearsal");
  assert.match(step.run, /^node scripts\/vcr\/migrate-check\.mjs postgresql:\/\/postgres@127\.0\.0\.1:5432\/evimed_test_vcr$/);
  const script = path.join(openScience, "scripts/vcr/migrate-check.mjs");
  for (const name of ["evimed_production", "evimed", "postgres", "evimed_prod_restore"]) {
    const refused = spawnSync(process.execPath, [script, `postgres://postgres@127.0.0.1:1/${name}`], { encoding: "utf8", timeout: 20_000 });
    assert.equal(refused.status, 1, name);
    assert.match(refused.stderr, /Refusing database/, `${name}: refused before any connection`);
  }
  const noUrl = spawnSync(process.execPath, [script], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: 20_000 });
  assert.equal(noUrl.status, 1);
  assert.match(noUrl.stderr, /Give the clone's PostgreSQL URL/);
});

test("a numeric log is a green run only when every declared case ran, passed and none skipped itself", async (t) => {
  const check = path.join(openScience, "scripts/vcr/check-numeric-log.sh");
  const directory = await mkdtemp(path.join(os.tmpdir(), "vcr-numeric-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "engine/tests/numeric"), { recursive: true });
  await writeFile(path.join(directory, "engine/tests/numeric/A.R"), ['vcr_case("A1", c("AC-04"), function() {', "})", 'vcr_case("A2", c("AC-04"), function() {', "})", '# vcr_case("A3", c("AC-04"), function() {', ""].join("\n"));
  await writeFile(path.join(directory, "engine/tests/numeric/B.R"), 'vcr_case("B1", c("AC-04"), function() {\n})\n');
  const verdict = async (/** @type {string} */ name, /** @type {string} */ body) => {
    const log = path.join(directory, `${name}.log`);
    await writeFile(log, body);
    return spawnSync("bash", [check, log], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", VCR_ENGINE_ROOT: path.join(directory, "engine") } });
  };
  const line = (/** @type {string} */ id, /** @type {string} */ detail = "fine") => `${id}   PASS AC-04 | ${detail}  [0.1s]\n`;
  const green = await verdict("green", `${line("A1")}${line("A2")}${line("B1")}\nPASSED 3/3\n`);
  assert.equal(green.status, 0, green.stderr);
  assert.match(green.stdout, /3 declared/, "a commented-out case is not declared");
  const cases = [
    ["a run cut short", `${line("A1")}`, /did not finish/],
    ["a failing case", `${line("A1")}${line("A2")}\nFAILED CASES\n  B1 (AC-04): no\n\nPASSED 2/3\n`, /1 case\(s\) failed/],
    ["a case that never reported", `${line("A1")}${line("A2")}\nPASSED 2/2\n`, /suite declares 3/],
    ["a case that skipped itself", `${line("A1")}${line("A2", "skipped: node not on PATH")}${line("B1")}\nPASSED 3/3\n`, /skipped themselves and passed/],
  ];
  for (const [name, body, message] of cases) {
    const result = await verdict(String(name).replaceAll(" ", "-"), String(body));
    assert.notEqual(result.status, 0, `${name} passed the check`);
    assert.match(result.stderr, /** @type {RegExp} */ (message), String(name));
  }
  // An engine directory with no cases has nothing to compare a log with.
  await mkdir(path.join(directory, "empty/tests/numeric"), { recursive: true });
  const empty = spawnSync("bash", [check, path.join(directory, "green.log")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", VCR_ENGINE_ROOT: path.join(directory, "empty") } });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /scan read nothing/);
});

test("no machine path is committed in the module's scripts, its CI or the runners of its engine tests", async () => {
  const files = [
    ".github/workflows/web.yml",
    "OpenScience/apps/server/test/vcrEngineContract.integration.test.mjs",
    "OpenScience/apps/server/test/vcrIntake.integration.test.mjs",
    "docs/superpowers/specs/2026-09-28-vcr-build-contract.md",
    "项目代码/vcr-engine/tests/run_all.sh",
    "项目代码/vcr-engine/tests/run_all.R",
    "项目代码/vcr-engine/tests/service/test_service.py",
  ];
  async function collectScripts(directory) {
    for (const entry of await readdir(path.join(repoRoot, directory), { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collectScripts(file);
      else {
        assert.ok(entry.isFile(), `the script scan requires a regular file: ${file}`);
        files.push(file);
      }
    }
  }
  await collectScripts("OpenScience/scripts/vcr");
  assert.ok(files.includes(path.join("OpenScience", "scripts/vcr/test/live-acceptance.test.mjs")), "the nested acceptance test is scanned");
  assert.ok(files.length >= 12, "the scan named its files");
  const found = [];
  for (const file of files) {
    const text = await readFile(path.join(repoRoot, file), "utf8");
    const hit = text.match(/\/home\/(?:coder|runner|ubuntu)\/[^\s"'`)]*/);
    if (hit) found.push(`${file}: ${hit[0]}`);
  }
  assert.deepEqual(found, [], "a path that is one machine's makes a test check nothing on every other; read it from the environment");
});
