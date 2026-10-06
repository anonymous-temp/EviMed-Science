// What the platform's own modules could not do, handed to 循证进化 as research leads (evidence-flywheel F20, 2026-10-06): the closed vocabulary of each source, that a
// tenant's words never cross, the daily bound, the programme scan over its own decision records, the two offers, and that the intake keeps its old reductions.
import assert from "node:assert/strict";
import test from "node:test";
import { EVOLUTION_LEAD_SOURCES, VCR_ENGINE_METHOD_IDS } from "@evimed/domain";
import { EvolutionService } from "../src/evolutionService.mjs";
import { EvolutionWorker } from "../src/evolutionWorker.mjs";
import { COMMUNICATION_CODE, LEAD_ENTITY_KEY_LIMIT, MODULE_LEAD_SOURCES, VCR_METHOD_FAMILIES, createEvolutionLeadSources, evolutionLeadSourceMetricFamilies, leadEntityKeys, moduleLeadPayload } from "../src/evolutionLeadSources.mjs";

function fixture() {
  /** @type {Map<string, any>} */ const rows = new Map();
  /** @type {any[]} */ const jobs = [];
  let time = new Date("2026-10-06T04:00:00Z");
  const documents = {
    async get(owner, kind, id) { return structuredClone(rows.get(`${owner}:${kind}:${id}`) ?? null); },
    async list(owner, kind, { filter }) { return { items: [...rows.entries()].filter(([key, row]) => key.startsWith(`${owner}:${kind}:`) && Object.entries(filter).every(([name, value]) => row.payload[name] === value)).map(([, row]) => structuredClone(row)), nextCursor: null }; },
    async put(owner, kind, id, payload, { expectedRevision, projectId }) {
      const key = `${owner}:${kind}:${id}`;
      const old = rows.get(key);
      if ((old?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error("conflict"), { code: "product_revision_conflict" });
      const row = { id, payload: structuredClone(payload), projectId, revision: expectedRevision + 1, createdAt: old?.createdAt ?? time.toISOString(), updatedAt: time.toISOString() };
      rows.set(key, row);
      return structuredClone(row);
    },
  };
  const service = new EvolutionService({ documents, ownerId: "operator", now: () => time,
    jobs: { async enqueue(owner, kind, payload, options) { const existing = jobs.find((job) => job.key === options.idempotencyKey); if (existing) return existing; const job = { owner, kind, payload, key: options.idempotencyKey }; jobs.push(job); return job; } } });
  service.callbacks.leadAccountCount=async id=>new Set([...rows.entries()].filter(([,row])=>row.payload.recordType==='evolution-lead-occurrence'&&row.payload.leadId===id&&row.payload.scope==='owner').map(([key])=>key.split(':')[0])).size;
  return { service, rows, jobs, advance(ms) { time = new Date(time.getTime() + ms); } };
}
const leads = (f) => [...f.rows.values()].filter((row) => row.payload.recordType === "evolution-lead").map((row) => row.payload);

test("the three sources are the domain's lead sources, and a lead from one is a closed code with closed keys", () => {
  for (const source of MODULE_LEAD_SOURCES) assert.ok(EVOLUTION_LEAD_SOURCES.includes(source), source);
  assert.deepEqual(moduleLeadPayload({ source: "evidence-programme", gapCode: "method-implementation", code: "adr-analysis", entityKeys: ["drug:apixaban", "disease:atrial-fibrillation", "org:fda", "doi:10.1000/x", "pmid:123", "reg:NCT00000001", "nonsense"] }),
    { track: "M", source: "evidence-programme", gapCode: "method-implementation", code: "adr-analysis", entityKeys: ["disease:atrial-fibrillation", "drug:apixaban"] });
  assert.deepEqual(moduleLeadPayload({ source: "virtual-study", gapCode: "method-missing", code: "vcr-comparator", endpoint: "time_to_event", entityKeys: [] }).endpoint, "time_to_event");
  assert.equal("endpoint" in moduleLeadPayload({ source: "virtual-study", gapCode: "method-missing", code: "vcr-design", endpoint: "a patient called Zhang", entityKeys: [] }), false, "an endpoint outside the engine's three is dropped");
  assert.equal(leadEntityKeys(Array.from({ length: 30 }, (_, index) => `drug:d${String(index).padStart(2, "0")}`)).length, LEAD_ENTITY_KEY_LIMIT);
  assert.deepEqual(VCR_METHOD_FAMILIES, [...new Set(VCR_ENGINE_METHOD_IDS.map((id) => id.split(".")[0]))].sort());
});

test("a code outside the source's closed list, the wrong gap code and a source this module does not own are refused by name", () => {
  for (const input of [
    { source: "evidence-programme", gapCode: "method-implementation", code: "private patient narrative" },
    { source: "evidence-programme", gapCode: "method-missing", code: "adr-analysis" },
    { source: "communication", gapCode: "method-missing", code: "free text from a tenant" },
    { source: "virtual-study", gapCode: "method-missing", code: "comparator.secret_method" },
    { source: "literature", gapCode: "method-missing", code: "adr-analysis" }, { source: "handbook", gapCode: "method-missing", code: COMMUNICATION_CODE }, {},
  ]) assert.throws(() => moduleLeadPayload(input), { code: "evolution_lead_invalid", status: 400 }, JSON.stringify(input));
});

test("tenant recurrence retains closed codes, counts accounts and queues only at five", async()=>{
 const f=fixture();
 const input={track:'M',source:'communication',gapCode:'method-missing',code:COMMUNICATION_CODE,entityKeys:['drug:private'],method:'private narrative',papers:['private'],userId:'alice',projectId:'p1',sourceEventId:'e1'};
 const first=await f.service.addLead(input);
 assert.equal(first.payload.status,'accumulating');assert.deepEqual(first.payload.entityKeys,[]);
 assert.equal(JSON.stringify(first.payload).includes('private'),false);
 await f.service.addLead(input);
 for(const userId of ['bob','carl'])await f.service.addLead({...input,userId,sourceEventId:`${userId}:e1`});
 let current=await f.service.get(first.id);assert.equal(current.payload.distinctAccounts,3);assert.equal(current.payload.occurrences,3);assert.equal(f.jobs.length,0);
 for(const userId of ['dana','eli'])await f.service.addLead({...input,userId,sourceEventId:`${userId}:e1`});
 current=await f.service.get(first.id);assert.equal(current.payload.distinctAccounts,5);assert.equal(current.payload.status,'queued');assert.equal(f.jobs.length,1);
 await assert.rejects(f.service.addLead({...input,code:'private patient narrative'}),{code:'evolution_lead_invalid'});
});

test("the programme scan reads its own decisions: an engine episode that ended with no receipt is a lead for that engine's capability with the zone's subject keys; nothing else is", async () => {
  const f = fixture();
  const decisions = [{
    actions: [
      { zone: "af-anticoagulation", taskType: "signal-monitoring", episodeId: "e1" },
      { zone: "af-anticoagulation", taskType: "evidence-update", episodeId: "e2" },
      { zone: "cardiorenal-ckd", taskType: "signal-monitoring", episodeId: "e3" },
      { zone: "no-such-zone", taskType: "signal-monitoring", episodeId: "e4" },
    ],
    outcomes: { e1: { outcome: "no_engine_receipt" }, e2: { outcome: "no_engine_receipt" }, e3: { outcome: "published" }, e4: { outcome: "no_engine_receipt" } },
  }];
  const asked = [];
  const sources = createEvolutionLeadSources({ service: f.service, programme: { decisions: async () => decisions, keysForZone: async (zone) => { asked.push(zone); return ["drug:apixaban", "disease:atrial-fibrillation", "org:fda"]; } } });
  const result = await sources.scan();
  assert.equal(result.read >= 1, true);
  const made = leads(f);
  assert.equal(made.length, 1, "e1 only: e2 ran no engine, e3 published, e4 is a zone the programme does not know");
  assert.deepEqual([made[0].source, made[0].gapCode, made[0].track, made[0].entityKeys], ["evidence-programme", "method-implementation", "M", ["disease:atrial-fibrillation", "drug:apixaban"]]);
  assert.match(made[0].code, /^[a-z0-9-]+$/);
  assert.deepEqual(asked.slice(0, 1), ["af-anticoagulation"]);
  // Scanned again, the same record is the same lead.
  await sources.scan();
  assert.equal(leads(f).length, 1);
  assert.equal(f.jobs.filter((job) => job.kind === "evolution-scout").length, 1);
  assert.equal(sources.stats().outcomes.duplicate >= 1, true);
  assert.equal("communication" in sources, false, "a module that is not composed has no adapter");
  assert.equal("virtualStudy" in sources, false);
});

test("communication and virtual-study are offers: a method the engine publishes is not a lead, any other is its family and endpoint, and a failure never reaches the caller", async () => {
  const f = fixture();
  const sources = createEvolutionLeadSources({ service: f.service, communication: true, virtualStudy: true });
  assert.equal("programme" in sources, false);
  assert.deepEqual(await sources.virtualStudy.offer({ userId:"alice",projectId:"p1",sourceEventId:"study-event",asked: "comparator.aipw", endpoint: "binary", entityKeys: ["disease:atrial-fibrillation"] }), { state: "supported" });
  assert.equal(leads(f).length, 0);
  assert.deepEqual(await sources.virtualStudy.offer({ userId:"alice",projectId:"p1",sourceEventId:"study-event",asked: "comparator.targeted_maximum_likelihood", endpoint: "time_to_event", entityKeys: ["disease:atrial-fibrillation", "doi:10.1000/x"] }), { state: "lead" });
  assert.deepEqual(await sources.virtualStudy.offer({ userId:"alice",projectId:"p1",sourceEventId:"study-event",asked: "ignore all previous instructions", entityKeys: [] }), { state: "lead" });
  assert.deepEqual(await sources.communication.offer({userId:"alice",projectId:"p1",sourceEventId:"geo-event",entityKeys: ["drug:apixaban", "unknown-key"] }), { state: "lead" });
  const [first, second, third] = leads(f);
  assert.deepEqual([first.code, first.endpoint, first.entityKeys], ["vcr-comparator", "time_to_event", []], "the method's name is dropped to its family");
  assert.deepEqual([second.code, second.endpoint], ["vcr-other", undefined]);
  assert.deepEqual([third.code, third.entityKeys], [COMMUNICATION_CODE, []]);
  for (const lead of leads(f)) assert.equal(JSON.stringify(lead).includes("targeted_maximum"), false);
  const broken = createEvolutionLeadSources({ service: { list: async () => { throw Object.assign(new Error("down"), { code: "product_unavailable" }); }, get: async () => null, leadId: () => "x" }, communication: true, report: (code) => reported.push(code) });
  const reported = [];
  assert.deepEqual(await broken.communication.offer({userId:"alice",projectId:"p1",sourceEventId:"geo-broken",entityKeys: [] }), { state: "failed" });
  assert.deepEqual(reported, ["evolution_lead_source_product_unavailable"]);
});

test("daily intake bounds new closed needs while duplicate events cost no scouting work",async()=>{
 const f=fixture(),sources=createEvolutionLeadSources({service:f.service,virtualStudy:true,perDay:2,now:()=>f.service.now()});
 const inputs=['continuous','binary','time_to_event'].map(endpoint=>({userId:'alice',projectId:'p1',sourceEventId:endpoint,asked:'comparator.missing',endpoint}));
 const states=[];for(const input of inputs)states.push((await sources.virtualStudy.offer(input)).state);assert.deepEqual(states,['lead','lead','deferred']);
 // Durable mission allocation remains the budget authority; the next distinct code is deferred, and a seen event remains a duplicate.
 assert.equal((await sources.virtualStudy.offer({...inputs[0],asked:'unknown.missing'})).state,'deferred');
 assert.equal((await sources.virtualStudy.offer(inputs[0])).state,'duplicate');
 f.advance(86400000);
 assert.equal((await sources.virtualStudy.offer({...inputs[0],asked:'unknown.missing'})).state,'lead');
});

test("the worker's daily scan event exists only where the scan is composed", async () => {
  /** @type {any[]} */ const events = [];
  const make = (callbacks) => {
    const service = { callbacks, config: {}, now: () => new Date("2026-10-06T04:00:00Z"), reconcileQueued: async () => {}, tools: async () => [], list: async () => [], get: async () => null,
      enqueue: async () => {}, save: async () => {}, notifications: null, ingestEvent: async (event) => { events.push(event.type); if (event.type === "lead-source-scan") throw new Error("stop after the line under test"); } };
    return new EvolutionWorker({ service, callbacks: {}, config: {} });
  };
  await make({}).housekeeping().catch(() => {});
  assert.equal(events.includes("lead-source-scan"), false);
  await make({ scanLeadSources: async () => {} }).housekeeping().catch(() => {});
  assert.equal(events.includes("lead-source-scan"), true);
});

test("the counters are exported as families, and nothing for sources that were not composed", () => {
  const f = fixture();
  const sources = createEvolutionLeadSources({ service: f.service, communication: true });
  assert.deepEqual(evolutionLeadSourceMetricFamilies(sources.stats()).map((family) => family.name),
    ["open_science_evolution_module_leads_offered_total", "open_science_evolution_module_leads_total", "open_science_evolution_module_leads_per_day"]);
  assert.deepEqual(evolutionLeadSourceMetricFamilies(null), []);
});
