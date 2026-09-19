import assert from "node:assert/strict";
import test from "node:test";

import {
  KNOWLEDGE_BASE_FORMATS,
  SOURCE_API_FORMATS,
  SOURCE_LOCAL_TEXT_FORMATS,
  SOURCE_MEDIA_FORMATS,
  normalizeSourcePageMap,
  normalizeSourceText,
  sourceFileFormat,
  sourceFormatRoute,
  sourcePageForOffset,
} from "../index.mjs";

test("a file name's format is its lower-cased extension, and nothing else", () => {
  assert.equal(sourceFileFormat("知识库/指南/2023 房颤指南.PDF"), "pdf");
  assert.equal(sourceFileFormat("knowledge-base\\notes\\memo.Md"), "md");
  assert.equal(sourceFileFormat(".gitignore"), "", "a leading dot is a hidden file, not an extension");
  assert.equal(sourceFileFormat("README"), "");
  assert.equal(sourceFileFormat("trailing."), "");
});

test("each accepted format has exactly one route, and recordings are refused by name", () => {
  for (const format of SOURCE_API_FORMATS) assert.equal(sourceFormatRoute(`a.${format}`), "api", format);
  for (const format of SOURCE_LOCAL_TEXT_FORMATS) assert.equal(sourceFormatRoute(`a.${format}`), "local", format);
  for (const format of SOURCE_MEDIA_FORMATS) assert.equal(sourceFormatRoute(`a.${format}`), "media", format);
  // The API lists txt and md; they are read locally anyway, byte for byte.
  assert.equal(sourceFormatRoute("notes.txt"), "local");
  assert.equal(sourceFormatRoute("notes.md"), "local");
  assert.equal(sourceFormatRoute("cohort.sav"), "unsupported");
  assert.equal(sourceFormatRoute("no-extension"), "unsupported");
  // The upload list is the two parsed routes and never a recording.
  assert.deepEqual(KNOWLEDGE_BASE_FORMATS, [...new Set([...SOURCE_API_FORMATS, ...SOURCE_LOCAL_TEXT_FORMATS])].sort());
  assert.ok(!KNOWLEDGE_BASE_FORMATS.some((format) => SOURCE_MEDIA_FORMATS.includes(format)));
});

test("a page map moves with the characters normalization removes, and only those", () => {
  // A BOM, two CRLF endings and one lone CR: the capture drops the BOM and the
  // two CRs before LF, and turns the lone CR into LF without moving anything.
  const raw = "﻿page one\r\nline\rtwo\r\npage two";
  const pages = [
    { page: 1, start: 0, end: 21, status: "ok" },
    { page: 2, start: 21, end: raw.length, status: "ok" },
  ];
  const normalized = normalizeSourcePageMap(raw, pages);
  const text = normalizeSourceText({ sourceId: "src", generation: 1, docType: "other", depth: "index_only", text: raw }).text;
  assert.deepEqual(normalized, [
    { page: 1, start: 0, end: 18, status: "ok" },
    { page: 2, start: 18, end: text.length, status: "ok" },
  ]);
  // The proof that the arithmetic is the normalization's own: each page's text
  // is the same characters before and after, minus exactly what was removed.
  assert.equal(text.slice(normalized[1].start, normalized[1].end), "page two");
  assert.equal(text.slice(0, normalized[0].end), "page one\nline\ntwo\n");
});

test("a page map that cannot be trusted is dropped whole", () => {
  const text = "abcdefghij";
  assert.equal(normalizeSourcePageMap(text, []), null);
  assert.equal(normalizeSourcePageMap(text, null), null);
  assert.equal(normalizeSourcePageMap(text, [{ page: 1, start: 0, end: 11, status: "ok" }]), null, "past the end of the text");
  assert.equal(normalizeSourcePageMap(text, [{ page: 1, start: 0, end: 5, status: "ok" }, { page: 2, start: 4, end: 8, status: "ok" }]), null, "overlap");
  assert.equal(normalizeSourcePageMap(text, [{ page: 2, start: 0, end: 5, status: "ok" }, { page: 1, start: 5, end: 8, status: "ok" }]), null, "out of order");
  assert.equal(normalizeSourcePageMap(text, [{ page: 1, start: 0, end: 5, status: "blurry" }]), null, "unknown status");
  assert.equal(normalizeSourcePageMap(text, [{ page: 1, start: "0", end: 5, status: "ok" }]), null, "not an integer");
});

test("a quotation's offset names the page its first character is on", () => {
  const pageMap = [
    { page: 1, start: 0, end: 100, status: "ok" },
    { page: 2, start: 102, end: 102, status: "ocr_failed" },
    { page: 3, start: 102, end: 250, status: "ok" },
  ];
  assert.equal(sourcePageForOffset(pageMap, 0), 1);
  assert.equal(sourcePageForOffset(pageMap, 99), 1);
  // The two characters between page 1 and page 3 lead into page 3; the empty
  // OCR-failed page 2 has no characters and is never the answer.
  assert.equal(sourcePageForOffset(pageMap, 100), 3);
  assert.equal(sourcePageForOffset(pageMap, 101), 3);
  assert.equal(sourcePageForOffset(pageMap, 249), 3);
  assert.equal(sourcePageForOffset(pageMap, 250), null);
  assert.equal(sourcePageForOffset(null, 5), null);
  assert.equal(sourcePageForOffset(pageMap, -1), null);
});
