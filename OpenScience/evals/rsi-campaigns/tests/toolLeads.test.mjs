import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_SCORERS, scorerBenchmarks } from '../harness_scorers.mjs';
import {
  BENCHMARK_POOLS, CARDS_SCHEMA, LEAD_MINIMUMS, LEADS_SCHEMA, LITERATURE_SCHEMA, REFUSALS, SIGNALS_SCHEMA, cardIssues, checkLeads, coverageOf, developmentOf, fixtureReader,
  leadPriority, leadPriorityBreakdown, literatureUrl, loadInventory, nameKey, networkReader, queryProblem, readPools, readableText, sourceUrl, demandOf,
} from '../tool_leads.mjs';

// The intake of tool leads: cards an operator's Claude session wrote go in, a ranked and digested leads file and a refused list with closed
// codes come out, from recorded Europe PMC responses alone. The cards below are synthetic; nothing here is a claim about the literature.
const tool = fileURLToPath(new URL('../tool_leads.mjs', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'rsi-tool-leads-'));
after(() => rm(scratch, { recursive: true, force: true }));
const OBSERVED = '2026-11-04';
const inventory = await loadInventory();

const PLAN = { benchmark: 'medcalc-bench', scorer: 'medcalc' };
const ABSTRACT_A1 = '<h4>Background</h4>Random-effects meta-analysis with few studies gives intervals that are too narrow.<h4>Results</h4>The Hartung-Knapp-Sidik-Jonkman correction restored nominal coverage in 10<sup>4</sup> simulated meta-analyses of 5 studies.';
const ABSTRACT_A2 = 'We compared variance estimators for the pooled effect &amp; found that the t-based interval with a modified variance had the best coverage when between-study heterogeneity was large.';
const ABSTRACT_B1 = 'Firth penalised likelihood removes the first-order bias of maximum likelihood estimates and gives finite estimates under separation in logistic regression.';
const ABSTRACT_B2 = 'In rare-event data with complete separation the penalised estimator converged where ordinary logistic regression did not.';
const PAPERS = {
  100001: { title: 'Small-sample intervals for random-effects meta-analysis', abstract: ABSTRACT_A1 },
  100002: { title: 'Variance estimators for pooled effects', abstract: ABSTRACT_A2 },
  100003: { title: 'A second look at heterogeneity', abstract: 'Heterogeneity is estimated with large uncertainty when the number of studies is small and the true variance is moderate.' },
  200001: { title: 'Penalised likelihood for separation', abstract: ABSTRACT_B1 },
  200002: { title: 'Rare events and separation', abstract: ABSTRACT_B2 },
};
const sourceBody = (pmid) => JSON.stringify({ version: '6.9', hitCount: 1, request: {}, resultList: { result: [{ id: pmid, source: 'MED', pmid, doi: `10.1000/x.${pmid}`, title: PAPERS[pmid].title, abstractText: PAPERS[pmid].abstract, firstPublicationDate: '2025-03-01' }] } });
const hitsBody = (hitCount, pmids = []) => JSON.stringify({ version: '6.9', hitCount, request: {}, resultList: { result: pmids.map((pmid) => ({ id: pmid, source: 'MED', pmid, doi: `10.1000/x.${pmid}`, title: PAPERS[pmid].title, firstPublicationDate: '2025-03-01' })) } });

const card = (id, over = {}) => ({
  method: { id, name: `${id} method`, aliases: [] }, track: 'M', toolKind: 'calculation', surface: 'tool-patch', summary: `A method named ${id}, for a test.`,
  sources: [{ pmid: '100001', quote: 'The Hartung-Knapp-Sidik-Jonkman correction restored nominal coverage' }, { pmid: '100002', quote: 'the t-based interval with a modified variance had the best coverage' }],
  literatureQuery: `TITLE_ABS:"${id}" AND "meta-analysis"`, developmentPlan: PLAN, ...over,
});
const CARD_A = card('hksj-correction', { method: { id: 'hksj-correction', name: 'Hartung-Knapp-Sidik-Jonkman variance correction for random-effects meta-analysis', aliases: ['HKSJ'] },
  sources: [{ pmid: '100001', quote: 'The Hartung-Knapp-Sidik-Jonkman correction restored nominal coverage' }, { pmid: '100002', quote: 'found that the t-based interval with a modified variance had the best coverage' }, { pmid: '100003', quote: 'Heterogeneity is estimated with large uncertainty when the number of studies is small' }],
  demand: { operations: ['meta-analysis'], dataShapes: ['table'] } });
