// The few papers a week's self-research reads whole: through the platform's web reader, from the paper's identifier, never by crawling.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { boundedText, createEvolutionFullTextReader } from "../src/evolutionFullText.mjs";
import { extractHtml } from "../src/webReadExtract.mjs";

// The page arXiv served for 2610.11959 on 2026-10-10, read the way the platform's web reader reads a page.
const page = gunzipSync(readFileSync(new URL("./fixtures/evolution/arxiv-html-2610.11959.html.gz", import.meta.url))).toString("utf8");
const read = (/** @type {string} */ url) => ({ text: extractHtml(page, { baseUrl: url }).text, receipt: { finalUrl: url } });
const webError = (/** @type {string} */ code) => Object.assign(new Error(code), { code });

test("a paper is read whole from its arXiv HTML page, bounded, and only that page is asked for", async () => {
  /** @type {string[]} */
  const asked = [];
  const reader = createEvolutionFullTextReader({ maxChars: 60_000, webReader: { read: async (url, options) => { asked.push(url); assert.ok(options.signal instanceof AbortSignal); return read(url); } } });
  const found = await reader.read({ arxivId: "2610.11959" });
  assert.deepEqual(asked, ["https://arxiv.org/html/2610.11959"], "one page, found by the identifier");
  assert.equal(found.kind, "full");
  if (found.kind !== "full") return;
  assert.equal(found.url, "https://arxiv.org/html/2610.11959");
  assert.ok(found.text.length > 40_000 && found.text.length <= 60_000 && Buffer.byteLength(found.text) <= 120_000);
  assert.equal(found.truncated, true, "the page is far longer than a card can quote from, and says it was cut");
  assert.match(found.text, /MiMo-V2\.6/);
  const short = await createEvolutionFullTextReader({ maxChars: 1_000_000, webReader: { read: async url => ({ text: "A short paper. ".repeat(100), receipt: { finalUrl: url } }) } }).read({ arxivId: "2610.00003" });
  assert.equal(short.kind === "full" && short.truncated, false, "a text within the bounds is kept whole");
});

test("a page that is not there is the usual reason to try the PDF, which the reader's document parser turns into text", async () => {
  /** @type {string[]} */
  const asked = [];
  const reader = createEvolutionFullTextReader({ webReader: { read: async url => {
    asked.push(url);
    if (url.includes("/html/")) throw webError("web_read_not_found");
    return { text: "Extracted from the PDF. ".repeat(20), receipt: { finalUrl: url } };
  } } });
  const found = await reader.read({ arxivId: "2301.00001" });
  assert.deepEqual(asked, ["https://arxiv.org/html/2301.00001", "https://arxiv.org/pdf/2301.00001"]);
  assert.equal(found.kind === "full" && found.url, "https://arxiv.org/pdf/2301.00001");
});

test("a paper that cannot be read whole is read from its abstract, with the reason, and is never an error", async () => {
  const answer = (/** @type {() => Promise<any>} */ read) => createEvolutionFullTextReader({ webReader: { read } }).read({ arxivId: "2610.00001" });
  assert.deepEqual(await createEvolutionFullTextReader({ webReader: null }).read({ arxivId: "2610.00001" }), { kind: "abstract", reason: "no_reader" });
  assert.deepEqual(await createEvolutionFullTextReader({ webReader: { read: async () => ({ text: "" }) } }).read({ arxivId: null }), { kind: "abstract", reason: "not_arxiv" });
  // Refused by robots.txt, or by a private address: the PDF sits on the same host, so it is not asked for.
  /** @type {string[]} */
  const asked = [];
  assert.deepEqual(await answer(async () => { asked.push("x"); throw webError("web_read_robots_disallowed"); }), { kind: "abstract", reason: "web_read_robots_disallowed" });
  assert.equal(asked.length, 1);
  // Not there and no document parser: the reason is the last thing that went wrong.
  assert.deepEqual(await answer(async () => { throw webError("web_read_not_found"); }), { kind: "abstract", reason: "web_read_not_found" });
  assert.deepEqual(await answer(async () => { throw new TypeError("socket hang up with a secret in it"); }), { kind: "abstract", reason: "unreachable" });
  assert.deepEqual(await answer(async () => ({ text: "   " })), { kind: "abstract", reason: "empty" });
});

test("the text kept is bounded in bytes as well as characters, and never cut inside a character", async () => {
  const mathematics = "\u2211\u222b".repeat(70_000); // three bytes a character
  const kept = boundedText(mathematics, 100_000);
  assert.ok(Buffer.byteLength(kept) <= 120_000);
  assert.ok(!kept.includes("\uFFFD"), "no half character");
  assert.ok(mathematics.startsWith(kept));
  assert.equal(boundedText("short", 100), "short");
  const found = await createEvolutionFullTextReader({ maxChars: 100_000, webReader: { read: async () => ({ text: mathematics, receipt: { finalUrl: "https://arxiv.org/html/2610.00002" } }) } }).read({ arxivId: "2610.00002" });
  assert.equal(found.kind === "full" && found.truncated, true);
});
