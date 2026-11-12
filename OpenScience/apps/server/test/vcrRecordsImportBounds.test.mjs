// What one upload may cost the server: an unterminated quote and an archive of tens of thousands of entries, each read under a 512 MB heap in a process of its own, and the reader's limits one by one.
// What is over a limit is counted and said, and what remains goes on.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { strToU8, zipSync } from "fflate";
import { readSubjectNote } from "../src/vcrMatchJudge.mjs";
import { delimitedRows, sampleRows, VCR_RECORDS_IMPORT_BOUNDS } from "../src/vcrRecordsImport.mjs";
import { openZipEntries } from "../src/vcrZipReader.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = (name) => pathToFileURL(path.join(HERE, "..", "src", name)).href;
let directory;
before(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-s9-bounds-")); });
after(() => { fs.rmSync(directory, { recursive: true, force: true }); });

const rowsOf = async (text, ...rest) => { const rows = []; for await (const row of delimitedRows((async function* () { yield Buffer.from(text); })(), ...rest)) rows.push(row); return rows; };

/** The reader it replaced, kept here as the oracle of what a well-formed file means. */
async function* oracle(chunks, delimiter = ",") {
  const decoder = new TextDecoder("utf-8");
  let cell = "", row = [], quoted = false, afterQuote = false, first = true;
  function* feed(text) {
    for (let at = 0; at < text.length; at += 1) {
      const character = text[at];
      if (quoted) { if (character === '"') { quoted = false; afterQuote = true; } else cell += character; continue; }
      if (afterQuote && character === '"') { cell += '"'; quoted = true; afterQuote = false; continue; }
      afterQuote = false;
      if (character === '"' && cell === "") { quoted = true; continue; }
      if (character === delimiter) { row.push(cell); cell = ""; continue; }
      if (character === "\n" || character === "\r") {
        if (character === "\r" && text[at + 1] === "\n") at += 1;
        if (row.length || cell !== "") { row.push(cell); yield row; }
        row = []; cell = "";
        continue;
      }
      cell += character;
    }
  }
  for await (const chunk of chunks) {
    let text = decoder.decode(chunk, { stream: true });
    if (first) { text = text.replace(/^\uFEFF/u, ""); first = false; }
    yield* feed(text);
  }
  yield* feed(decoder.decode());
  if (row.length || cell !== "") { row.push(cell); yield row; }
}

test("the streaming reader means what the old one meant, on random files cut into random chunks", async () => {
  const pieces = ['a', 'b', '患', ',', ',', '\n', '\r\n', '\r', '"', '""', '"x"', '"x,y"', '"a""b"', '"l1\nl2"', ' ', '\uFEFF', 'x"y', '""z'];
  let seed = 12345;
  const random = (most) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % most; };
  for (let round = 0; round < 400; round += 1) {
    const text = Array.from({ length: random(40) }, () => pieces[random(pieces.length)]).join("");
    const bytes = Buffer.from(text);
    const cut = [];
    for (let at = 0; at < bytes.length;) { const size = 1 + random(9); cut.push(bytes.subarray(at, at + size)); at += size; }
    const source = () => (async function* () { yield* cut; })();
    const expected = [];
    for await (const row of oracle(source())) expected.push(row);
    const actual = [];
    for await (const row of delimitedRows(source())) actual.push(row);
    assert.deepEqual(actual, expected, JSON.stringify(text));
  }
});

test("a cell over its limit marks the row, the rows after it still read, and no text of it is kept", async () => {
  const long = "x".repeat(VCR_RECORDS_IMPORT_BOUNDS.cellChars + 10);
  const rows = await rowsOf(`id,note\n1,"${long}"\n2,ok\n`);
  assert.deepEqual([...rows[0]], ["id", "note"]);
  assert.equal(rows[1].over, "vcr_import_cell_too_long");
  assert.equal(rows[1].length, 0, "the row keeps nothing");
  assert.deepEqual([...rows[2]], ["2", "ok"]);
});

