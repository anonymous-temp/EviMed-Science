import assert from "node:assert/strict";
import test from "node:test";
import { COMPOSITION_KEYWORDS, COMPOSITION_YEARS, composeLibrary } from "../src/sourceComposition.mjs";
import { publicationYear } from "../src/sourceMetadata.mjs";

test("a year is a year the date names, in the shapes the parser records", () => {
  assert.deepEqual(["2021", "2021-03-05", "Mar 2021", "2021/3", "Published: 5 March 2021.", "(1999)"].map(publicationYear), [2021, 2021, 2021, 2021, 2021, 1999]);
  assert.deepEqual(["", null, undefined, "March", "12345", "20213", "1850", "v2.0"].map(publicationYear), [null, null, null, null, null, null, null, null]);
});

test("the library is counted by year, newest first, and by keyword, most first, whatever the case", () => {
  const library = composeLibrary([
    { date: "2021-03-05", keywords: ["Atrial Fibrillation", "Rivaroxaban"] },
    { date: "2021", keywords: ["atrial fibrillation", "  warfarin "] },
    { date: "2019-11", keywords: ["ATRIAL FIBRILLATION", "atrial fibrillation"] },
    { date: "no year here", keywords: [] },
    { date: null, keywords: null },
    { date: "2023", keywords: ["x".repeat(61), "", 7, null, "房颤"] },
  ]);
  assert.equal(library.total, 6);
  assert.equal(library.dated, 4, "the documents that say a year");
  assert.equal(library.keyworded, 4, "the documents that say a keyword, counted once whatever its repeats");
  assert.deepEqual(library.years, [{ year: 2023, count: 1 }, { year: 2021, count: 2 }, { year: 2019, count: 1 }]);
  // The spelling met first is shown; a repeat within one document is one, a sentence for a keyword is none.
  assert.deepEqual(library.keywords, [{ keyword: "Atrial Fibrillation", count: 3 }, { keyword: "7", count: 1 }, { keyword: "Rivaroxaban", count: 1 }, { keyword: "warfarin", count: 1 }, { keyword: "房颤", count: 1 }]);
});

test("each table keeps its newest years and its most frequent keywords, and an empty library is an empty answer", () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ date: String(2000 + index), keywords: [`k${String(index).padStart(2, "0")}`] }));
  const library = composeLibrary(many);
  assert.equal(library.years.length, COMPOSITION_YEARS);
  assert.deepEqual([library.years[0].year, library.years.at(-1)?.year], [2019, 2008]);
  assert.equal(library.keywords.length, COMPOSITION_KEYWORDS);
  assert.equal(library.total, 20);
  assert.deepEqual(composeLibrary([]), { total: 0, dated: 0, keyworded: 0, years: [], keywords: [] });
});
