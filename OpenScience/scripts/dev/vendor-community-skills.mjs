#!/usr/bin/env node
/**
 * Vendor the community skills named in `runtime/skills/community/sources.json`,
 * each at exactly the commit the manifest pins, and refuse any that fails the
 * intake checks.
 *
 * The checks exist because a skill is not a library: it is text the model is
 * told to follow. A skill that names a tool this composition does not mount
 * does not fail loudly — the model follows the instruction, the tool is absent,
 * and the run degrades in a way that reads like the model being bad at its job.
 * That is the failure this script is built to make impossible, and it is not
 * hypothetical: four of the five packages the adoption plan listed as
 * "skill-form" turned out to register tools instead, `writing-guard` calling
 * `writing_audit()` twelve times in its own SKILL.md.
 *
 * Usage:
 *   node scripts/dev/vendor-community-skills.mjs           # fetch and install
 *   node scripts/dev/vendor-community-skills.mjs --check    # verify in place, fetch nothing
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const communityDir = path.join(root, "runtime/skills/community");
const manifestPath = path.join(communityDir, "sources.json");

/** The tool names this composition actually mounts. A skill may name these and
 *  nothing else. Kept as a literal list rather than derived from the preset,
 *  because the preset names *plugin packages* (`@deepseek-ai/dsh-tool-fs`) and
 *  the tools they register are a different vocabulary — deriving one from the
 *  other would be a guess dressed up as a check. */
const MOUNTED_TOOLS = new Set([
  // DSH's own, from the rows in presets/evimed-universal/agent.cordis.yml
  "bash", "read", "write", "edit", "glob", "grep", "list", "skill", "task",
  "fs_read", "fs_write", "fs_edit", "fs_search", "job_run", "job_status",
  "ask_user", "subagent", "subagent_control", "subagent_report", "workflow",
  // Ours, from packages/socket/plugins/*
  "evimed_plan", "evimed_delegate", "evimed_screen_batch", "evimed_review_run",
  "evimed_submit_deliverable", "evimed_complete_run",
  "evimed_capsule_note", "evimed_capsule_recall",
]);

/** Identifier-shaped call sites in a skill body: `some_tool(`, in prose or in a
 *  fence. Two-part snake_case only — a single lowercase word followed by `(` is
 *  far more often ordinary prose or shell than a tool call, and flagging those
 *  would bury the real finding. */