test("a row over its limits, in characters and in cells, is marked", async () => {
  const half = "x".repeat(Math.floor(VCR_RECORDS_IMPORT_BOUNDS.rowChars / 2) + 1);
  const rows = await rowsOf(`${half},${half},${half}\n1,2\n`, ",", "utf-8", { cellChars: VCR_RECORDS_IMPORT_BOUNDS.rowChars });
  assert.equal(rows[0].over, "vcr_import_row_too_long");
  assert.deepEqual([...rows[1]], ["1", "2"]);
  const wide = await rowsOf(`${Array.from({ length: VCR_RECORDS_IMPORT_BOUNDS.rowCells + 1 }, () => "c").join(",")}\n1\n`);
  assert.equal(wide[0].over, "vcr_import_row_too_long");
  assert.deepEqual([...wide[1]], ["1"]);
});

test("a sample's cells and header are cut to what shows a shape", () => {
  const sampled = sampleRows([["姓".repeat(300), "b"], ["值".repeat(300), "2"]], 1);
  assert.equal([...sampled.header[0]].length, 80);
  assert.equal([...sampled.rows[0][0]].length, 80);
  assert.equal(sampled.input, 1);
});

test("one person's read holds their newest documents up to what a read may hold, and says how many it left out", async () => {
  const roster = Array.from({ length: 2_005 }, (_, at) => ({ id: `d${String(at).padStart(5, "0")}`, chars: 4, visibleAt: `2026-${String(1 + (at % 12)).padStart(2, "0")}-01` }));
  const reads = [];
  const documents = { async runtimeRead(_study, { documentId }) { reads.push(documentId); return { id: documentId, text: "一句。" }; } };
  const note = await readSubjectNote({ study: {}, subjectKey: "P", documents, roster });
  assert.equal(reads.length, 2_000);
  assert.equal(note.documentsLeftOut, 5);
  const heavy = await readSubjectNote({ study: {}, subjectKey: "P", documents, roster: [{ id: "old", chars: 3_000_000, visibleAt: "2020-01-01" }, { id: "mid", chars: 3_000_000, visibleAt: "2021-01-01" }, { id: "new", chars: 10, visibleAt: "2022-01-01" }] });
  assert.equal(heavy.documentsLeftOut, 1, "the oldest goes first");
  assert.deepEqual(heavy.documentIds, ["mid", "new"]);
  const small = await readSubjectNote({ study: {}, subjectKey: "P", documents, roster: [{ id: "only", chars: 9_000_000 }] });
  assert.equal(small.documentsLeftOut, undefined, "one document is always read");
});

/** A stored zip of n small entries, written by hand: about a hundred bytes an entry. */
function zipOfMany(file, count) {
  const out = fs.openSync(file, "w");
  let at = 0;
  const central = [];
  const body = Buffer.from("note");
  for (let i = 0; i < count; i += 1) {
    const name = Buffer.from(`p${i}.txt`);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    fs.writeSync(out, local); fs.writeSync(out, name); fs.writeSync(out, body);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(body.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(at, 42);
    central.push(header, name);
    at += 30 + name.length + body.length;
  }
  const directory_ = Buffer.concat(central);
  fs.writeSync(out, directory_);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Math.min(count, 65535), 8); end.writeUInt16LE(Math.min(count, 65535), 10); end.writeUInt32LE(directory_.length, 12); end.writeUInt32LE(at, 16);
  fs.writeSync(out, end);
  fs.closeSync(out);
}