const CARD_B = card('firth-logistic', { method: { id: 'firth-logistic', name: 'Firth penalised logistic regression', aliases: [] },
  sources: [{ pmid: '200001', quote: 'gives finite estimates under separation in logistic regression' }, { pmid: '200002', quote: 'the penalised estimator converged where ordinary logistic regression did not' }] });
const CARD_QUOTE = card('invented-quote', { sources: [{ pmid: '100001', quote: 'This sentence is not in the abstract of that paper at all.' }, { pmid: '100002', quote: 'the t-based interval with a modified variance had the best coverage' }] });
const CARD_SHIPPED = card('meta.dl', { method: { id: 'meta.dl', name: 'DerSimonian-Laird', aliases: [] } });
const CARD_NO_PLAN = card('no-development-plan', { developmentPlan: undefined });
// The same method as CARD_B and so the same measured numbers, but this card states its own: they are ignored and recorded.
const CARD_INFLATED = card('firth-inflated', { method: { id: 'firth-inflated', name: 'Firth penalised logistic regression with a stated count', aliases: ['firth-logistic'] },
  sources: CARD_B.sources, literatureQuery: CARD_B.literatureQuery, literature24Months: 99_999, rankingFeatures: { distinctAccounts: 500, publishedExamples: 40 },
  developmentPlan: { ...PLAN, rows: 99_999 }, score: 1000, remarks: 'free text the schema does not read' });

const SIGNALS = { schema: SIGNALS_SCHEMA, from: '2026-09-01', to: '2026-10-31', releaseId: 'release-test.1', floor: 5, signals: [
  { module: 'tools', kind: 'unmet-demand', capability: 'meta-analysis', operation: 'meta-analysis', dataShape: 'table', reason: 'unsupported', accounts: 12, occurrences: 30 },
  { module: 'geo', kind: 'unmet-demand', capability: 'unknown', operation: 'meta-analysis', dataShape: 'table', reason: 'missing-tool', accounts: 6, occurrences: 8 },
  { module: 'memory', kind: 'unmet-demand', capability: 'unknown', operation: 'meta-analysis', dataShape: 'table', reason: 'missing-tool', accounts: '<5', occurrences: null },
  { module: 'autopilot', kind: 'route-override', capability: 'unknown', operation: 'meta-analysis', dataShape: 'table', reason: 'unsupported', accounts: 40, occurrences: 90 },
  { module: 'tools', kind: 'unmet-demand', capability: 'unknown', operation: 'survival-analysis', dataShape: 'time-to-event', reason: 'unsupported', accounts: 30, occurrences: 31 },
] };

/** What the index would answer for the cards above, keyed by the request this tool makes. */
function responses(extra = {}) {
  const map = {};
  for (const pmid of Object.keys(PAPERS)) map[sourceUrl({ pmid })] = sourceBody(pmid);
  map[literatureUrl(CARD_A.literatureQuery, OBSERVED).url] = hitsBody(480, ['100001', '100002']);
  map[literatureUrl(CARD_B.literatureQuery, OBSERVED).url] = hitsBody(7, ['200001']);
  map[literatureUrl(CARD_QUOTE.literatureQuery, OBSERVED).url] = hitsBody(50);
  return { ...map, ...extra };
}
const cardsFile = (cards, observedAt = OBSERVED) => ({ schema: CARDS_SCHEMA, observedAt, cards });
const reader = (map) => { const asked = []; const inner = fixtureReader({ schema: LITERATURE_SCHEMA, responses: map }); return { asked, get: (url) => { asked.push(url); return inner.get(url); } }; };
const run = (cards, options = {}) => { const literature = options.literature ?? reader(responses()); return checkLeads({ cards: cardsFile(cards), literature, inventory, ...options }).then((doc) => ({ doc, literature })); };
const reasonsOf = (doc, id) => doc.refused.find((entry) => entry.id === id)?.reasons.map((reason) => reason.code);

