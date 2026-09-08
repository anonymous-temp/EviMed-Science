// The handbook section the loop maintains, and the guard that keeps it inside
// its own borders.
//
// Two properties are load-bearing and everything else is detail: an automated
// edit may not change a byte outside the section, and a counter may never go
// down. The first is what makes an automated pull request against a shipped
// capability safe to review; the second is what stops a rewrite from quietly
// erasing evidence that a note has been doing harm.
import assert from "node:assert/strict";
import test from "node:test";

import {
  BULLET_TAGS,
  EXPERIENCE_SECTION_HEADING,
  EXPERIENCE_SUBSECTIONS,
  curateBullets,
  harmfulBullets,
  nextBulletId,
  onlyExperienceSectionChanged,
  parseExperienceSection,
  renderBullet,
  renderExperienceSection,
  replaceExperienceSection,
} from "../src/experienceBullets.mjs";

const HANDBOOK = [
  "---",
  "name: meta-analysis",
  "description: Produce a meta-analysis.",
  "---",
  "",
  "# Meta Analysis",
  "",
  "## Contract",
  "",
  "You must submit meta-analysis-report.md and forest-plot.png.",
  "",
  `## ${EXPERIENCE_SECTION_HEADING}`,
  "",
  "<!-- Maintained by the consolidation job. Edit the sections above instead; changes here are overwritten. -->",
  "",
  "### Common Mistakes",
  "",
  "- [E-meta-analysis-1] helpful=2 harmful=0 :: Heterogeneity above 75 percent is reported, not smoothed away.",
  "",
  "## Output",
  "",
  "One directory per run.",
  "",
].join("\n");

test("the section is read with ACE's grammar and its borders are exact", () => {
  const parsed = parseExperienceSection(HANDBOOK);
  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.bullets, [{
    id: "E-meta-analysis-1", helpful: 2, harmful: 0, section: "Common Mistakes",
    content: "Heterogeneity above 75 percent is reported, not smoothed away.",
  }]);
  assert.ok(parsed.before.includes("You must submit"));
  assert.ok(parsed.after.startsWith("## Output"));
  assert.deepEqual(parsed.malformed, []);

  assert.equal(renderBullet(parsed.bullets[0]), "- [E-meta-analysis-1] helpful=2 harmful=0 :: Heterogeneity above 75 percent is reported, not smoothed away.");
  assert.equal(parseExperienceSection("# no section here").present, false);
  assert.deepEqual(parseExperienceSection(`## ${EXPERIENCE_SECTION_HEADING}\n\n- a plain bullet\n`).malformed, ["- a plain bullet"]);
});

test("a round trip through render and replace changes nothing else in the file", () => {
  const parsed = parseExperienceSection(HANDBOOK);
  const rebuilt = replaceExperienceSection(HANDBOOK, parsed.bullets);
  assert.deepEqual(parseExperienceSection(rebuilt).bullets, parsed.bullets);
  assert.equal(onlyExperienceSectionChanged(HANDBOOK, rebuilt).ok, true);
  assert.ok(rebuilt.includes("You must submit meta-analysis-report.md"));
  assert.ok(rebuilt.trimEnd().endsWith("One directory per run."));

  // A file with no section yet gains one at the end.
  const fresh = replaceExperienceSection("# Cap\n\nBody.\n", [{ id: "E-cap-1", helpful: 0, harmful: 0, content: "A note.", section: "Other" }]);
  assert.ok(fresh.includes(`## ${EXPERIENCE_SECTION_HEADING}`));
  assert.ok(fresh.includes("- [E-cap-1] helpful=0 harmful=0 :: A note."));
});

