// What a memory never holds is one text (`@evimed/domain`'s MEMORY_NEVER_KEPT_TEXT), read by the engine through its ten type
// templates. (A second extractor, the legacy one, read it through its own instruction until 2026-10-25; a rule edited in one place only is
// how the two came to disagree about the assistant's own words on 2026-10-14. The templates are the one place now.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MEMORY_DECIDE_TEXT, MEMORY_NEVER_KEPT_TEXT } from "@evimed/domain";
import { renderMemoryTemplates } from "../../../deploy/web/openviking/memory-templates-src/build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const indent = (text) => text.trimEnd().split("\n").map((line, index) => (index === 0 ? line : `  ${line}`)).join("\n");

test("the engine's templates carry the never-kept text and the decide text, line for line, as the deployed files and as rendered", async () => {
  const never = indent(MEMORY_NEVER_KEPT_TEXT);
  const decide = indent(MEMORY_DECIDE_TEXT);
  const directory = path.join(root, "deploy/web/openviking/memory-templates");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".yaml"));
  assert.equal(files.length, 12);
  const rendered = renderMemoryTemplates();
  for (const name of files) {
    const deployed = await readFile(path.join(directory, name), "utf8");
    assert.ok(deployed.includes(never), `${name} does not state the never-kept text`);
    assert.ok(deployed.includes(decide), `${name} does not state the decide text`);
    assert.ok(rendered[name].includes(never) && rendered[name].includes(decide), `${name} is not rendered with both`);
    assert.ok(deployed.indexOf(never) < deployed.indexOf(decide), `${name}: the refusals come first, then how a line is chosen`);
    // The default of nothing is gone from every type, and no placeholder is left unrendered.
    assert.doesNotMatch(deployed, /When that is doubtful, leave it out|produces no memory operations at all|__[A-Z_]+__/, name);
  }
});

test("retention favors useful future context with very few hard boundaries", () => {
  assert.match(MEMORY_DECIDE_TEXT, /next month|another conversation/);
  assert.match(MEMORY_DECIDE_TEXT, /[Uu]ncertainty favors keeping/);
  assert.match(MEMORY_DECIDE_TEXT, /examples, not a closed list/);
  assert.match(MEMORY_DECIDE_TEXT, /NOTES/);
  for (const boundary of [/passwords/i, /API keys/i, /verification codes/i, /government/i, /bank/i, /injected/i, /tenant/i, /sealed.*VCR/i]) assert.match(MEMORY_NEVER_KEPT_TEXT, boundary);
  assert.match(MEMORY_NEVER_KEPT_TEXT, /pasted.*instructions.*rules/i);
  assert.doesNotMatch(MEMORY_NEVER_KEPT_TEXT, /Keep only when|Personal data of anyone|Keep the fact and drop the sensitive reason/);
  assert.ok(MEMORY_NEVER_KEPT_TEXT.length < 1800, "hard boundaries must stay short");
});

test("attribution preserves useful claims without treating them as established facts or permission", () => {
  for (const origin of [/assistant suggested/i, /user believes/i, /document says/i]) assert.match(MEMORY_DECIDE_TEXT, origin);
  assert.match(MEMORY_DECIDE_TEXT, /not established facts/i);
  assert.match(MEMORY_DECIDE_TEXT, /not permission/i);
  assert.match(MEMORY_DECIDE_TEXT, /allergies.*diagnoses.*medications.*doses/s);
  assert.match(MEMORY_DECIDE_TEXT, /numeric values.*dates.*plans.*contraindications.*wishes/s);
  assert.match(MEMORY_DECIDE_TEXT, /verbatim/);
});

