import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DEPTH_BY_TYPE,
  EXPECTED_OUTPUT_FLOORS,
  SOURCE_DOC_TYPES,
  SOURCE_KINDS,
  SOURCE_ORIGINS,
  SOURCE_TYPES,
  sourceDocTypeLabel,
  sourceFirstPassType,
  sourceKindOf,
  sourceOriginOf,
  sourceUnderstandingSchema,
} from "../index.mjs";
import { SOURCE_UNDERSTANDING_SCHEMAS } from "../src/sourceUnderstanding.mjs";

test("the knowledge base has one list of types: every row is named, counted under a chip and read with a schema", () => {
  assert.equal(new Set(SOURCE_TYPES).size, SOURCE_TYPES.length);
  assert.deepEqual(SOURCE_TYPES, SOURCE_DOC_TYPES.map((type) => type.id));
  const chips = new Set(SOURCE_KINDS.map((kind) => kind.id));
  const schemas = new Set(["paper", "procedure", "notes", "general"]);
  for (const type of SOURCE_DOC_TYPES) {
    assert.ok(/[一-鿿]/.test(type.label), `${type.id} has a Chinese name`);
    assert.ok(chips.has(type.kind), `${type.id} is counted under a known chip`);
    assert.ok(schemas.has(type.schema), `${type.id} is read with a known schema`);
  }
  // The judge chooses among these, and the list leaves room under its cap.
  assert.ok(SOURCE_TYPES.length <= 40);
  // Types the upload refuses, or that only a medical researcher's filing cabinet had, are not the whole list.
  assert.ok(!SOURCE_TYPES.includes("audio-recording") && !SOURCE_TYPES.includes("video-recording"));
  for (const wanted of ["policy-document", "drug-label", "administrative-record", "webpage", "code", "document", "dataset"]) {
    assert.ok(SOURCE_TYPES.includes(wanted), `${wanted} is in the list next to the research types`);
  }
  // The six chips a researcher sees, in the order the page shows them.
  assert.deepEqual(SOURCE_KINDS.map((kind) => kind.label), ["文献与指南", "数据表", "文档", "网页", "笔记", "图片"]);
});

test("the analysis layer and the control plane read the same list", () => {
  for (const type of Object.keys(DEFAULT_DEPTH_BY_TYPE)) assert.ok(SOURCE_TYPES.includes(type), `${type} is a type of the one list`);
  for (const type of Object.keys(EXPECTED_OUTPUT_FLOORS)) assert.ok(SOURCE_TYPES.includes(type), `${type} is a type of the one list`);
});

test("only a paper or a preprint is read with the paper slots; every other type has its own", () => {
  const paperSlots = ["doi", "design", "population", "interventionExposure", "outcomes", "effectEstimates", "limitations"];
  for (const type of SOURCE_TYPES) {
    const schema = sourceUnderstandingSchema(type);
    if (type === "published-paper" || type === "preprint-manuscript") assert.equal(schema.id, "paper");
    else {
      assert.notEqual(schema.id, "paper", `${type} is not read as a paper`);
      for (const slot of paperSlots.filter((name) => name !== "limitations")) assert.ok(!schema.slots.includes(slot), `${type} is not asked for ${slot}`);
    }
  }
  assert.equal(sourceUnderstandingSchema("research-protocol").id, "procedure");
  assert.equal(sourceUnderstandingSchema("note-memo").id, "notes");
  // A type nobody knows, and the first guess, read with the general slots.
  assert.equal(sourceUnderstandingSchema("audio-recording").id, "general");
  assert.equal(sourceUnderstandingSchema("document").id, "general");
  assert.ok(SOURCE_UNDERSTANDING_SCHEMAS.find((schema) => schema.id === "general")?.slots.includes("keyInformation"));
});

