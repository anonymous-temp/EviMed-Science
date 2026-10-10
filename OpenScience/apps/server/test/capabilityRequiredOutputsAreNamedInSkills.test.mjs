// A manifest that requires a file its skill never asks for.
//
// `evidence-appraisal` required `delivery-summary.md`, `geo-content` required
// `geo-content-pack.json` and `brand-entity.json`, and
// `research-grant-development` required `specific-aims.md` and
// `proposal-outline.md`, and none of their skill texts named those paths. The
// skills described the content well enough — the aims, the approach, the
// machine-readable pack — but `requiredOutputsExist` checks names before it
// reads a line, so a run that followed its skill perfectly still ended
// `specialist_required_output_missing`. The first production acceptance of
// `evidence-appraisal` on 2026-09-09 did exactly that: sixty minutes, 237
// messages, a reviewed report, and the wrong file names.
//
// The contract binds the output; the skill is the only place the run learns
// what the contract is called. A required path that appears in neither the
// capability's own SKILL.md nor any shared skill it lists is a trap, and this
// walk refuses it.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { briefFileForSession, workspaceLayout } from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function readIfPresent(file) {
  return readFile(file, "utf8").catch(() => "");
}

test("every required output path is named in the capability's skill stack", async () => {
  const capabilitiesDir = path.join(repoRoot, "capabilities");
  const entries = (await readdir(capabilitiesDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.ok(entries.length >= 15, `walked ${entries.length} capabilities; the walk is wrong, not the tree`);
  let required = 0;
  const unnamed = [];
  for (const entry of entries) {
    const manifest = YAML.parse(await readFile(path.join(capabilitiesDir, entry.name, "capability.yaml"), "utf8"));
    const texts = [await readIfPresent(path.join(capabilitiesDir, entry.name, "SKILL.md"))];
    for (const skill of manifest.skills ?? []) {
      texts.push(await readIfPresent(path.join(repoRoot, "capability-skills", skill, "SKILL.md")));
    }
    const stack = texts.join("\n");
    for (const produced of manifest.produces ?? []) {
      for (const output of produced.outputs ?? []) {
        if (!output.required) continue;
        required += 1;
        if (!stack.includes(output.path)) unnamed.push(`${entry.name}: ${output.path}`);
      }
    }
  }
  // Dataset scoping made its ten companion outputs optional on 2026-09-29.
  assert.ok(required >= 50, `only ${required} required outputs were walked; the manifests changed shape`);
  assert.deepEqual(unnamed, [], `required outputs no skill text names:\n  ${unnamed.join("\n  ")}`);
});

test("the shipped skill copy is the manifest source's copy", async () => {
  // The run reads `capability-skills/<id>/SKILL.md`; the manifest source is
  // `capabilities/<id>/SKILL.md`. An edit to one that never reached the other
  // is a skill the tests read and the run does not.
  const capabilitiesDir = path.join(repoRoot, "capabilities");
  const entries = (await readdir(capabilitiesDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const drifted = [];
  for (const entry of entries) {
    const source = await readIfPresent(path.join(capabilitiesDir, entry.name, "SKILL.md"));
    const shipped = await readIfPresent(path.join(repoRoot, "capability-skills", entry.name, "SKILL.md"));
    if (source && shipped && source !== shipped) drifted.push(entry.name);
  }
  assert.deepEqual(drifted, [], `capabilities/ and capability-skills/ hold different SKILL.md bodies for: ${drifted.join(", ")}`);
});

// The same walk, for the other direction: a skill that sends a run to a path the platform stopped writing. The brief,
// its context and memory, the run index and the state projection are per conversation or per run since e2eca41c4
// (2026-10-10), and the control plane no longer refreshes the project-wide files. The clinical skill went on saying the
// task was at `.evimed-brief/research-brief.md`: in a project that had run before, that file holds an earlier run's
// question and is never rewritten, so a run that followed its skill re-read another run's task.
test("no skill sends a run to a project-wide workspace file the platform no longer writes", async () => {
  const roots = ["capabilities", "capability-skills", path.join("runtime", "skills", "evimed")].map((root) => path.join(repoRoot, root));
  const skills = [];
  for (const root of roots) {
    for (const entry of (await readdir(root, { withFileTypes: true })).filter((candidate) => candidate.isDirectory())) {
      const file = path.join(root, entry.name, "SKILL.md");
      const text = await readIfPresent(file);
      if (text) skills.push({ file: path.relative(repoRoot, file), text });
    }
  }
  assert.ok(skills.length >= 60, `walked ${skills.length} SKILL.md files; the walk is wrong, not the tree`);
  const retired = [workspaceLayout.briefFile, workspaceLayout.briefContextFile, workspaceLayout.briefMemoryFile, workspaceLayout.briefIndexFile, workspaceLayout.runStateFile];
  const stale = skills.flatMap(({ file, text }) => retired.filter((legacy) => text.includes(legacy)).map((legacy) => `${file}: ${legacy}`));
  assert.deepEqual(stale, [], `skills naming a file the platform no longer refreshes:\n  ${stale.join("\n  ")}`);

  // And the one skill that does send a run to its task names the file the control plane writes now, in every copy of it.
  const sessionBrief = briefFileForSession("SESSION").replace("SESSION", "<session id>");
  const clinical = skills.filter(({ file }) => file.split(path.sep).includes("clinical-evidence-synthesis"));
  assert.equal(clinical.length, 3, `the clinical skill is kept in ${clinical.length} places: ${clinical.map(({ file }) => file).join(", ")}`);
  for (const { file, text } of clinical) assert.ok(text.includes(sessionBrief), `${file} does not name ${sessionBrief}`);
});
