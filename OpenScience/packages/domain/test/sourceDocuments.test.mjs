import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_API_FORMATS,
  SOURCE_CODE_FORMATS,
  SOURCE_LOCAL_TEXT_FORMATS,
  SOURCE_MEDIA_FORMATS,
  SOURCE_ORIGINAL_CODES,
  SOURCE_TEXT_SAMPLE_BYTES,
  knownErrorCodeMessage,
  normalizeSourcePageMap,
  normalizeSourceText,
  sourceBytesAreText,
  sourceFileFormat,
  sourceFirstPassType,
  sourceFormatRoute,
  sourcePageForOffset,
  sourceReadRoute,
} from "../index.mjs";

test("a file name's format is its lower-cased extension, and nothing else", () => {
  assert.equal(sourceFileFormat("知识库/指南/2023 房颤指南.PDF"), "pdf");
  assert.equal(sourceFileFormat("knowledge-base\\notes\\memo.Md"), "md");
  assert.equal(sourceFileFormat(".gitignore"), "", "a leading dot is a hidden file, not an extension");
  assert.equal(sourceFileFormat("README"), "");
  assert.equal(sourceFileFormat("trailing."), "");
});

test("a name says where a file is read, and no name is refused", () => {
  for (const format of SOURCE_API_FORMATS) assert.equal(sourceFormatRoute(`a.${format}`), "api", format);
  for (const format of SOURCE_LOCAL_TEXT_FORMATS) assert.equal(sourceFormatRoute(`a.${format}`), "local", format);
  for (const format of SOURCE_MEDIA_FORMATS) assert.equal(sourceFormatRoute(`a.${format}`), "media", format);
  const listed = [...SOURCE_API_FORMATS, ...SOURCE_LOCAL_TEXT_FORMATS, ...SOURCE_MEDIA_FORMATS];
  assert.equal(new Set(listed).size, listed.length, "a format is on one list");
  // The API lists txt and md; they are read locally anyway, byte for byte. HTML stays the API's.
  assert.equal(sourceFormatRoute("notes.txt"), "local");
  assert.equal(sourceFormatRoute("notes.md"), "local");
  assert.equal(sourceFormatRoute("page.html"), "api");
  // GA07, the probe of 2026-10-12: what a general project holds beside its papers. Each was refused with 415.
  for (const name of ["app.ts", "index.js", "main.go", "Main.java", "site.css", "analysis.ipynb", "pyproject.toml", "setup.ini", "paper.tex", "refs.bib",
    "figure.svg", "run.sh", "letter.eml", "server.log", "model.do", "macro.sas", "talk.srt", "relations.jsonl", "events.ndjson", "README.markdown"]) {
    assert.equal(sourceFormatRoute(name), "local", name);
  }
  // The mirror of the compiled wiki and graph is text the platform itself writes.
  assert.equal(sourceFormatRoute("knowledge-base/wiki/aspirin.md"), "local");
  assert.equal(sourceFormatRoute("knowledge-base/kg/relations.jsonl"), "local");
  // A name no list knows is not refused: its bytes decide.
  for (const name of ["cohort.sav", "no-extension", "Makefile", "LICENSE", ".env", "Dockerfile.evimed", "src.zip", "data.parquet", "backup.tar", "notes.gz"]) {
    assert.equal(sourceFormatRoute(name), "engine", name);
  }
});

test("bytes say whether a file with a name nobody listed is text", () => {
  assert.equal(sourceBytesAreText(new TextEncoder().encode("all: build\n\tnode build.mjs\n")), true);
  assert.equal(sourceBytesAreText(new TextEncoder().encode("许可协议：MIT\n")), true);
  assert.equal(sourceBytesAreText(new Uint8Array(0)), true, "an empty file is text with nothing in it");
  assert.equal(sourceBytesAreText(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), false, "a zip holds NUL bytes");
  assert.equal(sourceBytesAreText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00])), false, "UTF-16 is not recognised");
  assert.equal(sourceBytesAreText(Uint8Array.from([0xc0, 0xfb, 0xb7, 0xa5])), false, "GB18030 without a listed name is not recognised");
  // A sequence the sample cuts in two is not an error, and nothing past the sample is looked at.
  const cut = new Uint8Array(SOURCE_TEXT_SAMPLE_BYTES + 8).fill(0x61);
  cut.set(new TextEncoder().encode("中"), SOURCE_TEXT_SAMPLE_BYTES - 1);
  assert.equal(sourceBytesAreText(cut), true);
  const late = new Uint8Array(SOURCE_TEXT_SAMPLE_BYTES + 8).fill(0x61);
  late[SOURCE_TEXT_SAMPLE_BYTES + 1] = 0;
  assert.equal(sourceBytesAreText(late), true, "the reader, not the sample, meets a NUL that far in");

  assert.equal(sourceReadRoute("Makefile", new TextEncoder().encode("all:\n")), "local");
  assert.equal(sourceReadRoute("Dockerfile.evimed", new TextEncoder().encode("FROM debian\n")), "local");
  assert.equal(sourceReadRoute("src.zip", Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00])), "engine");
  // A listed text name whose bytes are not text: `.ts` is TypeScript and an MPEG transport stream alike.
  assert.equal(sourceReadRoute("clip.ts", Uint8Array.from([0x47, 0x40, 0x00, 0x10, 0x00])), "engine");
  assert.equal(sourceReadRoute("app.ts", new TextEncoder().encode("export const a = 1;\n")), "local");
  // A listed text name in another encoding stays local: its reader decodes it.
  assert.equal(sourceReadRoute("剂量表.csv", Uint8Array.from([0xc0, 0xfb, 0xb7, 0xa5])), "local");
  // The bytes never move a document off the API's route or make a recording readable.
  assert.equal(sourceReadRoute("scan.pdf", new TextEncoder().encode("plain")), "api");
  assert.equal(sourceReadRoute("visit.mp4", new TextEncoder().encode("plain")), "media");
});

