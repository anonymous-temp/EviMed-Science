// Run under --max-old-space-size=512 by vcrMatchSecurity.integration.test.mjs: the real import job, on the real plane and queue, over the two uploads that took a server down.
import fs from "node:fs/promises";
import path from "node:path";
import { ControlPlaneDatabase } from "../../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../../src/productStore.mjs";
import { composeVcr } from "../../src/vcrComposition.mjs";
import { createVcrDataIntake } from "../../src/vcrDataIntake.mjs";
import { createVcrUploadReceipts } from "../../src/vcrUploadReceipts.mjs";

const directory = path.join(process.env.VCR_HEAP_DIRECTORY, "under-heap");
await fs.mkdir(directory, { recursive: true });
const database = new ControlPlaneDatabase({ databaseUrl: process.env.VCR_HEAP_DATABASE_URL, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
let proposal = null;
const fetchImpl = async () => new Response(JSON.stringify({ id: "x", model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
const vcr = composeVcr({ productDatabase: database, fetchImpl, config: { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: path.join(directory, "plane"), deepseekBaseUrl: "https://api.example.org", deepseekApiKey: "test", deepseekModel: "deepseek-flash", vcrProviderAgreements: true, vcrRecordsImportSliceEntries: 20, vcrRecordsImportConcurrency: 1 } });
await vcr.store.ready();
let project = null;
const receipts = createVcrUploadReceipts({ documents: new ProductDocuments(database), sources: null, resolveProject: async () => project });
vcr.recordsOriginals.receipts = receipts;
const intake = createVcrDataIntake({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, sources: receipts, resolveProject: async () => project, recordsImport: vcr.recordsImport });
const origin = { userId: "owner", projectId: "", rootSessionId: "root", runId: "run", callId: "call" };
let sequence = 0;
const newStudy = async () => {
  const id = `heap-${++sequence}`;
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner',$1,'Project',100000000000)", [id]);
  project = { userId: "owner", id, baseDir: path.join(directory, id) };
  await fs.mkdir(project.baseDir, { recursive: true });
  origin.projectId = id;
  return vcr.store.createStudy({ userId: "owner", projectId: id, name: `Heap ${sequence}`, question: "q", dataTier: "T0" });
};
const documentsOf = async (study) => (await vcr.dataStore.listDocumentRows(study.id)).length;

/** A stored zip of many small files, written by hand. */
function zipOfMany(count) {
  const parts = [], central = [];
  let at = 0;
  const body = Buffer.from("note");
  for (let i = 0; i < count; i += 1) {
    const name = Buffer.from(`P${i}_a.txt`);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(body.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(at, 42);
    central.push(header, name);
    at += 30 + name.length + body.length;
  }
  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Math.min(count, 65535), 8); end.writeUInt16LE(Math.min(count, 65535), 10); end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

// One unterminated quote, 20 MB of it.
const quoted = await newStudy();
proposal = { tables: [{ input: 0, role: "notes", subject: "PID", text: ["NOTE"] }], files: null };
const quote = await receipts.record(project, { name: "quote.csv", bytes: Buffer.concat([Buffer.from('PID,NOTE\nA1,"'), Buffer.alloc(20 * 1024 * 1024, "x")]), sessionId: "root" });
const quoteStart = await intake(quoted, { action: "import_documents", ...quote }, origin);
for (let turn = 0; turn < 10; turn += 1) {
  const claimed = await vcr.jobs.claim({ lane: "slow" });
  if (!claimed.length) break;
  for (const job of claimed) await vcr.jobs.advance(job, { mayYield: true });
}
const quoteJob = await vcr.store.one("SELECT state FROM evimed_vcr.jobs WHERE id=$1", [quoteStart.jobId]);

// Sixty thousand files: one turn, and the queue is left with the rest.
const archived = await newStudy();
proposal = { tables: [], files: { subject: { from: "stem_part", separator: "_", index: 0 } } };
const zip = await receipts.record(project, { name: "many.zip", bytes: zipOfMany(60_000), sessionId: "root" });
const zipStart = await intake(archived, { action: "import_documents", ...zip }, origin);
const [claimed] = await vcr.jobs.claim({ lane: "slow" });
await vcr.jobs.advance(claimed, { mayYield: true });
const documents = await documentsOf(archived);
await vcr.store.query("UPDATE evimed_vcr.jobs SET state='canceled', lease_owner=NULL, lease_until=NULL WHERE id=$1", [zipStart.jobId]);
console.log(JSON.stringify({ quote: { state: String(quoteJob.state), documents: await documentsOf(quoted) }, archive: { documents }, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6) }));
await database.close();
process.exit(0);
