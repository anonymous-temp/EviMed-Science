import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { digestDirectory } from "../src/releaseManifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ai4sRoot = path.join(repoRoot, "runtime/skills/external/ai4s-skills");
const curatedRoot = path.join(repoRoot, "runtime/skills/curated-scientific");
const coreRoot = path.join(repoRoot, "runtime/skills/core");
const officeRoot = path.join(repoRoot, "runtime/skills/office");

async function directories(root) {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function assertNoSymlinks(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const stat = await lstat(full);
    assert.equal(stat.isSymbolicLink(), false, `${full} must not be a symbolic link`);
    if (stat.isDirectory()) await assertNoSymlinks(full);
  }
}

async function assertReferencedFilesExist(skillDir, packRoot = null) {
  const skill = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const references = [...skill.matchAll(/`((?:references|scripts|templates|assets)\/[A-Za-z0-9_./-]+)`/g)]
    .map((match) => match[1].replace(/[.,;:]$/, ""));
  for (const relative of new Set(references)) {
    const local = await lstat(path.join(skillDir, relative)).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (local) {
      assert.ok(local.isFile() || local.isDirectory(), `${relative} referenced by ${skillDir} must exist`);
      continue;
    }
    const crossSkillMatches = packRoot == null
      ? []
      : await Promise.all((await directories(packRoot)).map(async (name) => {
          const candidate = path.join(packRoot, name, relative);
          return lstat(candidate).then(() => candidate).catch(() => null);
        }));
    assert.ok(crossSkillMatches.some(Boolean), `${relative} referenced by ${skillDir} must exist in its pack`);
  }
}

test("the complete first-party AI4S research loop is bundled with measured-result safeguards", async () => {
  assert.deepEqual(await directories(ai4sRoot), [
    "ai4s-agent",
    "experiment-suite",
    "integrity-auditor",
    "literature-survey",
    "mindmap-render",
    "paper-writer",
    "research-explorer",
  ]);
  for (const skill of await directories(ai4sRoot)) {
    await assertReferencedFilesExist(path.join(ai4sRoot, skill), ai4sRoot);
  }
  const experiment = await readFile(path.join(ai4sRoot, "experiment-suite/SKILL.md"), "utf8");
  const paper = await readFile(path.join(ai4sRoot, "paper-writer/SKILL.md"), "utf8");
  assert.match(experiment, /Measured mode is the default/);
  assert.match(experiment, /never treat it as publication evidence/);
  assert.match(paper, /simulated inputs require an explicit dry-run request/);
  assert.match(paper, /cannot support a submission-ready claim/);
  await assertNoSymlinks(ai4sRoot);
});

test("the curated scientific inventory contains only audited or EviMed-rehabilitated skills", async () => {
  const inventory = JSON.parse(await readFile(path.join(curatedRoot, "inventory.json"), "utf8"));
  const expected = inventory.skills.map((skill) => skill.name).sort();
  const supportDirs = new Set(inventory.policy.delivery.supportDirs);
  assert.equal(inventory.policy.rejectedWholePack, true);
  assert.ok(inventory.policy.wholePackSecurity.critical > 0);
  assert.ok(inventory.policy.wholePackSecurity.high > 0);
  assert.equal(inventory.policy.digestAlgorithm, "release-directory-v1");
  assert.equal(expected.length, 38);
  assert.deepEqual((await directories(curatedRoot)).filter((name) => !supportDirs.has(name)), expected);
  assert.deepEqual(inventory.skills.map((skill) => skill.name).sort(), expected);
  assert.ok(inventory.skills.every((skill) => ["SAFE", "REHABILITATED_SAFE"].includes(skill.security) && skill.reviewed === true && skill.derivedFrom.length > 10 && skill.fills.length > 20));
  for (const skill of inventory.skills) {
    const skillDir = path.join(curatedRoot, skill.name);
    assert.equal((await digestDirectory(skillDir)).digest, skill.digest);
    await assertReferencedFilesExist(skillDir);
  }
  await assertNoSymlinks(curatedRoot);
});