test("ids are allocated once and never reused", () => {
  const bullets = [
    { id: "E-meta-analysis-1", helpful: 0, harmful: 0, content: "a", section: "Other" },
    { id: "E-meta-analysis-7", helpful: 0, harmful: 0, content: "b", section: "Other" },
    { id: "E-other-cap-9", helpful: 0, harmful: 0, content: "c", section: "Other" },
  ];
  assert.equal(nextBulletId("meta-analysis", bullets), "E-meta-analysis-8");
  assert.equal(nextBulletId("meta-analysis", []), "E-meta-analysis-1");
});

test("the curator applies tags, adds, and merges — and refuses what it cannot check", () => {
  const existing = parseExperienceSection(HANDBOOK).bullets;
  const result = curateBullets(existing, {
    tags: [
      { id: "E-meta-analysis-1", tag: "harmful" },
      { id: "E-nonexistent-4", tag: "helpful" },
      { id: "E-meta-analysis-1", tag: "vibes" },
    ],
    additions: [
      { section: "Strategies and Insights", content: "Register the protocol before the search." },
      { section: "Common Mistakes", content: "  heterogeneity ABOVE 75 percent is reported, not smoothed away  " },
      { section: "Other", content: "" },
      { section: "Other", content: "a note with :: inside" },
    ],
  }, { capability: "meta-analysis" });

  assert.equal(result.bullets.find((bullet) => bullet.id === "E-meta-analysis-1")?.harmful, 1);
  assert.deepEqual(result.added, ["E-meta-analysis-2"]);
  assert.equal(result.bullets.length, 2);
  assert.equal(result.rejected.length, 5, result.rejected.map((entry) => entry.reason).join(" | "));
  assert.match(result.rejected.map((entry) => entry.reason).join("|"), /already present as E-meta-analysis-1/);
  assert.match(result.rejected.map((entry) => entry.reason).join("|"), /no note has id/);
  assert.match(result.rejected.map((entry) => entry.reason).join("|"), /an empty note/);
  assert.match(result.rejected.map((entry) => entry.reason).join("|"), /may not contain/);
  // An unknown section falls into Other rather than inventing a heading.
  const stray = curateBullets([], { additions: [{ section: "Vibes", content: "x" }] }, { capability: "c" });
  assert.equal(stray.bullets[0].section, EXPERIENCE_SUBSECTIONS[EXPERIENCE_SUBSECTIONS.length - 1]);
});

test("a merge keeps the first id and sums the counters, and needs the two notes to be alike", () => {
  const bullets = [
    { id: "E-c-1", helpful: 3, harmful: 1, content: "Check the funnel plot.", section: "Common Mistakes" },
    { id: "E-c-2", helpful: 2, harmful: 0, content: "Inspect the funnel plot for asymmetry.", section: "Common Mistakes" },
    { id: "E-c-3", helpful: 1, harmful: 0, content: "Something entirely unrelated.", section: "Other" },
  ];
  /** @param {string} left @param {string} right @returns {number} */
  const alike = (left, right) => (left.includes("funnel") && right.includes("funnel") ? 0.97 : 0.1);
  const result = curateBullets(bullets, { merges: [{ keep: "E-c-1", drop: "E-c-2", content: "Inspect the funnel plot for asymmetry." }] },
    { capability: "c", similarity: alike });
  assert.deepEqual(result.merged, [{ keep: "E-c-1", drop: "E-c-2" }]);
  const kept = result.bullets.find((bullet) => bullet.id === "E-c-1");
  assert.deepEqual([kept?.helpful, kept?.harmful, kept?.content], [5, 1, "Inspect the funnel plot for asymmetry."]);
  assert.equal(result.bullets.length, 2);
  // The dropped id is gone and is never handed out again.
  assert.equal(nextBulletId("c", result.bullets), "E-c-4");

  const unlike = curateBullets(bullets, { merges: [{ keep: "E-c-1", drop: "E-c-3" }] }, { capability: "c", similarity: alike });
  assert.deepEqual(unlike.merged, []);
  assert.match(unlike.rejected[0].reason, /less alike/);
  assert.deepEqual(curateBullets(bullets, { merges: [{ keep: "E-c-1", drop: "E-c-1" }] }, { capability: "c" }).rejected[0].reason, "a note cannot be merged into itself");
  assert.match(curateBullets(bullets, { merges: [{ keep: "E-c-1", drop: "E-c-9" }] }, { capability: "c" }).rejected[0].reason, /not in the section/);
});

