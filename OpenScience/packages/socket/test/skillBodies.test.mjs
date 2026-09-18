import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SKILL_BODY_MAX_CHARS,
  buildDelegation,
  capSkillBodies,
  deferredSectionSkill,
  sectionSkillName,
  splitSkillSections,
} from "../index.mjs";

const repo = new URL("../../../", import.meta.url);

/** @param {string} title @param {number} size */
const section = (title, size) => `## ${title}\n\n${"内容".repeat(Math.ceil(size / 2)).slice(0, size)}\n`;

test("a skill body splits at its level-two headings outside fenced code, and joins back byte for byte", () => {
  const body = [
    "---",
    "name: demo",
    "---",
    "# Demo",
    "",
    "## First",
    "text",
    "````markdown",
    "```",
    "## not a heading: a shorter fence does not close a longer one",
    "```",
    "````",
    "### deeper stays inside",
    "## Second",
    "~~~",
    "## also not a heading",
    "~~~",
    "end",
  ].join("\n");
  const { preamble, sections } = splitSkillSections(body);
  assert.equal(preamble, "---\nname: demo\n---\n# Demo\n");
  assert.deepEqual(sections.map((entry) => entry.heading), ["First", "Second"]);
  assert.equal([preamble, ...sections.map((entry) => entry.text)].join("\n"), body);
  assert.match(sections[0].text, /## not a heading/);
  assert.match(sections[1].text, /## also not a heading/);

  const headless = "## Only\nbody";
  const split = splitSkillSections(headless);
  assert.equal(split.preamble, "");
  assert.equal(split.sections.map((entry) => entry.text).join("\n"), headless);
});

test("bodies under the cap pass through untouched", () => {
  const bodies = [{ name: "small", body: section("A", 100) }];
  const capped = capSkillBodies(bodies);
  assert.deepEqual(capped.inline, bodies);
  assert.deepEqual(capped.deferred, []);
});

test("over the cap, the largest sections are deferred, nothing is lost, and every stub names what loads it", () => {
  const main = ["# Main\n", section("Scope", 3_000), section("Search protocol", 20_000), section("Citation rules", 18_000), section("Safety boundaries", 1_500), section("Before delivering", 900)].join("\n");
  const helper = ["# Helper\n", section("Workflow", 800), section("Quality rules", 700)].join("\n");
  const bodies = [{ name: "main-skill", body: main }, { name: "helper-skill", body: helper }];
  const capped = capSkillBodies(bodies, { maxChars: 12_000 });

  const inlineSize = capped.inline.reduce((sum, skill) => sum + skill.body.length, 0);
  assert.ok(inlineSize <= 12_000, `capped to ${inlineSize}`);
  assert.deepEqual(capped.deferred.map((entry) => entry.heading), ["Search protocol", "Citation rules"], "the two phase procedures go; principles and boundaries stay");
  for (const kept of ["## Safety boundaries", "## Before delivering", "## Workflow", "## Quality rules", "## Scope"]) {
    assert.ok(capped.inline.some((skill) => skill.body.includes(kept)), `${kept} stays inline`);
  }

  // No medical content deleted: every original section is either inline
  // verbatim or the exact content of a deferred section skill.
  for (const skill of bodies) {
    for (const original of splitSkillSections(skill.body).sections) {
      const inline = capped.inline.find((entry) => entry.name === skill.name)?.body.includes(original.text);
      const deferred = capped.deferred.some((entry) => entry.skill === skill.name && entry.content === original.text);
      assert.ok(inline || deferred, `${skill.name} / ${original.heading} is neither inline nor loadable`);
    }
  }
  // Each deferred heading keeps its place, with the name that loads it.
  for (const entry of capped.deferred) {
    assert.equal(entry.name, sectionSkillName(entry.skill, entry.index));
    assert.match(entry.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, "the kernel accepts kebab-case skill names only");
    const body = capped.inline.find((skill) => skill.name === entry.skill)?.body ?? "";
    assert.ok(body.includes(`## ${entry.heading}\n\n〔本节 ${entry.chars} 字未随任务注入。用到它之前调用 \`skill\`，name 填 \`${entry.name}\``), `no stub for ${entry.name}`);
  }
  assert.deepEqual(capSkillBodies(bodies, { maxChars: 12_000 }), capped, "the same bodies always split the same way");
});

test("a deferred section is registered as a model-only skill whose relative paths resolve in its own directory", () => {
  const skill = deferredSectionSkill({ skill: "clinical-evidence-synthesis", index: 6, name: "clinical-evidence-synthesis-section-06", heading: "Citation and traceability integrity", content: "## Citation and traceability integrity\n…" }, "/opt/evimed/capability-skills/");
  assert.equal(skill.name, "clinical-evidence-synthesis-section-06");
  assert.equal(skill.content, "## Citation and traceability integrity\n…");
  assert.match(skill.description, /clinical-evidence-synthesis 的第 6 节：Citation and traceability integrity/);
  assert.equal(skill.resourceDir, "/opt/evimed/capability-skills/clinical-evidence-synthesis");
});

test("the delegation message opens with the stable method and says how to reach what was deferred", () => {
  const manifest = { id: "demo", produces: [{ contractKind: "research-brief", outputs: [{ path: "brief.md", required: true }] }] };
  const item = { id: "d1", title: "简报", contractKind: "research-brief" };
  const plain = buildDelegation({ manifest, item, briefExcerpt: "题面", skillBodies: [{ name: "demo", body: "## 步骤" }], toolFilter: ["read"] });
  assert.ok(plain.prompt.startsWith("## 方法\n"), "the method is the prefix every child of a capability shares");
  assert.ok(plain.prompt.indexOf("## 你的任务") > plain.prompt.indexOf("## 步骤"));
  assert.ok(plain.prompt.indexOf("## 题面") > plain.prompt.indexOf("## 你的任务"));
  assert.doesNotMatch(plain.prompt, /没有随任务注入/, "nothing deferred, nothing said");

  const capped = buildDelegation({
    manifest, item, briefExcerpt: "题面", skillBodies: [{ name: "demo", body: "## 步骤" }], toolFilter: ["read"],
    deferredSections: [{ name: "demo-section-02" }, { name: "demo-section-03" }], skillsDir: "/opt/evimed/capability-skills",
  });
  assert.match(capped.prompt, new RegExp(`方法正文超过 ${SKILL_BODY_MAX_CHARS} 字，较长的 2 节没有随任务注入`));
  assert.match(capped.prompt, /`\/opt\/evimed\/capability-skills\/<技能名>\/SKILL\.md`/, "the file stays a fallback when the skill tool cannot find a section");
});

test("the shipped clinical method fits the cap with its safety boundaries inline", async () => {
  // Walks the real capability, so a skill that grows past what a child can be
  // handed shows up here rather than in a run.
  const manifest = JSON.parse(await readFile(new URL("deploy/runtime-dsh/capabilities/clinical-evidence-synthesis.json", repo), "utf8"));
  assert.ok(manifest.skills.length >= 2, "no skills were read, so this test walked nothing");
  /** @type {{ name: string, body: string }[]} */
  const bodies = [];
  for (const skill of manifest.skills) bodies.push({ name: skill, body: await readFile(new URL(`capability-skills/${skill}/SKILL.md`, repo), "utf8") });
  const capped = capSkillBodies(bodies);
  assert.ok(capped.inline.reduce((sum, skill) => sum + skill.body.length, 0) <= SKILL_BODY_MAX_CHARS);
  assert.equal(capped.deferred.length > 0, capped.total > SKILL_BODY_MAX_CHARS, "sections are deferred exactly when the method is over the cap");
  const main = capped.inline.find((skill) => skill.name === "clinical-evidence-synthesis")?.body ?? "";
  const safety = splitSkillSections(bodies[0].body).sections.find((entry) => /^Safety/.test(entry.heading));
  assert.ok(safety && main.includes(safety.text), "the safety boundaries travel with the task");
});
