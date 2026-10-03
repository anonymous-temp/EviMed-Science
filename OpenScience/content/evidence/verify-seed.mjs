import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceContentHash } from "../../apps/server/src/evidenceCardContent.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const base = new URL("./", import.meta.url);
const seed = JSON.parse(await readFile(new URL("seed-cards.json", base), "utf8"));
const manifest = JSON.parse(await readFile(new URL("source-manifest.json", base), "utf8"));
const contentOnly = process.argv.includes("--content-only");
const overrideIndex = process.argv.indexOf("--source-dir");
assert(overrideIndex < 0 || process.argv[overrideIndex + 1], "--source-dir requires a cache directory.");
const sourceDirectory = overrideIndex < 0
  ? resolve(fileURLToPath(new URL("../../../", base)), manifest.sourceDirectory)
  : resolve(process.argv[overrideIndex + 1]);
const sources = new Map(manifest.sources.map((source) => [source.sourceId, source]));
assert.equal(seed.cards.length, 8);
assert.equal(seed.zones.length, 3);
assert.equal(new Set(seed.cards.map((card) => card.key)).size, seed.cards.length);
const zones = new Set(seed.zones.map((zone) => zone.key));
const cards = [];
for (const card of seed.cards) {
  assert(zones.has(card.zoneKey));
  assert.equal(card.editorial.author.kind, "ai");
  assert.equal(card.editorial.status, "review-pending");
  assert.equal(card.editorial.reviewer, undefined);
  assert(/^[\x20-\x7e]{8,100}$/.test(card.requestId));
  for (const source of card.sources) {
    const retained = sources.get(source.id);
    assert(retained, source.id);
    assert.equal(source.excerpt, retained.quote);
    assert.equal(source.sha256, retained.documentTextSha256);
    assert(source.excerpt.split(/\s+/).length <= 25);
    assert.equal(source.documentText, undefined, "Copyrighted source text must stay in the private cache.");
    if (!contentOnly) {
      const text = await readFile(resolve(sourceDirectory, retained.documentTextPath), "utf8");
      assert.equal(hash(text), source.sha256, source.id);
      assert(text.includes(source.excerpt), source.id);
      if (retained.rawDocumentPath) {
        assert.equal(hash(await readFile(resolve(sourceDirectory, retained.rawDocumentPath))), retained.fetchedSha256, source.id);
      }
    }
  }
  for (const section of [...(card.content.sections ?? []), ...(card.content.tables ?? []), ...(card.content.comparisons ?? [])]) {
    assert(section.sourceIndexes?.length);
    assert(section.sourceIndexes.every((index) => Number.isSafeInteger(index) && index > 0 && index <= card.sources.length));
  }
  for (const table of card.content.tables ?? []) {
    assert(table.rows.every((row) => row.length === table.columns.length));
  }
  for (const comparison of card.content.comparisons ?? []) {
    assert.equal(comparison.measure, "risk");
    assert.equal(comparison.denominatorUnit, "people");
    assert.equal(comparison.denominator, 2152);
    assert.equal(comparison.intervention.events, 197);
    assert.equal(comparison.control.events, 312);
    assert(comparison.note.includes("Kaplan"));
  }
  cards.push({ key: card.key, contentHash: evidenceContentHash(card) });
}
const absoluteDifference = (312 - 197) / 2152 * 100;
assert(Math.abs(absoluteDifference - 5.343866171003717) < 1e-12);
console.log(JSON.stringify({ ok: true, cardCount: cards.length, zoneCount: seed.zones.length,
  sourceCount: sources.size, retainedCacheVerified: !contentOnly, derivedAbsoluteDifferencePercentagePoints: absoluteDifference,
  cards }, null, 2));
