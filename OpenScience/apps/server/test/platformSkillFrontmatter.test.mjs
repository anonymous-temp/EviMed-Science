import {publishConfirmed} from './helpers/confirmedEvolutionPublication.mjs';
// The front matter of a published skill is the platform's, not the builder's (review of 「循证进化」,
// 2026-10-05, S8). Candidate prose reaches every tenant's skill catalogue at platform scope, from a
// model whose inputs include literature text; the rename used one regex on the first `name:` line, so a
// second one survived (the kernel's YAML parser refuses duplicate keys and ignores the file, leaving a
// published tool no session can see) and the description had no bound but the 4 MiB file cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { createPlatformSkillSupply } from '../src/platformSkillSupply.mjs';
import { PLATFORM_SKILL_DESCRIPTION_MAX_CHARS, validatePlatformSkillPackage } from '../src/platformSkillPackage.mjs';

const evaluation = { ok: true, verificationLevel: 'V0', smokePassed: true };
const publishOptions = { card: { toolKind: 'workflow' }, evaluation };
const skill = (text) => ({ id: 'frontmatter', publicationKind: 'skill', capabilityIds: ['statistics'], files: { 'SKILL.md': text } });
/** What a kernel session would parse out of a SKILL.md: the strict YAML of its front matter, and the body. */
function kernelView(text) {
  const lines = text.split('\n');
  const close = lines.indexOf('---', 1);
  assert.equal(lines[0], '---');
  assert.ok(close > 0, 'front matter closes');
  return { frontmatter: parse(lines.slice(1, close).join('\n'), { uniqueKeys: true }), body: lines.slice(close + 1).join('\n') };
}
async function withSupply(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-frontmatter-'));
  try { await run(createPlatformSkillSupply({ dataDir, evolutionEnabled: true }), dataDir); }
  finally { await fs.rm(dataDir, { recursive: true, force: true }); }
}
test('a builder-written front matter never reaches a tenant: the platform writes name and a bounded description', async () => {
  await withSupply(async (supply, dataDir) => {
    const written = '---\nname: my-tool\ndescription: Compute the pooled estimate.\nallowed-tools: [bash]\nlicense: MIT\nmetadata:\n  hook: run\n---\n\nUse the method.\n\n---\n\nA rule in the body stays.';
    const published = await publishConfirmed(supply,skill(written), publishOptions);
    const root = path.join(dataDir, '.openscience', 'platform-skills', 'generations', published.generationHash, 'skills', published.nativeName, 'SKILL.md');
    const { frontmatter, body } = kernelView(await fs.readFile(root, 'utf8'));
    assert.deepEqual(Object.keys(frontmatter).sort(), ['description', 'name'], 'only the two platform fields');
    assert.equal(frontmatter.name, published.nativeName);
    assert.equal(frontmatter.description, 'Compute the pooled estimate.');
    assert.match(body, /^\s*Use the method\./);
    assert.match(body, /A rule in the body stays\./);
  });
});

test('a description that is not one short line is refused as a package defect, the builder repairs it in place', () => {
  const longText = 'x'.repeat(PLATFORM_SKILL_DESCRIPTION_MAX_CHARS + 1);
  for (const [label, text] of [
    ['one very long line', `---\nname: a\ndescription: ${longText}\n---\n\nBody`],
    ['a block scalar of many short lines', `---\nname: a\ndescription: |\n${Array.from({ length: 200 }, (_, index) => `  line number ${index} of the description`).join('\n')}\n---\n\nBody`],
  ]) {
    const result = validatePlatformSkillPackage(skill(text));
    assert.equal(result.ok, false, label);
    assert.ok(result.issues.some((item) => item.code === 'package_skill_description_too_long' && item.field === 'files.SKILL.md'), label);
  }
  assert.equal(validatePlatformSkillPackage(skill(`---\nname: a\ndescription: ${'y'.repeat(PLATFORM_SKILL_DESCRIPTION_MAX_CHARS)}\n---\n\nBody`)).ok, true, 'exactly the limit is fine');
});

test('front matter the kernel would refuse is refused here, so no published tool is one no session can see', () => {
  for (const [label, text] of [
    ['a second name key', '---\nname: a\nname: b\ndescription: ok\n---\n\nBody'],
    ['a second description key', '---\nname: a\ndescription: ok\ndescription: other\n---\n\nBody'],
    ['not YAML', '---\nname: a\ndescription: Numerical: method\n---\n\nBody'],
    ['never closed', '---\nname: a\ndescription: ok\n\nBody'],
    ['a list, not a mapping', '---\n- name\n- description\n---\n\nBody'],
    ['no description', '---\nname: a\n---\n\nBody'],
  ]) {
    const result = validatePlatformSkillPackage(skill(text));
    assert.equal(result.ok, false, label);
    assert.ok(result.issues.some((item) => item.code === 'package_skill_frontmatter_invalid'), label);
  }
});

test('a skill with no front matter gets the platform-written one, from its title, on one bounded line', async () => {
  await withSupply(async (supply, dataDir) => {
    const published = await publishConfirmed(supply,{ ...skill('Plain instructions.'), title: `A title\nwith a break ${'z'.repeat(900)}` }, publishOptions);
    const root = path.join(dataDir, '.openscience', 'platform-skills', 'generations', published.generationHash, 'skills', published.nativeName, 'SKILL.md');
    const { frontmatter, body } = kernelView(await fs.readFile(root, 'utf8'));
    assert.equal(frontmatter.name, published.nativeName);
    assert.equal(frontmatter.description.length, PLATFORM_SKILL_DESCRIPTION_MAX_CHARS);
    assert.doesNotMatch(frontmatter.description, /[\r\n]/);
    assert.match(body, /^\s*Plain instructions\./);
  });
});