test('the round trip: a card that passes is ranked on measured numbers, the others are refused with a closed code', async () => {
  const { doc, literature } = await run([CARD_QUOTE, CARD_SHIPPED, CARD_B, CARD_NO_PLAN, CARD_A, CARD_INFLATED], { signals: SIGNALS });
  assert.equal(doc.schema, LEADS_SCHEMA);
  assert.deepEqual(doc.leads.map((lead) => [lead.rank, lead.id]), [[1, 'hksj-correction'], [2, 'firth-inflated'], [3, 'firth-logistic']]);
  assert.deepEqual(Object.fromEntries(doc.refused.map((entry) => [entry.id, entry.reasons.map((reason) => reason.code)])), {
    'invented-quote': ['tool_lead_quote_not_found'], 'meta.dl': ['tool_lead_already_shipped'], 'no-development-plan': ['tool_lead_no_measurable_development'],
  });
  for (const entry of doc.refused) for (const reason of entry.reasons) assert.ok(REFUSALS.includes(reason.code), reason.code);
  assert.equal(doc.refused.find((entry) => entry.id === 'invented-quote').reasons[0].source, 0, 'the refusal names the source whose quote is not there');
  assert.equal(doc.refused.find((entry) => entry.id === 'no-development-plan').reasons[0].problem, 'no_plan');
  assert.ok(doc.refused.find((entry) => entry.id === 'meta.dl').reasons[0].matched.some((hit) => hit.kind === 'method-record' && hit.name === 'meta.dl'), 'a duplicate shows the names it matched');
  // A card refused on the card and the tree alone costs no request.
  const shippedOnly = await run([CARD_SHIPPED, CARD_NO_PLAN]);
  assert.deepEqual(shippedOnly.literature.asked, []);
  assert.ok(literature.asked.length > 0);

  const [a, firth, b] = doc.leads;
  assert.equal(a.literature.count, 480);
  assert.deepEqual(a.sources.map((source) => source.pmid), ['100001', '100002', '100003']);
  assert.ok(a.sources.every((source) => /^[0-9a-f]{64}$/.test(source.responseSha256)));
  assert.equal(a.literature.responseSha256, createHash('sha256').update(responses()[a.literature.url]).digest('hex'));
  assert.deepEqual(a.features, { literature24Months: 480, verifiedSources: 3, coverageGap: true, developmentReachable: true });
  assert.deepEqual([a.demand.basis, a.demand.accounts, a.demand.modules, a.demand.withheld], ['signals', 12, ['geo', 'tools'], 1], 'the 40-account group is another kind, the withheld one counts for nothing');
  assert.equal(a.score, leadPriority(a.features));
  assert.deepEqual(Object.keys(a.breakdown), ['literature', 'sources', 'coverage', 'data'], 'the breakdown is written beside the score');
  assert.equal(b.demand.basis, 'no-selector');
  assert.match(a.demand.claim, /not tied to the method/, 'demand is printed as the operator\'s claim');
  // Demand is beside the score and not in it: the same card without a selector, against the same signals, scores the same.
  const bare = (await run([{ ...CARD_A, demand: undefined }], { signals: SIGNALS })).doc.leads[0];
  assert.equal(bare.score, a.score);
  // The inflated card is B with a stated count: same measured features, same breakdown, and what it stated is recorded beside what was measured.
  assert.deepEqual([firth.features, firth.breakdown, firth.score], [b.features, b.breakdown, b.score]);
  assert.deepEqual(firth.ignored.claims, [
    { field: 'developmentPlan.rows', claimed: 99_999, measured: null }, { field: 'literature24Months', claimed: 99_999, measured: 7 },
    { field: 'rankingFeatures.distinctAccounts', claimed: 500, measured: 0 }, { field: 'rankingFeatures.publishedExamples', claimed: 40, measured: 2 }, { field: 'score', claimed: 1000, measured: b.score },
  ]);
  assert.deepEqual(firth.ignored.fields, ['rankingFeatures', 'remarks']);
  assert.equal(b.features.literature24Months, 7);
  assert.deepEqual(b.ignored, { claims: [], fields: [] });
  for (const lead of doc.leads) assert.match(lead.digest, /^[0-9a-f]{64}$/);
  assert.match(doc.digest, /^[0-9a-f]{64}$/);
  assert.equal(doc.inputs.signals.releaseId, 'release-test.1');
  assert.ok(doc.inputs.literature.length === 8 && doc.inputs.literature.every((entry) => /^https:\/\/www\.ebi\.ac\.uk\/europepmc\//.test(entry.url)));
});

test('the same inputs give the same bytes, through the command line too, and a fixture means no network at all', async () => {
  const cards = [CARD_A, CARD_B, CARD_QUOTE, CARD_SHIPPED, CARD_NO_PLAN, CARD_INFLATED];
  const first = (await run(cards, { signals: SIGNALS })).doc, second = (await run([...cards], { signals: structuredClone(SIGNALS) })).doc;
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  const dir = await mkdtemp(join(scratch, 'cli-'));
  const files = { cards: join(dir, 'cards.json'), signals: join(dir, 'signals.json'), fixture: join(dir, 'fixture.json'), a: join(dir, 'a.json'), b: join(dir, 'b.json') };
  await writeFile(files.cards, JSON.stringify(cardsFile(cards))); await writeFile(files.signals, JSON.stringify(SIGNALS));
  await writeFile(files.fixture, JSON.stringify({ schema: LITERATURE_SCHEMA, responses: responses() }));
  // Any fetch in these processes throws: a run with a fixture never reaches for the index.
  const noNetwork = join(dir, 'no-network.mjs');
  await writeFile(noNetwork, "globalThis.fetch = () => { throw new Error('the network was used'); };\n");
  const invoke = (out) => spawnSync(process.execPath, ['--import', noNetwork, tool, 'check', '--cards', files.cards, '--signals', files.signals, '--literature-fixture', files.fixture, '--out', out], { encoding: 'utf8' });
  const one = invoke(files.a), two = invoke(files.b);
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual([JSON.parse(one.stdout).status, JSON.parse(one.stdout).leads, JSON.parse(one.stdout).refused], ['ok', 3, 3]);
  assert.equal(await readFile(files.a, 'utf8'), await readFile(files.b, 'utf8'));
  assert.equal(JSON.parse(await readFile(files.a, 'utf8')).digest, JSON.parse(one.stdout).digest);
  assert.equal(two.stdout, one.stdout);
  // The file the command line wrote is what the library computes for the same inputs.
  const written = JSON.parse(await readFile(files.a, 'utf8'));
  assert.deepEqual(written.leads.map((lead) => lead.id), first.leads.map((lead) => lead.id));
  assert.deepEqual(written.refused, first.refused);

  const missing = spawnSync(process.execPath, ['--import', noNetwork, tool, 'check', '--cards', files.cards, '--literature-fixture', join(dir, 'empty.json'), '--out', files.b], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  await writeFile(join(dir, 'empty.json'), JSON.stringify({ schema: LITERATURE_SCHEMA, responses: {} }));
  const none = spawnSync(process.execPath, ['--import', noNetwork, tool, 'check', '--cards', files.cards, '--literature-fixture', join(dir, 'empty.json'), '--out', files.b], { encoding: 'utf8' });
  assert.equal(none.status, 0, none.stderr);
  const unavailable = JSON.parse(await readFile(files.b, 'utf8'));
  assert.deepEqual(unavailable.leads, [], 'a response the fixture does not hold is not fetched: the card is refused');
  assert.ok(unavailable.refused.filter((entry) => entry.reasons.some((reason) => reason.code === 'tool_lead_literature_unavailable' && reason.problem === 'fixture_missing')).length >= 3);
  for (const args of [[], ['check'], ['check', '--cards', files.cards], ['check', '--cards', files.cards, '--out', files.b, '--literature-fixture', files.fixture, '--literature-record', join(dir, 'r.json')]]) {
    assert.equal(spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' }).status, 2, JSON.stringify(args));
  }
});

test('a run on the index is recorded as it was told, and the recording replays to the same bytes', async () => {
  const served = responses(), seen = [];
  const fetchImpl = async (url, init) => { seen.push([String(url), init]); return { ok: true, text: async () => served[String(url)] ?? JSON.stringify({ hitCount: 0, resultList: { result: [] } }) }; };
  const live = networkReader({ fetchImpl, pauseMs: 0 });
  const recorded = { map: new Map(), get(url) { return live.get(url).then((reply) => { if (reply.ok) this.map.set(url, reply.body); return reply; }); } };
  const first = await checkLeads({ cards: cardsFile([CARD_A, CARD_B]), literature: recorded, inventory, signals: SIGNALS });
  assert.ok(seen.every(([url, init]) => url.startsWith('https://www.ebi.ac.uk/europepmc/webservices/rest/search?') && init.redirect === 'error'), 'a fixed primary index, redirects refused');
  const replayed = await checkLeads({ cards: cardsFile([CARD_A, CARD_B]), literature: fixtureReader({ schema: LITERATURE_SCHEMA, responses: Object.fromEntries(recorded.map) }), inventory, signals: SIGNALS });
  assert.equal(JSON.stringify(replayed), JSON.stringify(first));
  // An unavailable index, an oversized answer and an unreadable one refuse the card with a code each; none is a lead.
  for (const [reply, problem] of [[{ ok: false, text: async () => '' }, 'index_unavailable'], [{ ok: true, text: async () => 'x'.repeat(600_000) }, 'response_too_large']]) {
    const down = await checkLeads({ cards: cardsFile([CARD_B]), literature: networkReader({ fetchImpl: async () => reply, pauseMs: 0 }), inventory });
    assert.deepEqual(down.leads, []);
    assert.ok(down.refused[0].reasons.some((reason) => reason.code === 'tool_lead_literature_unavailable' && reason.problem === problem), problem);
    assert.ok(down.refused[0].reasons.some((reason) => reason.code === 'tool_lead_source_unavailable'));
  }
  const thrown = await checkLeads({ cards: cardsFile([CARD_B]), literature: networkReader({ fetchImpl: async () => { throw new Error('boom'); }, pauseMs: 0 }), inventory });
  assert.equal(thrown.refused[0].reasons[0].problem, 'index_unavailable');
});

test('a quote has to be in the title or abstract the index holds, as that text reads once its markup is gone', async () => {
  assert.equal(readableText('<h4>Background</h4>Few studies.<h4>Results</h4>H<sub>2</sub>O &amp; 10<sup>4</sup> &#946;-blockers &lt;5%'), 'Background Few studies. Results H2O & 104 β-blockers <5%');
  const inTitle = card('in-title', { sources: [{ pmid: '100002', quote: 'Variance estimators for pooled effects' }, { pmid: '100001', quote: 'intervals that are too narrow. Results The Hartung-Knapp-Sidik-Jonkman correction restored' }] });
  const asTitle = (await run([inTitle], { literature: reader(responses({ [literatureUrl(inTitle.literatureQuery, OBSERVED).url]: hitsBody(9) })) })).doc;
  assert.deepEqual(asTitle.leads.map((lead) => lead.id), ['in-title'], 'a title is enough, and a quote may cross the markup that separates two headings of the abstract');
  // Elided or too short or two sources of one paper: the shape is wrong, the paper is counted once.
  assert.deepEqual(cardIssues(card('elided', { sources: [{ pmid: '100001', quote: 'The correction restored … nominal coverage in simulation' }] })).map((issue) => issue.problem), ['one_contiguous_passage']);
  assert.deepEqual(cardIssues(card('short', { sources: [{ pmid: '100001', quote: 'too short' }] })).map((issue) => issue.field), ['sources[0].quote']);
  const twice = card('one-paper', { sources: [{ pmid: '100001', quote: 'The Hartung-Knapp-Sidik-Jonkman correction restored nominal coverage' }, { doi: '10.1000/x.100001', quote: 'Random-effects meta-analysis with few studies gives intervals that are too narrow' }] });
  const reply = { ...responses(), [sourceUrl({ doi: '10.1000/x.100001' })]: sourceBody('100001'), [literatureUrl(twice.literatureQuery, OBSERVED).url]: hitsBody(9) };
  const once = (await run([twice], { literature: reader(reply) })).doc;
  assert.deepEqual(reasonsOf(once, 'one-paper'), ['tool_lead_too_few_sources']);
  assert.deepEqual(once.refused[0].reasons[0], { code: 'tool_lead_too_few_sources', distinct: 1, minimum: LEAD_MINIMUMS.sources });
});

test('the 24-month count is the index\'s own, and a method with no papers is refused', async () => {
  const quiet = card('quiet-method', { sources: CARD_B.sources });
  const twoHits = card('two-papers', { sources: CARD_B.sources });
  const replies = responses({ [literatureUrl(quiet.literatureQuery, OBSERVED).url]: hitsBody(1), [literatureUrl(twoHits.literatureQuery, OBSERVED).url]: hitsBody(2) });
  const { doc } = await run([quiet, twoHits], { literature: reader(replies) });
  assert.deepEqual(reasonsOf(doc, 'quiet-method'), ['tool_lead_no_literature_demand']);
  assert.deepEqual(doc.leads.map((lead) => lead.id), ['two-papers']);
  const request = literatureUrl('firth', '2026-02-28');
  assert.equal(request.window.from, '2024-02-28');
  assert.equal(request.query, '(firth) AND FIRST_PDATE:[2024-02-28 TO 2026-02-28] AND SRC:MED');
  assert.equal(literatureUrl('x', '2028-02-29').window.from, '2026-03-01', 'the window is calendar months, as the online engine measured it');
});

test('the query is the method\'s: fenced, tied to its name or an alias in every clause, in a syntax that cannot close the window', () => {
  const method = { id: 'hksj', name: 'Hartung-Knapp-Sidik-Jonkman variance correction', aliases: ['Hartung-Knapp adjustment'] };
  const ok = ['TITLE_ABS:"Hartung-Knapp adjustment"', 'TITLE_ABS:"hartung knapp sidik jonkman variance correction" AND "meta-analysis"', 'TITLE_ABS:"HKSJ" OR TITLE_ABS:"Hartung-Knapp adjustment" AND "random effects"', 'TITLE_ABS:"hksj"'];
  for (const query of ok) assert.equal(queryProblem(query, method), null, query);
  const notTied = ['"Hartung-Knapp adjustment"', 'TITLE_ABS:"cancer"', 'TITLE_ABS:"hksj" OR "cancer"', 'TITLE_ABS:"hksj" OR TITLE_ABS:"cancer" AND "hksj"', 'TITLE_ABS:"hksj" AND TITLE_ABS:"x y"'.replace('hksj" AND TITLE_ABS:"x y', 'cancer" OR TITLE_ABS:"hksj')];
  for (const query of notTied) assert.equal(queryProblem(query, method), 'query_clause_not_tied_to_the_method', query);
  const outside = ['TITLE_ABS:"rare") OR ("rare"', '(TITLE_ABS:"hksj")', 'TITLE_ABS:"hksj" NOT "x"', 'TITLE_ABS:"hksj" AND', 'TITLE_ABS:"hksj" OR', 'TITLE_ABS:hksj', 'TITLE_ABS:"hksj"" OR "a', 'TITLE_ABS:"hksj" AND AUTH:"smith"', 'cancer', 'TITLE_ABS:"hksj\\"', 'TITLE_ABS:"hksj" OR  OR "a"'];
  for (const query of outside) assert.equal(queryProblem(query, method), 'query_outside_closed_syntax', query);
  assert.deepEqual(cardIssues(card('hksj', { method, literatureQuery: 'cancer' })).filter((issue) => issue.field === 'literatureQuery'), [{ field: 'literatureQuery', problem: 'query_outside_closed_syntax' }]);
});

test('a card with a query that is not its method\'s is refused as invalid before any request', async () => {
  for (const literatureQuery of ['cancer', 'TITLE_ABS:"cancer"', 'TITLE_ABS:"rare") OR ("rare"']) {
    const { doc, literature } = await run([card('hksj-correction', { literatureQuery })]);
    assert.deepEqual(reasonsOf(doc, 'hksj-correction'), ['tool_lead_card_invalid'], literatureQuery);
    assert.deepEqual(literature.asked, []);
  }
});

test('the score is the online engine\'s formula and weights, for the terms that can be measured', () => {
  const none = { literature24Months: 0, verifiedSources: 0, coverageGap: false, developmentReachable: false };
  assert.deepEqual(leadPriorityBreakdown(none), { literature: 0, sources: 0, coverage: 0, data: 0 });
  const features = { literature24Months: 9, verifiedSources: 9, coverageGap: true, developmentReachable: true, distinctAccounts: 500, demandModules: 5 };
  assert.deepEqual(leadPriorityBreakdown(features), { literature: 6.907755, sources: 5, coverage: 3, data: 2 }, 'sources are capped, and a demand count is not a term');
  assert.equal(leadPriority(features), 16.907755);
  assert.equal(leadPriorityBreakdown({ ...none, literature24Months: 1e9 }).literature, 27.631321, 'a count is held at 10,000');
  assert.equal(leadPriority({ ...none, coverageGap: 'yes', developmentReachable: 1 }), 0, 'only a measured true counts');
});

test('what ships is read from the tree, and a method already there is found by name, with its look-alikes shown and not refused', () => {
  const kinds = new Set(inventory.parts.filter((part) => part.count > 0).map((part) => part.kind));
  assert.deepEqual([...kinds].sort(), ['capability', 'method-record', 'runtime-tool', 'tool-graph', 'vcr-method']);
  assert.match(inventory.sha256, /^[0-9a-f]{64}$/);
  assert.equal(nameKey('Hartung–Knapp: adjustment'), 'hartung knapp adjustment');
  const named = (id, name, aliases = []) => ({ method: { id, name, aliases } });
  const exact = coverageOf(named('comparator.rmst', 'x'), inventory);
  assert.ok(exact.covered && exact.exact.some((hit) => hit.name === 'comparator.rmst'));
  assert.ok(coverageOf(named('rmst', 'Restricted mean survival time'), inventory).covered, 'the tail of a dotted id is a name');
  assert.ok(coverageOf(named('dl-meta', 'DerSimonian-Laird random-effects meta-analysis'), inventory).inside.some((hit) => hit.name === 'meta.dl' || hit.kind === 'method-record'), 'what the card says is already said by a shipped title');
  const variant = coverageOf(named('hk', 'Hartung-Knapp adjustment for random-effects meta-analysis'), inventory);
  assert.equal(variant.covered, false);
  assert.ok(variant.related.some((hit) => hit.kind === 'capability'), 'a variant of a shipped capability shows it');
  assert.ok(variant.related.length <= 12);
  assert.equal(coverageOf(named('quantum-flux', 'Quantum flux capacitor'), inventory).covered, false);
  assert.ok(coverageOf(named('x-1', 'unrelated', ['Meta-Analysis']), inventory).covered, 'an alias is a name too');
});

test('demand is read from the export\'s groups alone: unmet demand of the named codes, counted by the largest group and never added', () => {
  const selector = (demand) => ({ demand });
  const found = demandOf(selector({ operations: ['meta-analysis'] }), SIGNALS);
  assert.deepEqual([found.accounts, found.modules, found.withheld, found.matched.length], [12, ['geo', 'tools'], 1, 2]);
  assert.deepEqual(demandOf(selector({ operations: ['survival-analysis'], dataShapes: ['time-to-event'] }), SIGNALS).accounts, 30);
  assert.deepEqual(demandOf(selector({ operations: ['meta-analysis'], dataShapes: ['image'] }), SIGNALS).accounts, 0);
  assert.equal(demandOf({}, SIGNALS).basis, 'no-selector');
  assert.equal(demandOf(selector({ operations: ['meta-analysis'] }), null).basis, 'no-signals-file');
  assert.deepEqual(cardIssues(card('bad-demand', { demand: { operations: [] } })).map((issue) => issue.field), ['demand']);
  assert.deepEqual(cardIssues(card('bad-demand', { demand: { operations: ['Meta analysis'] } })).map((issue) => issue.field), ['demand.operations']);
});

test('development data has to be measurable: a benchmark family of the lab\'s scorer table, and with pools its rows too', async () => {
  // The registry here and the scorer table there are one list.
  const benchmarks = [...new Set(Object.values(HARNESS_SCORERS).flatMap((scorer) => scorerBenchmarks(scorer)))].sort();
  assert.deepEqual(Object.keys(BENCHMARK_POOLS).sort(), benchmarks);
  const statistics = await readFile(new URL('../statistics.py', import.meta.url), 'utf8');
  assert.equal(Number(/'minimum_slice_groups':\s*(\d+)/.exec(statistics)[1]), LEAD_MINIMUMS.confirmationRows);
  const plan = (benchmark, scorer) => ({ developmentPlan: { benchmark, scorer } });
  assert.equal(developmentOf({}, null).problem, 'no_plan');
  assert.equal(developmentOf(plan('a-public-dataset', 'medcalc'), null).problem, 'unknown_benchmark', 'a public dataset is a plan only once it is a benchmark family');
  assert.equal(developmentOf(plan('bixbench', 'medcalc'), null).problem, 'scorer_mismatch');
  assert.equal(developmentOf(plan('medcalc-bench', 'no-such-scorer'), null).problem, 'scorer_mismatch');
  assert.deepEqual(developmentOf(plan('bixbench', 'judged-verdicts'), null), { reachable: true, benchmark: 'bixbench', scorer: 'judged-verdicts', rows: { measured: null, basis: 'registry' } });

  const dir = await mkdtemp(join(scratch, 'pools-'));
  const pool = (name, development, confirmation) => JSON.stringify({ schema: 'bench-pools/1', pools: { [name]: { development: Array.from({ length: development }, (_, i) => String(i)), confirmation: Array.from({ length: confirmation }, (_, i) => String(1000 + i)) } } });
  await writeFile(join(dir, 'medcalc.json'), pool('main', 40, 30)); await writeFile(join(dir, 'drb.json'), pool('main', 30, 24)); await writeFile(join(dir, 'arb.json'), pool('deep', 288, 282));
  const pools = await readPools(dir);
  assert.deepEqual(pools.rows, { 'medcalc-bench': { development: 40, confirmation: 30 }, deepresearchbench: { development: 30, confirmation: 24 }, 'autoresearchbench-deep': { development: 288, confirmation: 282 } });
  assert.deepEqual(Object.keys(pools.files).sort(), ['arb.json', 'drb.json', 'medcalc.json']);
  assert.equal(developmentOf(plan('medcalc-bench', 'medcalc'), pools.rows).reachable, true);
  assert.deepEqual([developmentOf(plan('deepresearchbench', 'judged-verdicts'), pools.rows).problem, developmentOf(plan('bixbench', 'bixbench-deterministic'), pools.rows).problem], ['rows_below_minimum', 'pool_missing']);
  assert.equal(developmentOf(plan('autoresearchbench-wide', 'arb-wide'), pools.rows).problem, 'pool_missing', 'the deep pool is not the wide one');
  const { doc } = await run([CARD_B, card('short-pool', { developmentPlan: { benchmark: 'deepresearchbench', scorer: 'judged-verdicts' } })], { pools });
  assert.deepEqual(doc.leads.map((lead) => lead.development.rows), [{ claimed: null, measured: { development: 40, confirmation: 30 }, basis: 'pools' }]);
  assert.deepEqual(reasonsOf(doc, 'short-pool'), ['tool_lead_no_measurable_development']);
  assert.deepEqual(Object.keys(doc.inputs.pools).sort(), ['arb.json', 'drb.json', 'medcalc.json']);
});

test('a card is refused for its shape, a repeated method, new data, or a track that needs data nobody has; the file itself is checked first', async () => {
  const broken = { method: { id: 'Bad Id', name: 'x' }, track: 'Q', toolKind: 'magic', surface: 'x', summary: '', sources: [{ pmid: 'abc', doi: '10.1/x', quote: 1 }], literatureQuery: '' };
  const fields = cardIssues(broken).map((issue) => issue.field);
  for (const field of ['method.id', 'method.name', 'track', 'toolKind', 'surface', 'summary', 'literatureQuery', 'sources[0]', 'sources[0].quote']) assert.ok(fields.includes(field), field);
  assert.deepEqual(cardIssues(null), [{ field: '', problem: 'not_an_object' }]);
  // Text the canonical JSON could not hold is refused with the card, and a count too large for it is only listed: neither stops the others.
  assert.deepEqual(cardIssues(card('lone-surrogate', { summary: 'a broken \ud800 character' })).map((issue) => issue.field), ['summary']);
  const huge = (await run([card('huge-count', { method: { id: 'huge-count', name: 'huge count method', aliases: ['firth-logistic'] }, sources: CARD_B.sources, literatureQuery: CARD_B.literatureQuery, literature24Months: 1e300, '\ud800': 1 })])).doc;
  assert.deepEqual([huge.leads[0].ignored.claims, huge.leads[0].ignored.fields], [[], ['(unreadable name)', 'literature24Months']]);
  const { doc } = await run([card('twice'), card('twice'), card('new-data', { track: 'X' }), 7, broken, card('scorer', { developmentPlan: { benchmark: 'bixbench', scorer: 'medcalc' } })]);
  assert.deepEqual(doc.refused.map((entry) => [entry.index, entry.id, entry.reasons[0].code]), [
    [0, 'twice', 'tool_lead_literature_unavailable'], [1, 'twice', 'tool_lead_duplicate_method'], [2, 'new-data', 'tool_lead_new_data_required'], [3, null, 'tool_lead_card_invalid'], [4, null, 'tool_lead_card_invalid'], [5, 'scorer', 'tool_lead_no_measurable_development']]);
  assert.deepEqual(doc.leads.map((lead) => lead.id), [], 'the first "twice" has no literature response in this fixture, so it is refused too');
  for (const bad of [null, {}, { schema: CARDS_SCHEMA, observedAt: 'yesterday', cards: [] }, { schema: CARDS_SCHEMA, observedAt: '2026-11-04' }, { schema: 'x', observedAt: OBSERVED, cards: [] }]) {
    await assert.rejects(checkLeads({ cards: bad, literature: reader({}), inventory }), { code: 'tool_leads_cards_invalid' });
  }
  await assert.rejects(checkLeads({ cards: cardsFile([]), signals: { schema: SIGNALS_SCHEMA, signals: [{ module: 'tools' }] }, literature: reader({}), inventory }), { code: 'tool_leads_signals_invalid' });
  const empty = await checkLeads({ cards: cardsFile([]), literature: reader({}), inventory });
  assert.deepEqual([empty.leads, empty.refused, empty.inputs.signals, empty.inputs.pools], [[], [], null, null]);
});
