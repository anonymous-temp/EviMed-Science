// The Agent Skills export (flywheel F17c): the pack follows the open specification's rules for a skill — read at
// https://agentskills.io/specification on 2026-10-05 — and carries text only, whatever a method owns in the platform.
import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import YAML from "yaml";
import {
  AGENT_SKILLS_DESCRIPTION_MAX, AGENT_SKILLS_NAME_MAX, AGENT_SKILLS_NAME_PATTERN, SCRIPTS_NOT_SHARED_LINE,
  agentSkillName, buildAgentSkillsPack, markScriptBlocks,
} from "../src/capsuleMethodPack.mjs";

/** The specification's rules for one skill folder, stated once: the front matter's required fields, the name's shape and its
 *  equality with the directory, the description's bounds. Returns what it read. */
function validateSkillFolder(files, folder) {
  const skill = strFromU8(files[`${folder}/SKILL.md`]);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(match, `${folder}: SKILL.md starts with YAML front matter`);
  const front = YAML.parse(match[1]);
  assert.equal(typeof front.name, "string");
  assert.ok(front.name.length >= 1 && front.name.length <= AGENT_SKILLS_NAME_MAX, `${folder}: name is 1-64 characters`);
  assert.match(front.name, AGENT_SKILLS_NAME_PATTERN, `${folder}: lowercase letters, digits and single hyphens, none at either end`);
  assert.ok(!front.name.includes("--"));
  assert.equal(front.name, folder, "the name equals the parent directory");
  assert.equal(typeof front.description, "string");
  assert.ok(front.description.length >= 1 && front.description.length <= AGENT_SKILLS_DESCRIPTION_MAX, `${folder}: description is 1-1024 characters`);
  const allowed = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
  assert.ok(Object.keys(front).every((key) => allowed.has(key)), "no field outside the specification");
  return { front, skill };
}

const methods = [
  { name: "Evidence Matrix First", description: "Build the evidence matrix before any prose.", whenToUse: "Any synthesis.", body: "## Steps\n1. List the sources.\n2. Quote each claim.\n" },
  { name: "统计分析的做法", description: "", body: "先核对分母。\n\n```r\nsummary(model)\n```\n\n然后写结论。" },
  { name: "Evidence Matrix First!", description: "x".repeat(2000), body: "Second method with the same slug.\n\n```bash\nrm -rf /tmp/x\n```\n" },
];

test("each approved method becomes one spec-valid folder of two Markdown files and nothing else", () => {
  const pack = buildAgentSkillsPack({ methods, authorName: "李主任", exportedAt: new Date("2026-10-05T08:00:00Z") });
  const files = unzipSync(pack.zip);
  assert.equal(pack.count, 3);
  const folders = new Set(Object.keys(files).map((name) => name.split("/")[0]));
  assert.equal(folders.size, 3, "one folder per method, the colliding slug made distinct");
  for (const name of Object.keys(files)) assert.match(name, /^[a-z0-9-]+\/(?:SKILL|PROVENANCE)\.md$/, `${name}: text only — no scripts/, assets/ or tool definition`);
  for (const folder of folders) validateSkillFolder(files, folder);
  assert.ok(folders.has("evidence-matrix-first") && folders.has("evidence-matrix-first-2"));
  assert.ok([...folders].some((folder) => /^method-[0-9a-f]{8}$/.test(folder)), "a name with nothing to keep gets a digest name");
  const described = validateSkillFolder(files, "evidence-matrix-first-2").front.description;
  assert.equal(described.length, AGENT_SKILLS_DESCRIPTION_MAX, "a long description is cut to the specification's bound");
});

test("a fenced script stays in the text exactly as written, with a line saying scripts are not shared; nothing is stripped or run", () => {
  const pack = buildAgentSkillsPack({ methods, authorName: "李主任" });
  const files = unzipSync(pack.zip);
  const skills = Object.entries(files).filter(([name]) => name.endsWith("SKILL.md")).map(([, bytes]) => strFromU8(bytes));
  const withR = skills.find((text) => text.includes("summary(model)"));
  assert.ok(withR.includes("```r\nsummary(model)\n```"), "the block is kept byte for byte");
  assert.ok(withR.includes(SCRIPTS_NOT_SHARED_LINE));
  const withBash = skills.find((text) => text.includes("rm -rf /tmp/x"));
  assert.ok(withBash.includes("```bash\nrm -rf /tmp/x\n```") && withBash.includes(SCRIPTS_NOT_SHARED_LINE));
  const plain = skills.find((text) => text.includes("List the sources"));
  assert.ok(!plain.includes(SCRIPTS_NOT_SHARED_LINE), "a method with no script carries no such line");
  assert.equal(pack.scripts, 2);
  // A block of prose in a fence, or one with no language, is not a script.
  assert.equal(markScriptBlocks("```\nplain\n```").scripts, 0);
  assert.equal(markScriptBlocks("```text\nplain\n```").scripts, 0);
  assert.equal(markScriptBlocks("~~~python\nprint(1)\n~~~").scripts, 1);
  assert.equal(markScriptBlocks("```\n#!/bin/sh\necho hi\n```").scripts, 1, "a shebang makes a block a script whatever it is labelled");
});

test("PROVENANCE.md names the author's display name, the snapshot hash and the date; the hash follows the methods", () => {
  const at = new Date("2026-10-05T08:00:00Z");
  const one = buildAgentSkillsPack({ methods, authorName: "李主任", exportedAt: at });
  const again = buildAgentSkillsPack({ methods, authorName: "李主任", exportedAt: new Date("2026-10-06T00:00:00Z") });
  assert.equal(one.snapshotHash, again.snapshotHash, "the same methods are the same snapshot");
  const changed = buildAgentSkillsPack({ methods: [{ ...methods[0], body: "different" }, ...methods.slice(1)], authorName: "李主任", exportedAt: at });
  assert.notEqual(changed.snapshotHash, one.snapshotHash);
  const provenance = strFromU8(unzipSync(one.zip)["evidence-matrix-first/PROVENANCE.md"]);
  assert.match(provenance, /李主任/);
  assert.ok(provenance.includes(`sha256:${one.snapshotHash}`));
  assert.ok(provenance.includes("2026-10-05"));
  assert.ok(!/account|user_|@/.test(provenance), "no account id, no address");
});

test("names are made valid, never trusted", () => {
  assert.equal(agentSkillName("  Claim Verdict Audit  "), "claim-verdict-audit");
  assert.equal(agentSkillName("a--b__c"), "a-b-c");
  assert.equal(agentSkillName("-x-"), "x");
  assert.equal(agentSkillName("全是中文"), "");
  assert.equal(agentSkillName("a".repeat(100)).length, AGENT_SKILLS_NAME_MAX);
  assert.ok(!agentSkillName(`${"a".repeat(63)}-b`).endsWith("-"), "cutting at 64 never leaves a trailing hyphen");
});
