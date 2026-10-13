// An ordinary file as a deliverable (course correction 2026-10-12, GA16 / GA02 / GA25): the one contract kind with no
// capability and no method behind it, whose checks are exactly the decidable three — it exists, it is not empty, it opens as
// the format its name claims — and whose every finding is advice.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_KINDS,
  FILE_DELIVERABLE_KIND,
  GATE_CHECK_IDS,
  artifactPresentation,
  compareArtifacts,
  contractKindLabel,
  deliverableReviewTier,
  fileFormatIssues,
  fileFormatOf,
  isClinicalContractKind,
  runGate,
  validateTaskPlan,
  zipEntryNames,
} from "../index.mjs";
import { FILE_FORMAT_CHECK } from "../src/fileDeliverable.mjs";

const encoder = new TextEncoder();

/** A zip with the given entries stored uncompressed: the directory is what the contract reads, so the data need not be real. */
/** @param {Record<string, string>} entries */
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (/** @type {number} */ value) => [value & 0xff, (value >> 8) & 0xff];
  const u32 = (/** @type {number} */ value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
  for (const [name, body] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(body);
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...nameBytes, ...data];
    central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes]);
    parts.push(local);
    offset += local.length;
  }
  const directory = central.flat();
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(directory.length), ...u32(offset), ...u16(0)];
  return new Uint8Array([...parts.flat(), ...directory, ...end]);
}

const WORD = { "[Content_Types].xml": "<Types/>", "word/document.xml": "<w:document/>" };
const EXCEL = { "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook/>" };
const POWERPOINT = { "[Content_Types].xml": "<Types/>", "ppt/presentation.xml": "<p:presentation/>" };

test("the kind is registered, named, never reviewed and never clinical", () => {
  assert.ok(CONTRACT_KINDS.includes(FILE_DELIVERABLE_KIND));
  assert.equal(FILE_DELIVERABLE_KIND, "file-deliverable");
  assert.equal(contractKindLabel(FILE_DELIVERABLE_KIND), "文件");
  assert.equal(isClinicalContractKind(FILE_DELIVERABLE_KIND), false);
  assert.deepEqual(deliverableReviewTier(FILE_DELIVERABLE_KIND), { tier: null, safety: false });
  assert.ok(GATE_CHECK_IDS.includes(FILE_FORMAT_CHECK), "the check its findings carry is on the one axis");
});

test("an Office package opens when its directory is intact and lists the parts its format cannot do without", () => {
  assert.deepEqual(fileFormatIssues("minutes.docx", zip(WORD)), []);
  assert.deepEqual(fileFormatIssues("deliverables/budget/plan.xlsx", zip(EXCEL)), []);
  assert.deepEqual(fileFormatIssues("deck.pptx", zip(POWERPOINT)), []);
  assert.deepEqual(zipEntryNames(zip(WORD)), ["[Content_Types].xml", "word/document.xml"]);

  const missing = fileFormatIssues("minutes.docx", zip({ "[Content_Types].xml": "<Types/>" }));
  assert.equal(missing.length, 1);
  assert.equal(missing[0].code, "file_unreadable");
  assert.match(missing[0].message, /word\/document\.xml/);
  // A workbook is not a document: the parts are the format's own.
  assert.equal(fileFormatIssues("minutes.docx", zip(EXCEL)).length, 1);
});

test("a package cut short, or not a zip at all, is the corrupt file Word reports", () => {
  const whole = zip(WORD);
  for (const cut of [whole.length - 5, whole.length >> 1, 30]) {
    const broken = fileFormatIssues("minutes.docx", whole.subarray(0, cut));
    assert.equal(broken.length, 1, `cut at ${cut}`);
    assert.equal(broken[0].code, "file_unreadable");
  }
  assert.equal(fileFormatIssues("minutes.docx", encoder.encode("Dear customer, sorry.")).length, 1);
  assert.equal(zipEntryNames(encoder.encode("not a zip")), null);
  // The directory pointing outside the file is a corrupt one, not an empty one.
  const lying = Uint8Array.from(whole);
  lying[lying.length - 6] = 0xff;
  assert.equal(fileFormatIssues("minutes.docx", lying).length, 1);
});

test("an empty file is empty whatever it is named", () => {
  for (const name of ["a.docx", "a.pdf", "a.py", "a.png", "a"]) {
    const found = fileFormatIssues(name, new Uint8Array());
    assert.deepEqual(found.map((item) => item.code), ["file_empty"], name);
  }
});