test("all 38 curated scientific skills have an executable, dependency-pinned, smoke-tested delivery contract", async (t) => {
  const inventory = JSON.parse(await readFile(path.join(curatedRoot, "inventory.json"), "utf8"));
  const delivery = inventory.policy.delivery;
  assert.equal(delivery.contractVersion, 1);
  assert.equal(delivery.defaultEnabledTier, "executable");
  const executable = new Set(Object.keys(delivery.executable));
  const conditional = new Set(Object.keys(delivery.conditional));
  const instructionOnly = new Set(delivery.instructionOnly);
  const all = new Set([...executable, ...conditional, ...instructionOnly]);
  assert.equal(all.size, 38);
  assert.deepEqual([...all].sort(), inventory.skills.map((skill) => skill.name).sort());
  assert.equal(executable.size, 38);
  assert.equal(conditional.size, 0);
  assert.equal(instructionOnly.size, 0);

  for (const skill of inventory.skills) {
    await t.test(skill.name, async () => {
      const memberships = [executable, conditional, instructionOnly].filter((set) => set.has(skill.name));
      assert.equal(memberships.length, 1, `${skill.name} must have exactly one delivery tier`);
      const executableContract = delivery.executable[skill.name];
      if (executableContract) {
        assert.ok(executableContract.entrypoints.length > 0);
        assert.ok(executableContract.dependencies.length > 0);
        assert.ok(executableContract.artifacts.length > 0);
        assert.ok(executableContract.smoke.length > 3);
        for (const entrypoint of executableContract.entrypoints) {
          assert.ok((await lstat(path.join(curatedRoot, skill.name, entrypoint))).isFile());
        }
      }
      const conditionalContract = delivery.conditional[skill.name];
      if (conditionalContract) {
        assert.ok(conditionalContract.reason.length > 40);
        assert.ok(conditionalContract.missingDependencies.length > 0);
      }
    });
  }

  // The contract above is only a promise until the image proves it at build
  // time, so this reads the Dockerfile the platform actually builds. It read
  // the retired kernel's copy until that tree was deleted on 2026-09-02; the
  // build-time smoke is a property of whichever image ships, not of the kernel
  // that happened to host it first.
  const sharedExecutor = await readFile(path.join(curatedRoot, "_runtime/execute_skill.py"), "utf8");
  const runtimeDockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  assert.match(sharedExecutor, /No deterministic baseline is registered for this skill/);
  assert.match(runtimeDockerfile, /Smoke every shared curated-skill implementation in the production dependency image/);
  assert.match(runtimeDockerfile, /len\(shared\) != 36/);
});

test("the original review and remote-run capabilities remain first-party skills", async () => {
  const installed = new Set(await directories(coreRoot));
  for (const required of [
    "traceability-review",
    "stats-integrity",
    "domain-check",
    "large-file",
    "publication-figures",
    "remote-compute",
    "modal-run",
  ]) {
    assert.ok(installed.has(required), `${required} must remain bundled`);
    assert.ok((await lstat(path.join(coreRoot, required, "SKILL.md"))).isFile());
  }
  for (const recorder of ["remote-compute/record_run.py", "modal-run/record_run.py"]) {
    const source = await readFile(path.join(coreRoot, recorder), "utf8");
    assert.match(source, /remote-runs\.jsonl/);
    assert.match(source, /output path was already recorded/);
  }
  await assertNoSymlinks(coreRoot);
});

test("the four first-party Office skills execute independent artifact smoke tests", async (t) => {
  const inventory = JSON.parse(await readFile(path.join(officeRoot, "inventory.json"), "utf8"));
  assert.equal(inventory.license, "MIT");
  assert.equal(inventory.provenance, "EviMed first-party clean-room implementation");
  assert.deepEqual(Object.keys(inventory.policy.delivery.executable).sort(), ["docx", "pdf", "pptx", "xlsx"]);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "evimed-office-skills-"));
  try {
    const csv = path.join(tmp, "input.csv");
    await writeFile(csv, "name,value\ncontrol,1\ntreatment,2\n");
    const cases = [
      { name: "docx", script: "create_docx.py", output: "document.docx", args: ["--text", "Evidence report", "--output"] },
      { name: "pdf", script: "create_pdf.py", output: "document.pdf", args: ["--text", "Evidence report", "--output"] },
      { name: "pptx", script: "create_pptx.py", output: "presentation.pptx", args: ["--title", "Evidence", "--body", "Auditable result", "--output"] },
      { name: "xlsx", script: "create_xlsx.py", output: "workbook.xlsx", args: ["--input", csv, "--output"] },
    ];
    for (const item of cases) {
      await t.test(item.name, async () => {
        const output = path.join(tmp, item.output);
        const result = spawnSync("python3", [path.join(officeRoot, item.name, "scripts", item.script), ...item.args, output], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const data = await readFile(output);
        assert.ok(data.length > 100);
        if (item.name === "pdf") {
          assert.equal(data.subarray(0, 5).toString(), "%PDF-");
          assert.match(data.subarray(-32).toString(), /%%EOF/);
        } else {
          assert.equal(data.subarray(0, 2).toString(), "PK");
          const validation = spawnSync("python3", ["-c", "import sys,zipfile,xml.etree.ElementTree as E; z=zipfile.ZipFile(sys.argv[1]); [E.fromstring(z.read(n)) for n in z.namelist() if n.endswith('.xml')]", output], { encoding: "utf8" });
          assert.equal(validation.status, 0, validation.stderr || validation.stdout);
        }
      });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