test("a zip is read by its directory: names, sizes and bytes, stored and deflated, with only the first N kept and the rest counted", async () => {
  const deflated = path.join(directory, "deflated.zip");
  fs.writeFileSync(deflated, zipSync({ "a/甲_1.txt": strToU8("第一份".repeat(100)), "a/乙_2.txt": strToU8("第二份"), "b/": new Uint8Array(0), "__MACOSX/x": strToU8("skip") }));
  const opened = await openZipEntries(deflated, { maxEntries: 10, ignore: /(^|\/)__MACOSX(\/|$)/u });
  assert.deepEqual(opened.entries.map((entry) => entry.path).sort(), ["a/乙_2.txt", "a/甲_1.txt"]);
  assert.equal(opened.over, 0);
  const chunks = [];
  for await (const chunk of opened.entries.find((entry) => entry.path.endsWith("_1.txt")).stream()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "第一份".repeat(100));
  const many = path.join(directory, "many.zip");
  zipOfMany(many, 300);
  const kept = await openZipEntries(many, { maxEntries: 100 });
  assert.equal(kept.entries.length, 100);
  assert.equal(kept.over, 200);
  const one = [];
  for await (const chunk of kept.entries[99].stream()) one.push(chunk);
  assert.equal(Buffer.concat(one).toString(), "note");
});

test("an entry that inflates past what it may hold stops, by name, and a damaged archive is an answer and not a crash", async () => {
  const bomb = path.join(directory, "bomb.zip");
  fs.writeFileSync(bomb, zipSync({ "big.csv": new Uint8Array(4 * 1024 * 1024) }));
  const { entries } = await openZipEntries(bomb, { maxEntries: 10 });
  await assert.rejects(async () => { for await (const _ of entries[0].stream({ maxBytes: 1024 * 1024 })) { /* read */ } }, { code: "vcr_data_file_too_large" });
  const broken = path.join(directory, "broken.zip");
  fs.writeFileSync(broken, Buffer.from("this is not an archive at all, whatever its name says"));
  await assert.rejects(() => openZipEntries(broken, { maxEntries: 10 }), { code: "vcr_document_unreadable" });
});

test("20 MB of one unterminated quote, under a 512 MB heap, is one row marked over and a process that lives", { timeout: 120_000 }, async () => {
  const child = `
    import { delimitedRows } from ${JSON.stringify(moduleUrl("vcrRecordsImport.mjs"))};
    const chunk = Buffer.from('x'.repeat(256 * 1024));
    async function* source() { yield Buffer.from('id,note\\n1,"'); for (let i = 0; i < 80; i += 1) yield chunk; }
    const rows = [];
    for await (const row of delimitedRows(source())) rows.push({ cells: row.length, over: row.over ?? null });
    console.log(JSON.stringify({ rows, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6) }));`;
  const { stdout } = await run(process.execPath, ["--max-old-space-size=512", "--input-type=module", "-e", child], { cwd: HERE, maxBuffer: 1024 * 1024 });
  const answer = JSON.parse(stdout);
  assert.deepEqual(answer.rows, [{ cells: 2, over: null }, { cells: 0, over: "vcr_import_cell_too_long" }]);
  assert.ok(answer.heapMB < 200, `heap ${answer.heapMB} MB`);
});

test("60,000 entries, and 500,000 declared past the limit, under a 512 MB heap", { timeout: 120_000 }, async () => {
  const many = path.join(directory, "sixty.zip");
  zipOfMany(many, 60_000);
  const child = `
    import { openZipEntries } from ${JSON.stringify(moduleUrl("vcrZipReader.mjs"))};
    const opened = await openZipEntries(${JSON.stringify(many)}, { maxEntries: 50000 });
    let bytes = 0;
    for await (const chunk of opened.entries.at(-1).stream()) bytes += chunk.length;
    console.log(JSON.stringify({ entries: opened.entries.length, over: opened.over, bytes, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6) }));`;
  const { stdout } = await run(process.execPath, ["--max-old-space-size=512", "--input-type=module", "-e", child], { cwd: HERE, maxBuffer: 1024 * 1024 });
  const answer = JSON.parse(stdout);
  assert.deepEqual([answer.entries, answer.over, answer.bytes], [50_000, 10_000, 4]);
  assert.ok(answer.heapMB < 120, `heap ${answer.heapMB} MB`);
});