test("the first pass names code as code, a message as a message, and reads nothing of a recording", () => {
  for (const format of SOURCE_CODE_FORMATS) assert.equal(sourceFirstPassType(`knowledge-base/a.${format}`).docType, "code", format);
  assert.deepEqual([sourceFirstPassType("knowledge-base/letter.eml").docType, sourceFirstPassType("knowledge-base/letter.eml").depth], ["message-export", "structured"]);
  assert.deepEqual([sourceFirstPassType("knowledge-base/paper.tex").docType, sourceFirstPassType("knowledge-base/Makefile").docType, sourceFirstPassType("knowledge-base/src.zip").docType],
    ["document", "document", "document"], "a manuscript and a name nobody listed are documents until they are read");
  assert.deepEqual([sourceFirstPassType("knowledge-base/figure.svg").docType, sourceFirstPassType("knowledge-base/figure.svg").depth], ["image-figure", "index_only"]);
  for (const format of SOURCE_MEDIA_FORMATS) {
    const first = sourceFirstPassType(`knowledge-base/a.${format}`);
    assert.deepEqual([first.docType, first.depth], ["other", "skip"], format);
  }
  // The compiled graph's relations are a page of the mirror whatever their format.
  assert.deepEqual([sourceFirstPassType("knowledge-base/kg/relations.jsonl").docType, sourceFirstPassType("knowledge-base/kg/relations.jsonl").depth], ["wiki-page", "index_only"]);
});

test("every reason a document is kept without text has a sentence a person can read", () => {
  assert.deepEqual([...SOURCE_ORIGINAL_CODES], ["source_original_media", "source_original_unread", "source_original_engine_failed", "source_original_no_text"]);
  for (const code of SOURCE_ORIGINAL_CODES) {
    const sentence = knownErrorCodeMessage(code) ?? "";
    assert.match(sentence, /原件/, code);
    assert.doesNotMatch(sentence, /[「」]/, code);
  }
  // The upload refusal that named recordings is gone with the refusal.
  assert.equal(knownErrorCodeMessage("source_media_unsupported"), null);
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

test("page markers get lines of their own and leave every page's characters as they were", async () => {
  const { renderSourcePageMarkers } = await import("../index.mjs");
  const text = "第一页的正文，跨页的句子开始于此处而第二页继续。第三页";
  const pageMap = [
    { page: 1, start: 0, end: 16, status: "ok" },
    { page: 2, start: 16, end: 24, status: "ok" },
    { page: 3, start: 24, end: 24, status: "ocr_failed" },
    { page: 4, start: 24, end: text.length, status: "ok" },
  ];
  const rendered = renderSourcePageMarkers(text, pageMap);
  assert.equal(rendered, [
    "<!-- page 1 -->",
    text.slice(0, 16),
    "<!-- page 2 -->",
    text.slice(16, 24),
    "<!-- page 3: ocr_failed -->",
    "<!-- page 4 -->",
    text.slice(24),
  ].join("\n"));
  // Every page's own characters appear verbatim, so a quotation taken from
  // inside any one page is found in the rendered file and in the capture alike.
  for (const entry of pageMap) assert.ok(rendered.includes(text.slice(entry.start, entry.end)), `page ${entry.page}`);
  assert.equal(renderSourcePageMarkers(text, null), text);
  assert.equal(renderSourcePageMarkers("a\nb", [{ page: 1, start: 0, end: 2, status: "ok" }, { page: 2, start: 2, end: 3, status: "ok" }]),
    "<!-- page 1 -->\na\n<!-- page 2 -->\nb", "a page that begins after a newline needs no second one");
});