const CALL_RE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(/g;

/** @param {string} body @returns {string[]} */
function referencedTools(body) {
  return [...new Set([...body.matchAll(CALL_RE)].map((match) => match[1]))];
}

/** @param {string} body @returns {Record<string, string>} */
function frontmatter(body) {
  if (!body.startsWith("---\n")) return {};
  const end = body.indexOf("\n---", 4);
  if (end < 0) return {};
  /** @type {Record<string, string>} */
  const fields = {};
  let key = null;
  for (const line of body.slice(4, end).split("\n")) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match) {
      key = match[1];
      fields[key] = match[2].replace(/^["'>|-]+\s*/, "").replace(/["']$/, "").trim();
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

/** Names already taken by the three roots that ship ahead of this one. The
 *  first root wins a collision, so a community skill that repeats a curated
 *  name is not an error the harness reports — it is a skill that silently never
 *  loads. @returns {Set<string>} */
function existingSkillNames() {
  const names = new Set();
  for (const dir of ["core", "curated-scientific", "office"]) {
    const full = path.join(root, "runtime/skills", dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
      else if (entry.name.endsWith(".md")) names.add(entry.name.replace(/\.md$/, ""));
    }
  }
  return names;
}

/** @param {string} dir @param {any} source @param {Set<string>} taken @returns {string[]} */
function intakeFailures(dir, source, taken) {
  /** @type {string[]} */
  const failures = [];
  const skillFile = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillFile)) return [`${source.name}: no SKILL.md at the root of the vendored directory`];
  const body = fs.readFileSync(skillFile, "utf8");
  const fields = frontmatter(body);

  if (fields.name !== source.name) {
    failures.push(`${source.name}: frontmatter name is ${JSON.stringify(fields.name ?? null)}, which must equal the directory name`);
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(source.name)) {
    failures.push(`${source.name}: not kebab-case; the skill loader will not find it`);
  }
  if (!fields.description) {
    failures.push(`${source.name}: frontmatter has no description; the skill is invisible to selection`);
  }
  if (taken.has(source.name)) {
    failures.push(`${source.name}: a skill of this name already ships in an earlier root, so this copy would never load`);
  }
  // Nested skill trees are not discovered: a SKILL.md below the top level is
  // read by nobody and looks installed.
  for (const nested of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!nested.isDirectory()) continue;
    const buried = path.join(dir, nested.name, "SKILL.md");
    if (fs.existsSync(buried)) failures.push(`${source.name}: a nested SKILL.md at ${nested.name}/ will never be discovered`);
  }

  const allowed = new Set([...MOUNTED_TOOLS, ...(source.requiresTools ?? [])]);
  const unknown = referencedTools(body).filter((tool) => !allowed.has(tool));
  if (unknown.length) {
    failures.push(
      `${source.name}: names ${unknown.length} tool(s) this composition does not mount — ${unknown.slice(0, 6).join(", ")}. ` +
      "A skill that calls an absent tool degrades the run silently; take the bundle whole or leave it.",
    );
  }
  return failures;
}

/** @param {any} source */
function fetchSkill(source) {
  if (!/^[0-9a-f]{40}$/.test(source.commit)) {
    throw new Error(`${source.name}: commit must be a full 40-character sha, got ${JSON.stringify(source.commit)}`);
  }
  const staging = fs.mkdtempSync(path.join(root, ".vendor-"));
  try {
    const url = `https://codeload.github.com/${source.repo}/tar.gz/${source.commit}`;
    const curl = spawnSync("curl", ["-sSL", "--max-time", "120", url, "-o", path.join(staging, "src.tar.gz")], { encoding: "utf8" });
    if (curl.status !== 0) throw new Error(`${source.name}: fetch failed — ${curl.stderr.trim()}`);
    const tar = spawnSync("tar", ["-xzf", path.join(staging, "src.tar.gz"), "-C", staging, "--strip-components=1"], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`${source.name}: extract failed — ${tar.stderr.trim()}`);
    const from = path.join(staging, source.subpath);
    if (!fs.existsSync(from)) throw new Error(`${source.name}: ${source.subpath} is not in that commit`);
    const to = path.join(communityDir, source.name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
    const licence = ["LICENSE", "LICENSE.md", "LICENSE.txt"].map((f) => path.join(staging, f)).find((f) => fs.existsSync(f));
    if (licence) fs.cpSync(licence, path.join(to, `LICENSE.${source.name}`));
    fs.writeFileSync(path.join(to, "PROVENANCE.md"), [
      `# ${source.name}`,
      "",
      `Vendored from https://github.com/${source.repo} at \`${source.commit}\` (${source.license}).`,
      `Subdirectory: \`${source.subpath}\`. Reviewed ${source.reviewedOn}.`,
      "",
      "Do not edit in place — `pnpm vendor:community-skills` overwrites this directory",
      "from the pinned commit. Change `runtime/skills/community/sources.json` instead.",
      "",
      source.why,
      "",
    ].join("\n"));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const checkOnly = process.argv.includes("--check");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const taken = existingSkillNames();
/** @type {string[]} */
const failures = [];

for (const source of manifest.skills) {
  const dir = path.join(communityDir, source.name);
  if (!checkOnly) {
    try {
      fetchSkill(source);
    } catch (error) {
      failures.push(String(error instanceof Error ? error.message : error));
      continue;
    }
  }
  if (!fs.existsSync(dir)) {
    failures.push(`${source.name}: not vendored; run without --check`);
    continue;
  }
  failures.push(...intakeFailures(dir, source, taken));
}

// A vendored directory nobody declared is the same problem as an undeclared
// dependency: it loads, and no record says where it came from.
for (const entry of fs.readdirSync(communityDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (!manifest.skills.some((source) => source.name === entry.name)) {
    failures.push(`${entry.name}: present on disk but not in sources.json`);
  }
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`✗ ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`✓ ${manifest.skills.length} community skill(s) vendored and checked; ${manifest.deferred.length} deferred to the try-install lane\n`);