test("a PDF has its header and its end; a picture has its signature", () => {
  assert.deepEqual(fileFormatIssues("a.pdf", encoder.encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n")), []);
  assert.equal(fileFormatIssues("a.pdf", encoder.encode("<html>not a pdf</html>")).length, 1);
  assert.equal(fileFormatIssues("a.pdf", encoder.encode("%PDF-1.7\n1 0 obj\n<<>>")).length, 1, "no end marker: written to the middle");
  assert.deepEqual(fileFormatIssues("a.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), []);
  assert.equal(fileFormatIssues("a.png", encoder.encode("<svg/>")).length, 1);
  assert.deepEqual(fileFormatIssues("a.jpg", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0])), []);
  assert.deepEqual(fileFormatIssues("a.gif", encoder.encode("GIF89a....")), []);
});

test("a text file decodes as UTF-8 and has no NUL byte; JSON also parses", () => {
  assert.deepEqual(fileFormatIssues("rename.py", encoder.encode("print('照片')\n")), []);
  assert.deepEqual(fileFormatIssues("notes.md", encoder.encode("# 会议纪要\n")), []);
  assert.equal(fileFormatIssues("notes.md", Uint8Array.from([0x23, 0x20, 0xff, 0xfe, 0x00, 0x41])).length, 1);
  assert.equal(fileFormatIssues("data.csv", Uint8Array.from([0x61, 0x2c, 0x00, 0x62])).length, 1);
  assert.deepEqual(fileFormatIssues("a.json", encoder.encode('{"a": 1}')), []);
  const broken = fileFormatIssues("a.json", encoder.encode("{ this is not json"));
  assert.equal(broken.length, 1);
  assert.match(broken[0].message, /JSON/);
  // A name with an extension this contract does not know is only held to existing and not being empty.
  assert.deepEqual(fileFormatIssues("archive.7z", Uint8Array.from([0, 1, 2])), []);
  assert.equal(fileFormatOf("a/b/Report.DOCX").kind, "office");
  assert.equal(fileFormatOf("Makefile").kind, "other");
});

test("the gate's verdict on a file deliverable is always ok, and says what it found", () => {
  const clean = runGate({ contractKind: FILE_DELIVERABLE_KIND, files: new Map([["rename.py", "print(1)\n"]]), fileBytes: new Map([["minutes.docx", zip(WORD)]]) });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.issues, []);
  assert.equal(clean.errorCode, null);
  assert.deepEqual(clean.metrics, { files: 2, unreadableFiles: 0 });

  const dirty = runGate({ contractKind: FILE_DELIVERABLE_KIND, files: new Map(), fileBytes: new Map([["minutes.docx", encoder.encode("PK but not really")], ["empty.xlsx", new Uint8Array()]]) });
  assert.equal(dirty.ok, true, "nothing about an ordinary file withholds it");
  assert.deepEqual(dirty.issues.map((item) => item.code).sort(), ["file_empty", "file_unreadable"]);
  assert.ok(dirty.issues.every((item) => item.severity === "advisory" && item.check === FILE_FORMAT_CHECK));
  assert.equal(dirty.metrics.unreadableFiles, 2);

  const nothing = runGate({ contractKind: FILE_DELIVERABLE_KIND, files: new Map() });
  assert.equal(nothing.ok, true);
  assert.deepEqual(nothing.issues.map((item) => item.code), ["file_deliverable_missing"]);
});

test("a text file naming a medicine is told the clinical safety rules apply, and is not asked to change", () => {
  const verdict = runGate({ contractKind: FILE_DELIVERABLE_KIND, files: new Map([["menu.md", "今晚的加餐是速效救心丸造型的蛋糕。\n"]]) });
  assert.equal(verdict.ok, true);
  const trigger = verdict.issues.find((item) => item.code === "clinical_content_without_clinical_contract");
  assert.ok(trigger, "the closed-vocabulary trigger still runs over an ordinary file");
  assert.equal(trigger.severity, "advisory");
  assert.doesNotMatch(trigger.message, /remove the clinical|resubmit|Deliver it as/i);
});

test("a plan of ordinary files needs no capability and no clarification; every other plan still does", () => {
  const files = validateTaskPlan({
    clarifications: [],
    deliverables: [
      { id: "rename-script", contractKind: "file-deliverable", title: "rename.py" },
      { id: "minutes", contractKind: "file-deliverable", capability: "", title: "会议纪要.docx", acceptance: [] },
    ],
  });
  assert.equal(files.ok, true, JSON.stringify(files.issues));
  assert.deepEqual(files.plan?.clarifications, []);

  // One professional deliverable among the files brings the professional rules back.
  const mixed = validateTaskPlan({
    clarifications: [],
    deliverables: [
      { id: "script", contractKind: "file-deliverable", title: "s" },
      { id: "report", contractKind: "clinical-evidence-report", title: "r" },
    ],
  });
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.issues.map((item) => item.code).sort(), ["plan_invalid", "plan_missing_clarifications"]);

  // And nothing else is relaxed: a plan with no deliverables still says why and still records its assumptions.
  assert.deepEqual(validateTaskPlan({ clarifications: [], deliverables: [] }).issues.map((item) => item.code).sort(), ["plan_invalid", "plan_missing_clarifications"]);
  assert.equal(validateTaskPlan({ clarifications: ["pick the first sheet"], deliverables: [{ id: "x", contractKind: "file-deliverable", title: "x" }] }).ok, true);
  // The kind is the only one a plan may leave without a capability.
  assert.equal(validateTaskPlan({ clarifications: ["a"], deliverables: [{ id: "x", contractKind: "research-brief", title: "x" }] }).ok, false);
});

test("a script the conversation was asked for is a draft the reader opens; a capability's scripts stay work", () => {
  assert.equal(artifactPresentation("rename.py").role, "work");
  assert.equal(artifactPresentation("rename.py").readable, false);
  assert.equal(artifactPresentation("rename.py", "draft").role, "draft");
  assert.equal(artifactPresentation("rename.py", "draft").readable, true);
  assert.equal(artifactPresentation("rename.py", "report").readable, false);
  assert.equal(artifactPresentation("revision-notes.md", "draft").role, "work");
  // …and it comes after the documents, workbooks and pictures beside it, whose builder it may be.
  const refs = [{ path: "make_budget.py", role: "draft" }, { path: "预算表.xlsx", role: "data" }, { path: "chart.png", role: "figure" }, { path: "纪要.docx", role: "document" }];
  assert.deepEqual([...refs].sort(compareArtifacts).map((ref) => ref.path), ["纪要.docx", "预算表.xlsx", "chart.png", "make_budget.py"]);
  assert.deepEqual([{ path: "rename.py", role: "draft" }].sort(compareArtifacts).map((ref) => ref.path), ["rename.py"], "alone, it is the whole answer");
});