test("the templates say where a memory belongs: corrections under preferences, no reminder as a follow-up, conventions on the project card", async () => {
  const directory = path.join(root, "deploy/web/openviking/memory-templates");
  const text = async (name) => readFile(path.join(directory, `${name}.yaml`), "utf8");
  // The unmodified plugin lists preferences/ at a session's start, so a correction written under it is in front of the model.
  assert.match(await text("corrections"), /^directory: "viking:\/\/user\/\{\{ user_space \}\}\/memories\/preferences\/corrections"$/m);
  assert.match(await text("corrections"), /approaches they adopted/);
  assert.match(await text("corrections"), /A bare\s+"不错" or "谢谢" is not the approval of an approach/);
  // Preferences no longer wait for a signal word, and keep a post-draft reshaping scoped to the genre.
  const preferences = await text("preferences");
  assert.doesNotMatch(preferences, /Signals: 以后/);
  assert.match(preferences, /examples of how people say it, not a list to match/);
  assert.match(preferences, /scoped to the kind of thing it was said\s+about/);
  assert.match(preferences, /update the\s+existing file so that it states only the current choice/, "an upgrade replaces: the later choice, not both");
  // A reminder is the scheduler's: the first example of the follow-ups template used to promise one.
  const followUps = await text("follow_ups");
  assert.match(followUps, /is a scheduled task, not a memory: do not write it here/);
  assert.doesNotMatch(followUps, /\("下个月要交年度总结，到时提醒我", "等法务回复后再定合同模板"\)/);
  // Deliverable conventions and collaborators by role and convention.
  const card = await text("project_context");
  assert.match(card, /conventions they set\s+for this work's deliverables/);
  assert.match(card, /by role and working convention/);
  assert.match(await text("project_facts"), /how a collaborator wants the work delivered/);
  // The profile takes locale, language level and everyday context; the stance is routed away.
  const profile = await text("profile");
  assert.match(profile, /locale \(units, currency, date format\)/);
  assert.match(profile, /allergies/);
  assert.doesNotMatch(profile, /keep-only-on-request|never keep state history/);
});

test("the lab variant says the never-kept block once, in the profile, and is never rendered over what is deployed", async () => {
  const full = renderMemoryTemplates();
  const lab = renderMemoryTemplates({ variant: "short-never" });
  const never = indent(MEMORY_NEVER_KEPT_TEXT);
  const decide = indent(MEMORY_DECIDE_TEXT);
  assert.deepEqual(Object.keys(lab).sort(), Object.keys(full).sort());
  assert.ok(lab["profile.yaml"].includes(never), "the profile carries the whole block");
  for (const [name, text] of Object.entries(lab)) {
    assert.ok(text.includes(decide), `${name}: how a line is chosen stays in every type, it is the positive half`);
    if (name !== "profile.yaml") {
      assert.ok(!text.includes(never), `${name} carries the reminder, not the whole block`);
      assert.match(text, /the full rules are in the profile type/);
    }
  }
  const size = (texts) => Object.values(texts).reduce((sum, text) => sum + text.length, 0);
  assert.ok(size(lab) < size(full), `${size(lab)} against ${size(full)}: the variant is the shorter text`);
  // The deployed directory is what the default renders: the variant never gets there without being asked for elsewhere.
  assert.deepEqual(renderMemoryTemplates({ variant: "full" }), full);
  const build = path.join(root, "deploy/web/openviking/memory-templates-src/build.mjs");
  const refused = spawnSync(process.execPath, [build, "--variant", "short-never"], { encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /never over the deployed templates/);
});

test("a rule given for one project is that project's card, said in the card's template and in the three that could take it instead (M8)", async () => {
  const directory = path.join(root, "deploy/web/openviking/memory-templates");
  const text = async (name) => readFile(path.join(directory, `${name}.yaml`), "utf8");
  const card = await text("project_context");
  assert.match(card, /A rule the user gives for "this project" or for the named work \("这个项目的所有文字交付物一律用英文写"/);
  assert.match(card, /is a line under 约束\s+of that project's card — also when it comes with a request for something small/);
  assert.match(card, /also when no card exists yet/);
  assert.match(await text("project_facts"), /a rule for what one project delivers —\s+its language, format, house style, a date the user set — is that card's 约束/);
  assert.match(await text("decisions"), /a rule for what one project\s+delivers — its language, format, house style — is that card's 约束/);
  assert.match(await text("preferences"), /A rule the user gives for one project \("这个项目的所有文字交付物一律用英文写"\) is not a preference of\s+theirs: it is that project's card/);
});

test("a remembered layout keeps its places as places, and the two types of 2026-10-25 say what they are for (M2, M3, M4)", async () => {
  const directory = path.join(root, "deploy/web/openviking/memory-templates");
  const text = async (name) => readFile(path.join(directory, `${name}.yaml`), "utf8");
  for (const name of ["preferences", "corrections"]) {
    const body = await text(name);
    assert.match(body, /每条先写结论；依据只写用户给过的，没给就不写/, `${name} writes the layout as places the person fills`);
    assert.match(body, /never as\s+content\s+to\s+produce/, name);
  }
  assert.doesNotMatch(await text("preferences"), /- 报告先给结论，再给依据。/, "the example no longer promises a basis");
  const observations = await text("observations");
  assert.match(observations, /a NOTE, not a memory/);
  assert.match(observations, /never shown, never recalled and never a premise/);
  assert.match(observations, /Each conversation that shows\s+the choice adds ITS OWN line to the file/);
  assert.match(observations, /^directory: "viking:\/\/user\/\{\{ user_space \}\}\/memories\/observations"$/m);
  const recent = await text("recent_work");
  assert.match(recent, /at most three lines, newest first/);
  assert.match(recent, /Never\s+the content of the work/);
  assert.match(recent, /The lines REPLACE each other/);
  assert.match(recent, /^directory: "viking:\/\/user\/\{\{ user_space \}\}\/memories\/recent_work"$/m);
});

test("people and notes give unlisted information a place without inventing an identity or closed subtype", () => {
  const templates = renderMemoryTemplates();
  assert.ok(templates["people.yaml"] && templates["notes.yaml"]);
  const people = templates["people.yaml"];
  assert.match(people, /one person per file/i);
  assert.match(people, /user.s label/i);
  assert.match(people, /uncertain identities.*separate/i);
  assert.match(people, /current state.*dated history/is);
  assert.match(people, /headings.*not a closed/i);
  assert.match(templates["notes.yaml"], /does not fit another type/i);
  assert.doesNotMatch(templates["entities.yaml"], /Never a card for a person|People are never cards|Never a category of people/);
  for (const body of Object.values(templates)) assert.doesNotMatch(body, /no contact details, no health|never by contact|without the sensitive reason|never kept, however firmly/i);
});