test("the first pass knows the format and the platform's own folders, and no file name decides anything", () => {
  assert.equal(sourceFirstPassType("knowledge-base/Annual_review.pdf").docType, "document");
  assert.equal(sourceFirstPassType("knowledge-base/营销方案.docx").docType, "document");
  assert.equal(sourceFirstPassType("knowledge-base/protocol-final.pdf").docType, "document");
  assert.equal(sourceFirstPassType("knowledge-base/peer-review-notes.md").docType, "document");
  assert.equal(sourceFirstPassType("knowledge-base/cohort.csv").docType, "dataset");
  assert.equal(sourceFirstPassType("knowledge-base/book.xlsx").docType, "dataset");
  assert.equal(sourceFirstPassType("knowledge-base/deck.pptx").docType, "lecture-slides");
  assert.equal(sourceFirstPassType("knowledge-base/page.html").docType, "webpage");
  assert.equal(sourceFirstPassType("knowledge-base/analysis.py").docType, "code");
  const image = sourceFirstPassType("knowledge-base/scan.png");
  assert.equal(image.docType, "image-figure");
  assert.equal(image.depth, "index_only");
  // A note is a note because of where it was written; a link's snapshot is a page, its PDF the document it is.
  assert.equal(sourceFirstPassType("knowledge-base/notes/10月3日组会记录.md").docType, "note-memo");
  assert.equal(sourceFirstPassType("knowledge-base/links/nmpa.gov.cn-notice-1a2b3c4d.md").docType, "webpage");
  assert.equal(sourceFirstPassType("knowledge-base/links/nmpa.gov.cn-guideline-1a2b3c4d.pdf").docType, "document");
  // Everything but an image is read.
  for (const file of ["a.pdf", "a.docx", "a.md", "a.txt", "a.csv", "a.pptx", "a.html", "a.json"]) {
    assert.equal(sourceFirstPassType(`knowledge-base/${file}`).depth, "structured", file);
  }
  // Every first pass lands on a type of the list.
  for (const file of ["a.pdf", "a.csv", "a.pptx", "a.html", "a.json", "a.png", "notes/a.md", "links/a.md"]) {
    assert.ok(SOURCE_TYPES.includes(sourceFirstPassType(`knowledge-base/${file}`).docType));
  }
});

test("a document's chip follows its type, and a type nobody knows is a document", () => {
  assert.equal(sourceKindOf("published-paper"), "literature");
  assert.equal(sourceKindOf("review-guideline"), "literature");
  assert.equal(sourceKindOf("dataset"), "table");
  assert.equal(sourceKindOf("drug-label"), "document");
  assert.equal(sourceKindOf("webpage"), "page");
  assert.equal(sourceKindOf("note-memo"), "note");
  assert.equal(sourceKindOf("image-figure"), "image");
  assert.equal(sourceKindOf("audio-recording"), "document");
  assert.equal(sourceDocTypeLabel("policy-document"), "制度或规范文件");
  assert.equal(sourceDocTypeLabel("audio-recording"), "其他", "an id the table does not know is never shown as the id");
});

test("where a source came from is read off where it lives", () => {
  assert.deepEqual(SOURCE_ORIGINS.map((origin) => origin.label), ["上传", "网盘", "链接", "笔记", "前沿动态", "对话产出"]);
  assert.equal(sourceOriginOf({ connectorType: "upload", path: "knowledge-base/a.pdf" }), "upload");
  assert.equal(sourceOriginOf({ connectorType: "upload", path: "knowledge-base/a/b.pdf" }), "upload");
  assert.equal(sourceOriginOf({ connectorType: "openlist", path: "openlist/docs/a.pdf" }), "drive");
  assert.equal(sourceOriginOf({ path: "knowledge-base/links/x.md" }), "link");
  assert.equal(sourceOriginOf({ path: "knowledge-base/notes/x.md" }), "note");
  assert.equal(sourceOriginOf({ path: "knowledge-base/frontier/x.pdf" }), "frontier");
  assert.equal(sourceOriginOf({ path: "knowledge-base/evidence/x.md" }), "frontier");
  assert.equal(sourceOriginOf({ path: "knowledge-base/open-access/trial/x.xlsx" }), "conversation");
  assert.equal(sourceOriginOf({ path: "knowledge-base/chat/x.docx" }), "conversation");
  // A file merely named like a folder is an upload.
  assert.equal(sourceOriginOf({ path: "knowledge-base/links.pdf" }), "upload");
});