test("a near-duplicate addition is refused in favour of tagging what is already there", () => {
  const bullets = [{ id: "E-c-1", helpful: 0, harmful: 0, content: "Check the funnel plot.", section: "Other" }];
  const result = curateBullets(bullets, { additions: [{ content: "Check the funnel plot for asymmetry." }] },
    { capability: "c", similarity: () => 0.99 });
  assert.deepEqual(result.added, []);
  assert.match(result.rejected[0].reason, /tag that one instead/);
});

test("notes that are blamed more than they are credited are proposed for removal, not removed", () => {
  const bullets = [
    { id: "E-c-1", helpful: 0, harmful: 3, content: "bad advice", section: "Other" },
    { id: "E-c-2", helpful: 5, harmful: 1, content: "good advice", section: "Other" },
    { id: "E-c-3", helpful: 0, harmful: 1, content: "too early to say", section: "Other" },
  ];
  assert.deepEqual(harmfulBullets(bullets).map((bullet) => bullet.id), ["E-c-1"]);
  assert.deepEqual(harmfulBullets(bullets, { minObservations: 1 }).map((bullet) => bullet.id), ["E-c-1", "E-c-3"]);
});

test("the guard refuses an edit that reached outside the section or walked a counter back", () => {
  const parsed = parseExperienceSection(HANDBOOK);
  const touchedContract = HANDBOOK.replace("You must submit meta-analysis-report.md and forest-plot.png.", "Submit whatever you like.");
  const outside = onlyExperienceSectionChanged(HANDBOOK, touchedContract);
  assert.equal(outside.ok, false);
  assert.match(outside.issues.join(" "), /above the maintained section/);

  const touchedTail = HANDBOOK.replace("One directory per run.", "Two directories per run.");
  assert.match(onlyExperienceSectionChanged(HANDBOOK, touchedTail).issues.join(" "), /below the maintained section/);

  const decremented = replaceExperienceSection(HANDBOOK, [{ ...parsed.bullets[0], helpful: 0 }]);
  assert.match(onlyExperienceSectionChanged(HANDBOOK, decremented).issues.join(" "), /counter decremented/);

  const removed = `${parsed.before}\n\n${parsed.after}`;
  assert.match(onlyExperienceSectionChanged(HANDBOOK, removed).issues.join(" "), /removed|below the maintained/);

  const malformed = replaceExperienceSection(HANDBOOK, parsed.bullets).replace("### Common Mistakes", "### Common Mistakes\n\n- hand written note");
  assert.match(onlyExperienceSectionChanged(HANDBOOK, malformed).issues.join(" "), /not notes/);

  // The legal case: a new note and an incremented counter.
  const legal = replaceExperienceSection(HANDBOOK, curateBullets(parsed.bullets, {
    tags: [{ id: "E-meta-analysis-1", tag: "helpful" }],
    additions: [{ section: "Context Cues", content: "Trial registries carry the protocol version." }],
  }, { capability: "meta-analysis" }).bullets);
  assert.deepEqual(onlyExperienceSectionChanged(HANDBOOK, legal), { ok: true, issues: [] });
});

test("the vocabularies are the ones the reflector is told to use", () => {
  assert.deepEqual([...BULLET_TAGS], ["helpful", "harmful", "neutral"]);
  assert.deepEqual([...EXPERIENCE_SUBSECTIONS], ["Strategies and Insights", "Common Mistakes", "Context Cues", "Other"]);
  assert.ok(renderExperienceSection([]).includes("Maintained by the consolidation job"));
});
