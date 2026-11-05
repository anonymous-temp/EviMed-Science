/**
 * Tool leads: the big loop's intake for "a tool the platform lacks" (2026-11-04). Finding such tools in the literature was the owner's idea
 * of 2026-10-04 and lived in the online engine's scout (`evolutionScout.mjs`, deleted the same day). Measured over its life: about 96% of its
 * spend (CNY 193.93) went to scouting, all 37 paper-scouting runs of the live deployment ended "waiting for material" on cards nobody could
 * act on, and no candidate ever got a verdict. So this is an intake and not a service: an operator's Claude session reads sources and writes
 * lead cards (briefs/tool-lead-scout.md); this file reads the cards, calls no model, and decides what code can decide —
 *
 *   node tool_leads.mjs check --cards cards.json [--signals signals.json] [--pools DIR] [--literature-fixture f | --literature-record f] --out leads.json
 *
 *  - the card's schema; every source's quote as a substring of the title or abstract Europe PMC holds for that PMID/DOI (one fixed primary
 *    index, a URL built here and never taken from a card, each response's sha256 recorded); the 24-month literature count from the same index;
 *  - the coverage gap, by comparing the method against what ships (the tool graph, the runtime's tool list, the capabilities, the method
 *    records, the virtual-study engine's methods), reported as the names that matched so a duplicate is visible;
 *  - demand, from the signals export (`scripts/ops/rsi-signals-export.mjs`) alone: distinct accounts and modules, closed codes, of the signal groups the
 *    operator selected — printed beside the score and not in it, because no code ties a group to the method;
 *  - eligibility, ported from `evolutionResearchEligibility` and tightened by what the online run taught: a lead whose development data cannot
 *    be measured is refused here, before anything is spent (`tool_lead_no_measurable_development`). Development data is a benchmark family of
 *    the lab's own scorer table; with `--pools` (the work directory's registered pools) its rows are counted too.
 *
 * Every number a lead is ranked on is measured here, and the query it is measured by is held to a closed syntax tied to the method's own name. A count a card states is ignored and recorded beside the measured one. Priority is
 * `evolutionPriorityBreakdown` with its weights, minus the terms that needed the online engine's own records (its failure table, waiting
 * agendas, the evaluator's reference-code and published-example checks, UCB exploration over its history, the model's own cost estimate,
 * dependency allowlist) — none of those exists in the big loop, and a term that cannot be measured is not claimed.
 *
 * A lead is a hypothesis and proves nothing. A lead goes on to a tool-patch or capability-skill round, whose registration and statistics decide.
 * Deterministic: the same cards, signals, pools, tree and recorded literature responses give the same bytes.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { canonicalRsiJson, rsiDigest } from '../../apps/server/src/rsiCampaignBundle.mjs';
import { quoteIsPresent } from '../../packages/domain/src/clinicalEvidence.mjs';
import { MCP_TOOL_BASE_NAMES, SOCKET_TOOL_NAME_LIST } from '../../packages/domain/src/toolNames.mjs';
import { VCR_ENGINE_METHOD_IDS } from '../../packages/domain/src/vcrEngineJob.mjs';
import { HARNESS_SCORERS, scorerBenchmarks } from './harness_scorers.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CARDS_SCHEMA = 'rsi-tool-lead-cards/1', LEADS_SCHEMA = 'rsi-tool-leads/1', LITERATURE_SCHEMA = 'rsi-tool-leads-literature/1';
/** The signals export's own schema (scripts/ops/rsi-signals-export.mjs) and the floor under which it withholds an account count. */
export const SIGNALS_SCHEMA = 'rsi-signals-export-v1', SIGNALS_FLOOR = 5;
export const TRACKS = Object.freeze(['E', 'P', 'M', 'U', 'X', 'T']);
export const TOOL_KINDS = Object.freeze(['calculation', 'workflow', 'connector']);
/** The round a lead goes on to: a candidate that holds code beside its text, or one that is text. */
export const SURFACES = Object.freeze(['tool-patch', 'capability-skill']);
/** The only reasons a card is refused. */
export const REFUSALS = Object.freeze(['tool_lead_card_invalid', 'tool_lead_duplicate_method', 'tool_lead_new_data_required', 'tool_lead_already_shipped',
  'tool_lead_no_measurable_development', 'tool_lead_source_unavailable', 'tool_lead_quote_not_found', 'tool_lead_too_few_sources',
  'tool_lead_literature_unavailable', 'tool_lead_no_literature_demand']);
/** `evolutionPriorityBreakdown`'s weights for the terms that can still be measured. */
export const LEAD_WEIGHTS = Object.freeze({ literature: 3, sourcesCap: 5, coverage: 3, data: 2 });
/** Verified distinct sources (the old "two published examples"); papers in 24 months (the old first-tool rule); accounts (the export's floor); confirmation rows (the procedure's `minimum_slice_groups`, statistics.py). */
export const LEAD_MINIMUMS = Object.freeze({ sources: 2, literature24Months: 2, demandAccounts: SIGNALS_FLOOR, confirmationRows: 25 });
/** benchmark -> the registered pool (`register_pools.py` writes pools/<file>.json). Every benchmark a scorer of the lab's table names is here (a test holds it). */
export const BENCHMARK_POOLS = Object.freeze({ 'medcalc-bench': ['medcalc', 'main'], bixbench: ['bixbench', 'main'], deepresearchbench: ['drb', 'main'], researchclawbench: ['rcb', 'main'],
  'autoresearchbench-deep': ['arb', 'deep'], 'autoresearchbench-wide': ['arb', 'wide'], medbrowsecomp: ['medbrowsecomp', 'main'] });

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const MAX_RESPONSE_BYTES = 512_000, LIST_CAP = 12;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const round = (value) => Math.round(value * 1e6) / 1e6;
const before = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fail = (code, message) => Object.assign(new Error(message ?? code), { code });

// ------------------------------------------------------------------------------------------------------------------------ priority

/** Each term of the score, every one from a measured feature. @param {Record<string, any>} features */
export function leadPriorityBreakdown(features) {
  const count = (key) => Math.max(0, Math.min(10_000, Number(features[key]) || 0));
  return Object.fromEntries(Object.entries({
    literature: LEAD_WEIGHTS.literature * Math.log1p(count('literature24Months')),
    sources: Math.min(count('verifiedSources'), LEAD_WEIGHTS.sourcesCap),
    coverage: LEAD_WEIGHTS.coverage * Number(features.coverageGap === true),
    data: LEAD_WEIGHTS.data * Number(features.developmentReachable === true),
  }).map(([key, value]) => [key, round(value)]));
}
/** @param {Record<string, any>} features */
export const leadPriority = (features) => round(Object.values(leadPriorityBreakdown(features)).reduce((a, b) => a + b, 0));

// ------------------------------------------------------------------------------------------------------------------------ schema

// Control characters and unpaired surrogates: neither is text, and the canonical JSON the digests are made of refuses the second.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\p{Cs}/u;
const METHOD_ID = /^[a-z0-9][a-z0-9._-]{1,79}$/, SLUG = /^[a-z][a-z0-9-]{1,40}$/, PMID = /^[1-9]\d{0,8}$/, DOI = /^10\.\d{4,9}\/[^\s<>"]+$/;
const KNOWN_KEYS = Object.freeze(['method', 'track', 'toolKind', 'surface', 'summary', 'sources', 'literatureQuery', 'developmentPlan', 'demand']);
const COUNT_CLAIMS = Object.freeze(['literature24Months', 'distinctAccounts', 'publishedExamples', 'verifiedSources', 'demandModules', 'score']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.length <= max && !CONTROL.test(value);

/**
 * The only query syntax a card may use, a format and not a reading: clauses joined by ` OR `, each clause terms joined by ` AND `, each term a quoted
 * phrase, optionally `TITLE_ABS:`-fenced. No parenthesis, no NOT, no other field, so the window the tool wraps around the query cannot be closed or
 * escaped, and every clause must fence one phrase that is the method's name, id or an alias: the count is the method's, not a topic's.
 * Returns the problem's code or null. @param {string} query @param {any} method
 */
export function queryProblem(query, method) {
  const names = new Set([method.id, method.name, ...(Array.isArray(method.aliases) ? method.aliases : [])].map(nameKey).filter(Boolean));
  const term = /(TITLE_ABS:)?"([^"()\\\u0000-\u001f]{2,200})"/y, joint = /\s+(AND|OR)\s+/y;
  let at = 0, tied = false, clauses = 0;
  for (;;) {
    term.lastIndex = at;
    const found = term.exec(query);
    if (!found) return 'query_outside_closed_syntax';
    if (found[1] && names.has(nameKey(found[2]))) tied = true;
    at = term.lastIndex;
    if (at === query.length) { clauses += 1; return tied ? null : 'query_clause_not_tied_to_the_method'; }
    joint.lastIndex = at;
    const next = joint.exec(query);
    if (!next) return 'query_outside_closed_syntax';
    if (next[1] === 'OR') { clauses += 1; if (!tied) return 'query_clause_not_tied_to_the_method'; tied = false; }
    at = joint.lastIndex;
  }
}

/** What is wrong with a card's shape, as [{field, problem}]. Counts a card states are not checked here: they are ignored. @param {any} card */
export function cardIssues(card) {
  /** @type {{field: string, problem: string}[]} */
  const issues = [];
  const bad = (field, problem) => issues.push({ field, problem });
  if (!isObject(card)) return [{ field: '', problem: 'not_an_object' }];
  const { method } = card;
  if (!isObject(method)) bad('method', 'missing');
  else {
    if (typeof method.id !== 'string' || !METHOD_ID.test(method.id)) bad('method.id', 'not_a_stable_lowercase_id');
    if (!text(method.name, 2, 200)) bad('method.name', 'text');
    if (method.aliases !== undefined && (!Array.isArray(method.aliases) || method.aliases.length > 8 || !method.aliases.every((alias) => text(alias, 2, 200)))) bad('method.aliases', 'list_of_text_at_most_8');
  }
  if (!TRACKS.includes(card.track)) bad('track', 'not_in_vocabulary');
  if (!TOOL_KINDS.includes(card.toolKind)) bad('toolKind', 'not_in_vocabulary');
  if (!SURFACES.includes(card.surface)) bad('surface', 'not_in_vocabulary');
  if (!text(card.summary, 1, 600)) bad('summary', 'text');
  if (!text(card.literatureQuery, 2, 1000)) bad('literatureQuery', 'text');
  else if (isObject(method)) { const problem = queryProblem(card.literatureQuery, method); if (problem) bad('literatureQuery', problem); }
  if (!Array.isArray(card.sources) || !card.sources.length || card.sources.length > 8) bad('sources', 'list_of_1_to_8');
  else card.sources.forEach((source, index) => {
    const at = `sources[${index}]`;
    if (!isObject(source)) return bad(at, 'not_an_object');
    if ((source.pmid === undefined) === (source.doi === undefined)) bad(at, 'exactly_one_of_pmid_or_doi');
    else if (source.pmid !== undefined && !(typeof source.pmid === 'string' && PMID.test(source.pmid))) bad(`${at}.pmid`, 'not_a_pmid');
    else if (source.doi !== undefined && !(typeof source.doi === 'string' && DOI.test(source.doi))) bad(`${at}.doi`, 'not_a_doi');
    if (!text(source.quote, 24, 600)) bad(`${at}.quote`, 'text_24_to_600');
    else if (/…|\.\.\./.test(source.quote)) bad(`${at}.quote`, 'one_contiguous_passage');
  });
  const plan = card.developmentPlan;
  if (plan !== undefined) {
    if (!isObject(plan)) bad('developmentPlan', 'not_an_object');
    else {
      if (!text(plan.benchmark, 1, 80)) bad('developmentPlan.benchmark', 'text');
      if (!text(plan.scorer, 1, 80)) bad('developmentPlan.scorer', 'text');
      if (plan.rows !== undefined && !Number.isFinite(plan.rows)) bad('developmentPlan.rows', 'number');
    }
  }
  const demand = card.demand;
  if (demand !== undefined) {
    if (!isObject(demand)) bad('demand', 'not_an_object');
    else {
      const axes = ['operations', 'dataShapes', 'capabilities'];
      for (const axis of axes) if (demand[axis] !== undefined && (!Array.isArray(demand[axis]) || demand[axis].length > 8 || !demand[axis].every((value) => typeof value === 'string' && SLUG.test(value)))) bad(`demand.${axis}`, 'list_of_slugs');
      if (!axes.some((axis) => Array.isArray(demand[axis]) && demand[axis].length)) bad('demand', 'names_no_axis');
    }
  }
  return issues;
}

/** The counts a card states (they are ignored) and the keys it has that the schema does not read. @param {any} card */
function claimsOf(card) {
  /** @type {{field: string, claimed: number}[]} */
  const claims = [];
  /** @type {string[]} */
  const unread = [];
  for (const [prefix, holder, extra] of [['', card, []], ['rankingFeatures.', card.rankingFeatures, []], ['developmentPlan.', card.developmentPlan, ['rows']]]) {
    if (!isObject(holder)) continue;
    for (const key of [...COUNT_CLAIMS, ...extra]) {
      const value = holder[key];
      if (!Number.isFinite(value)) continue;
      // A count too large for the canonical JSON is no count: it is listed with the keys the schema does not read.
      if (Math.abs(value) <= Number.MAX_SAFE_INTEGER) claims.push({ field: `${prefix}${key}`, claimed: value });
      else unread.push(`${prefix}${key}`);
    }
  }
  const names = Object.keys(card).filter((key) => !KNOWN_KEYS.includes(key) && !COUNT_CLAIMS.includes(key)).map((key) => (/^[A-Za-z0-9_.-]{1,64}$/.test(key) ? key : '(unreadable name)'));
  return { claims: claims.sort((a, b) => before(a.field, b.field)), fields: [...new Set([...names, ...unread])].sort(before) };
}

// ------------------------------------------------------------------------------------------------------------------------ inventory

/** The key a name is compared by: lower-case letters and digits, one space between runs. @param {string} name */
export const nameKey = (name) => String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * What ships, as names: the tool graph's nodes (evals/tool-graph), the runtime's tool list (domain `toolNames`), the capabilities (id and
 * title), the admitted calculations (method records) and the virtual-study engine's methods. Read from the tree, digested part by part.
 * @param {{root?: string}} [options]
 */
export async function loadInventory({ root = ROOT } = {}) {
  const parts = [];
  const add = (kind, names, digest) => {
    const unique = [...new Set(names.filter((name) => typeof name === 'string' && name))].sort(before);
    parts.push({ kind, count: unique.length, sha256: digest ?? sha(canonicalRsiJson(unique)), names: unique });
  };
  const graphDir = join(root, 'evals', 'tool-graph');
  const graphFiles = (await readdir(graphDir)).filter((name) => /^tdg\.[a-z0-9-]+\.json$/.test(name)).sort(before);
  const graphBytes = await Promise.all(graphFiles.map((name) => readFile(join(graphDir, name))));
  add('tool-graph', graphBytes.flatMap((bytes) => JSON.parse(bytes.toString('utf8')).nodes.map((node) => String(node.name).replace(/^mcp__[a-z0-9-]+__/, ''))), sha(graphBytes.map((bytes) => sha(bytes)).join('\n')));
  add('runtime-tool', [...MCP_TOOL_BASE_NAMES, ...SOCKET_TOOL_NAME_LIST]);
  const capabilityDirs = (await readdir(join(root, 'capabilities'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(before);
  const capabilities = [];
  for (const dir of capabilityDirs) {
    const bytes = await readFile(join(root, 'capabilities', dir, 'capability.yaml')).catch(() => null);
    if (bytes) { const manifest = YAML.parse(bytes.toString('utf8')); capabilities.push(manifest.id, manifest.title); }
  }
  add('capability', capabilities);
  const records = JSON.parse(await readFile(join(root, 'packages', 'domain', 'src', 'method-records.json'), 'utf8')).methods;
  add('method-record', Object.entries(records).flatMap(([id, record]) => [id, /** @type {any} */ (record).title]));
  add('vcr-method', VCR_ENGINE_METHOD_IDS);
  const entries = parts.flatMap((part) => part.names.map((name) => {
    // A dotted id ("comparator.rmst") is also known by its tail, which is how a person would say it; a title with a full stop in it is not an id.
    const keys = [nameKey(name), ...(name.includes('.') && !/\s/.test(name) ? [nameKey(name.split('.').pop() ?? '')] : [])].filter((key) => key.length >= 3);
    return { kind: part.kind, name, keys: [...new Set(keys)].map((key) => ({ key, tokens: key.split(' ') })) };
  }));
  return { entries, parts: parts.map(({ kind, count, sha256 }) => ({ kind, count, sha256 })), sha256: sha(parts.map((part) => `${part.kind}:${part.sha256}`).join('\n')) };
}

/**
 * Whether the platform already ships the method, and what it matched. `exact`: a name of the card is a shipped name; `inside`: all of a
 * card name's words (two or more) are in a shipped name, so what the card says is already said; both mean covered. `related`: a shipped
 * name of two or more words is wholly inside a card name — a variant of something shipped, shown and never a refusal.
 * @param {any} card @param {Awaited<ReturnType<typeof loadInventory>>} inventory
 */
export function coverageOf(card, inventory) {
  const names = [card.method.id, card.method.name, ...(card.method.aliases ?? [])].map(nameKey).filter(Boolean);
  const mine = [...new Set(names)].map((key) => ({ key, tokens: key.split(' ') }));
  const found = { exact: new Map(), inside: new Map(), related: new Map() };
  const contained = (small, large) => small.every((token) => large.includes(token));
  for (const entry of inventory.entries) for (const theirs of entry.keys) for (const own of mine) {
    const bucket = own.key === theirs.key ? 'exact'
      : own.tokens.length >= 2 && own.tokens.length < theirs.tokens.length && contained(own.tokens, theirs.tokens) ? 'inside'
        : theirs.tokens.length >= 2 && theirs.tokens.length < own.tokens.length && contained(theirs.tokens, own.tokens) ? 'related' : null;
    if (bucket) found[bucket].set(`${entry.kind}\u0000${entry.name}`, { kind: entry.kind, name: entry.name });
  }
  const list = (map) => [...map.values()].sort((a, b) => before(a.kind, b.kind) || before(a.name, b.name)).slice(0, LIST_CAP);
  return { covered: found.exact.size + found.inside.size > 0, exact: list(found.exact), inside: list(found.inside), related: list(found.related) };
}

// ------------------------------------------------------------------------------------------------------------------------ development data

/**
 * Whether anything could measure the lead: a benchmark family of the lab's scorer table, the scorer one that table lists for it, and — when
 * the registered pools were given — a confirmation pool of at least the procedure's minimum. The rows a card states are ignored.
 * @param {any} card @param {Record<string, {development: number, confirmation: number}> | null} pools
 */
export function developmentOf(card, pools) {
  const plan = card.developmentPlan;
  if (!plan) return { reachable: false, problem: 'no_plan' };
  const scorer = Object.hasOwn(HARNESS_SCORERS, plan.scorer) ? HARNESS_SCORERS[/** @type {keyof typeof HARNESS_SCORERS} */ (plan.scorer)] : null;
  const known = Object.hasOwn(BENCHMARK_POOLS, plan.benchmark);
  if (!known) return { reachable: false, problem: 'unknown_benchmark' };
  if (!scorer || !scorerBenchmarks(scorer).includes(plan.benchmark)) return { reachable: false, problem: 'scorer_mismatch' };
  const base = { benchmark: plan.benchmark, scorer: plan.scorer };
  if (!pools) return { reachable: true, ...base, rows: { measured: null, basis: 'registry' } };
  const rows = pools[plan.benchmark];
  if (!rows) return { reachable: false, problem: 'pool_missing', ...base };
  if (rows.confirmation < LEAD_MINIMUMS.confirmationRows) return { reachable: false, problem: 'rows_below_minimum', ...base, rows: { measured: rows, basis: 'pools' } };
  return { reachable: true, ...base, rows: { measured: rows, basis: 'pools' } };
}

/** The rows of each registered pool of `dir`, counted, and the files' digests. @param {string} dir */
export async function readPools(dir) {
  /** @type {Record<string, {development: number, confirmation: number}>} */
  const rows = {};
  /** @type {Record<string, string>} */
  const files = {};
  for (const [benchmark, [file, name]] of Object.entries(BENCHMARK_POOLS)) {
    const bytes = await readFile(join(dir, `${file}.json`)).catch(() => null);
    if (!bytes) continue;
    files[`${file}.json`] = sha(bytes);
    const pool = JSON.parse(bytes.toString('utf8'))?.pools?.[name];
    if (Array.isArray(pool?.development) && Array.isArray(pool?.confirmation)) rows[benchmark] = { development: pool.development.length, confirmation: pool.confirmation.length };
  }
  return { rows, files };
}

// ------------------------------------------------------------------------------------------------------------------------ demand

/** @param {any} signals */
export function signalsIssue(signals) {
  if (!isObject(signals) || signals.schema !== SIGNALS_SCHEMA || !Array.isArray(signals.signals)) return 'schema';
  const count = (value) => Number.isSafeInteger(value) || value === `<${SIGNALS_FLOOR}`;
  return signals.signals.every((group) => isObject(group) && ['module', 'kind', 'capability', 'operation', 'dataShape', 'reason'].every((key) => typeof group[key] === 'string') && count(group.accounts)) ? null : 'group';
}

/** What demand is, in the output: nothing ties a signal group's codes to the method, so the selector is the operator's claim and the score does not read it. */
export const DEMAND_CLAIM = 'operator-selected signal groups; not tied to the method by code, printed beside the score and not part of it';
/**
 * Demand for the method, from the signals export alone: the groups of unmet demand that the card's selector names, by their closed codes.
 * Accounts are the largest of the matching groups' counts (groups overlap, so they are never added); a group under the export's floor
 * counts for nothing and is only counted as withheld.
 * @param {any} card @param {any} signals
 */
export function demandOf(card, signals) {
  const none = (basis) => ({ basis, claim: DEMAND_CLAIM, accounts: 0, modules: [], matched: [], withheld: 0 });
  if (!signals) return none('no-signals-file');
  if (!card.demand) return none('no-selector');
  const wants = (axis, value) => !Array.isArray(card.demand[axis]) || !card.demand[axis].length || card.demand[axis].includes(value);
  const groups = signals.signals.filter((group) => group.kind === 'unmet-demand' && wants('operations', group.operation) && wants('dataShapes', group.dataShape) && wants('capabilities', group.capability));
  const counted = groups.filter((group) => Number.isSafeInteger(group.accounts) && group.accounts >= LEAD_MINIMUMS.demandAccounts);
  const matched = counted.map((group) => ({ module: group.module, capability: group.capability, operation: group.operation, dataShape: group.dataShape, reason: group.reason, accounts: group.accounts }))
    .sort((a, b) => before(a.module, b.module) || before(a.capability, b.capability) || before(a.operation, b.operation) || before(a.dataShape, b.dataShape) || before(a.reason, b.reason));
  return { basis: 'signals', claim: DEMAND_CLAIM, accounts: Math.max(0, ...counted.map((group) => group.accounts)), modules: [...new Set(matched.map((group) => group.module))].sort(before), matched, withheld: groups.length - counted.length };
}

// ------------------------------------------------------------------------------------------------------------------------ literature

/** @param {string} query @param {{core?: boolean, pageSize: number}} options */
export function epmcUrl(query, { core = false, pageSize }) {
  const url = new URL(EPMC);
  url.searchParams.set('query', query); url.searchParams.set('format', 'json');
  if (core) url.searchParams.set('resultType', 'core');
  url.searchParams.set('pageSize', String(pageSize));
  return url.toString();
}
/** The request a source is read by: its PMID or DOI, in the index's own fields. @param {{pmid?: string, doi?: string}} source */
export const sourceUrl = (source) => epmcUrl(source.pmid ? `EXT_ID:${source.pmid} AND SRC:MED` : `DOI:"${source.doi}"`, { core: true, pageSize: 5 });
/** The 24-month count request, as `measureEvolutionLiterature` made it. @param {string} query @param {string} observedAt YYYY-MM-DD */
export function literatureUrl(query, observedAt) {
  const start = new Date(`${observedAt}T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - 24);
  const window = { from: start.toISOString().slice(0, 10), to: observedAt };
  const full = `(${query}) AND FIRST_PDATE:[${window.from} TO ${window.to}] AND SRC:MED`;
  return { query: full, url: epmcUrl(full, { pageSize: 5 }), window };
}

/** The text of a title or abstract the index sends as markup: block tags are breaks, inline ones vanish, entities are decoded. @param {unknown} markup */
export function readableText(markup) {
  return String(markup ?? '').replace(/<\/?(?:h[1-6]|p|br|li|ul|ol|div|sec|title|abstracttext)\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[String(name).toLowerCase()];
      if (named) return named;
      const code = name[0] === '#' ? Number.parseInt(name.slice(name[1] === 'x' || name[1] === 'X' ? 2 : 1), name[1] === 'x' || name[1] === 'X' ? 16 : 10) : Number.NaN;
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }).toWellFormed().normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** @typedef {{ok: true, body: string} | {ok: false, code: string}} Reply */
/** Replies from a recorded file; nothing is fetched. @param {any} fixture */
export function fixtureReader(fixture) {
  if (!isObject(fixture) || fixture.schema !== LITERATURE_SCHEMA || !isObject(fixture.responses) || !Object.values(fixture.responses).every((body) => typeof body === 'string')) throw fail('tool_leads_fixture_invalid');
  return { /** @param {string} url @returns {Promise<Reply>} */ get: async (url) => (Object.hasOwn(fixture.responses, url) ? { ok: true, body: fixture.responses[url] } : { ok: false, code: 'fixture_missing' }) };
}
/** Replies from the index itself, one request at a time with a pause, redirects refused, 30 s and 512,000 bytes each. @param {{fetchImpl?: typeof fetch, pauseMs?: number}} [options] */
export function networkReader({ fetchImpl = fetch, pauseMs = 250 } = {}) {
  let last = Promise.resolve();
  return { /** @param {string} url @returns {Promise<Reply>} */ get: (url) => (last = last.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    try {
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
      if (!response.ok) return { ok: false, code: 'index_unavailable' };
      const body = await response.text();
      return Buffer.byteLength(body) > MAX_RESPONSE_BYTES ? { ok: false, code: 'response_too_large' } : { ok: true, body };
    } catch { return { ok: false, code: 'index_unavailable' }; }
  })) };
}
/** One fetch per URL, and the bodies kept so a run can be recorded and replayed. @param {{get: (url: string) => Promise<Reply>}} inner */
function recordingReader(inner) {
  /** @type {Map<string, Promise<Reply>>} */
  const replies = new Map();
  return {
    get: (url) => { if (!replies.has(url)) replies.set(url, inner.get(url)); return /** @type {Promise<Reply>} */ (replies.get(url)); },
    /** The bodies read, in URL order. */
    async responses() {
      const read = await Promise.all([...replies].map(async ([url, reply]) => [url, await reply]));
      return Object.fromEntries(read.filter(([, reply]) => reply.ok).sort(([a], [b]) => before(a, b)).map(([url, reply]) => [url, reply.body]));
    },
  };
}

/** One source: the record the index holds for it and whether the card's quote is in its title or abstract. @param {{pmid?: string, doi?: string, quote: string}} source @param {{get: Function}} reader */
async function readSource(source, reader) {
  const url = sourceUrl(source);
  const reply = await reader.get(url);
  if (!reply.ok) return { problem: 'tool_lead_source_unavailable', code: reply.code };
  let value;
  try { value = JSON.parse(reply.body); } catch { return { problem: 'tool_lead_source_unavailable', code: 'response_unreadable' }; }
  const results = Array.isArray(value?.resultList?.result) ? value.resultList.result : [];
  const record = results.find((item) => (source.pmid ? item?.source === 'MED' && String(item.id) === source.pmid : String(item?.doi ?? '').toLowerCase() === String(source.doi).toLowerCase()));
  if (!record) return { problem: 'tool_lead_source_unavailable', code: 'record_not_found' };
  const title = readableText(record.title), abstract = readableText(record.abstractText);
  const found = (title && quoteIsPresent(title, source.quote)) || (abstract && quoteIsPresent(abstract, source.quote));
  return { identity: `${record.source}:${record.id}`, pmid: record.pmid ?? null, doi: record.doi ?? null, title, found: Boolean(found), responseSha256: sha(reply.body) };
}

/** The 24-month count, as `measureEvolutionLiterature` measured it. @param {string} query @param {string} observedAt @param {{get: Function}} reader */
async function readLiterature(query, observedAt, reader) {
  const request = literatureUrl(query, observedAt);
  const reply = await reader.get(request.url);
  if (!reply.ok) return { problem: reply.code };
  let value;
  try { value = JSON.parse(reply.body); } catch { return { problem: 'response_unreadable' }; }
  const count = Number(value?.hitCount);
  if (!Number.isSafeInteger(count) || count < 0) return { problem: 'count_unavailable' };
  const papers = (Array.isArray(value.resultList?.result) ? value.resultList.result : []).filter((item) => item?.source === 'MED' && /^\d+$/.test(String(item.id)))
    .map((item) => ({ pmid: String(item.id), doi: item.doi ?? null, title: readableText(item.title), firstPublicDate: item.firstPublicationDate ?? null }));
  return { count, papers, query: request.query, url: request.url, window: request.window, responseSha256: sha(reply.body) };
}

// ------------------------------------------------------------------------------------------------------------------------ check

/**
 * @param {{cards: any, cardsSha256?: string, signals?: any, signalsSha256?: string, pools?: Awaited<ReturnType<typeof readPools>> | null,
 *   literature: {get: Function, responses?: Function}, inventory: Awaited<ReturnType<typeof loadInventory>>}} input
 */
export async function checkLeads({ cards, cardsSha256 = null, signals = null, signalsSha256 = null, pools = null, literature, inventory }) {
  if (!isObject(cards) || cards.schema !== CARDS_SCHEMA || !Array.isArray(cards.cards) || cards.cards.length > 200) throw fail('tool_leads_cards_invalid');
  const observedAt = cards.observedAt;
  if (typeof observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(observedAt) || Number.isNaN(Date.parse(`${observedAt}T00:00:00Z`))) throw fail('tool_leads_cards_invalid', 'observedAt must be a date, YYYY-MM-DD');
  if (signals && signalsIssue(signals)) throw fail('tool_leads_signals_invalid', `the signals file is not a ${SIGNALS_SCHEMA} (${signalsIssue(signals)})`);
  const reader = literature.responses ? literature : recordingReader(literature);
  const leads = [], refused = [], seen = new Set();
  for (const [index, card] of cards.cards.entries()) {
    const id = isObject(card) && isObject(card.method) && typeof card.method.id === 'string' && METHOD_ID.test(card.method.id) ? card.method.id : null;
    const refuse = (reasons) => refused.push({ index, id, reasons });
    const issues = cardIssues(card);
    if (issues.length) { refuse(issues.map((issue) => ({ code: 'tool_lead_card_invalid', ...issue }))); continue; }
    if (seen.has(id)) { refuse([{ code: 'tool_lead_duplicate_method' }]); continue; }
    seen.add(id);
    // What can be decided from the card, the tree and the registered pools comes first: a card refused here costs no request.
    const coverage = coverageOf(card, inventory), development = developmentOf(card, pools?.rows ?? null), demand = demandOf(card, signals);
    const local = [];
    if (card.track === 'X') local.push({ code: 'tool_lead_new_data_required' });
    if (coverage.covered) local.push({ code: 'tool_lead_already_shipped', matched: [...coverage.exact, ...coverage.inside] });
    if (!development.reachable) local.push({ code: 'tool_lead_no_measurable_development', problem: development.problem });
    if (local.length) { refuse(local); continue; }
    const sources = [], reasons = [];
    for (const [at, source] of card.sources.entries()) {
      const read = await readSource(source, reader);
      if (read.problem) reasons.push({ code: read.problem, source: at, problem: read.code });
      else if (!read.found) reasons.push({ code: 'tool_lead_quote_not_found', source: at });
      else sources.push({ identity: read.identity, pmid: read.pmid, doi: read.doi, title: read.title, quote: source.quote, responseSha256: read.responseSha256 });
    }
    const distinct = new Set(sources.map((source) => source.identity)).size;
    if (!reasons.length && distinct < LEAD_MINIMUMS.sources) reasons.push({ code: 'tool_lead_too_few_sources', distinct, minimum: LEAD_MINIMUMS.sources });
    const measured = await readLiterature(card.literatureQuery, observedAt, reader);
    if (measured.problem) reasons.push({ code: 'tool_lead_literature_unavailable', problem: measured.problem });
    else if (measured.count < LEAD_MINIMUMS.literature24Months) reasons.push({ code: 'tool_lead_no_literature_demand', count: measured.count, minimum: LEAD_MINIMUMS.literature24Months });
    if (reasons.length) { refuse(reasons); continue; }
    const features = { literature24Months: measured.count, verifiedSources: distinct, coverageGap: true, developmentReachable: true };
    const breakdown = leadPriorityBreakdown(features), score = leadPriority(features);
    const { claims, fields } = claimsOf(card);
    const rowsMeasured = development.rows?.measured ? development.rows.measured.development + development.rows.measured.confirmation : null;
    const measuredFor = { literature24Months: features.literature24Months, distinctAccounts: demand.accounts, publishedExamples: features.verifiedSources, verifiedSources: features.verifiedSources,
      demandModules: demand.modules.length, score, rows: rowsMeasured };
    const lead = { id, method: { id, name: card.method.name, aliases: card.method.aliases ?? [] }, track: card.track, toolKind: card.toolKind, surface: card.surface, summary: card.summary,
      sources, literature: { query: measured.query, url: measured.url, window: measured.window, count: measured.count, responseSha256: measured.responseSha256, papers: measured.papers },
      coverage, development: { benchmark: development.benchmark, scorer: development.scorer, rows: { claimed: card.developmentPlan.rows ?? null, ...development.rows } },
      demand, features, breakdown, score,
      ignored: { claims: claims.map((claim) => ({ ...claim, measured: measuredFor[/** @type {keyof typeof measuredFor} */ (claim.field.split('.').pop() ?? '')] ?? null })), fields } };
    leads.push({ ...lead, digest: rsiDigest(lead) });
  }
  leads.sort((a, b) => b.score - a.score || before(a.id, b.id));
  const body = { schema: LEADS_SCHEMA, tool: 'tool_leads.mjs/1', observedAt, weights: LEAD_WEIGHTS, minimums: LEAD_MINIMUMS,
    inputs: { cards: cardsSha256, signals: signals ? { sha256: signalsSha256, from: signals.from ?? null, to: signals.to ?? null, releaseId: signals.releaseId ?? null } : null,
      inventory: { sha256: inventory.sha256, parts: inventory.parts }, pools: pools ? pools.files : null,
      literature: Object.entries(await reader.responses()).map(([url, body]) => ({ url, sha256: sha(body) })) },
    leads: leads.map((lead, at) => ({ rank: at + 1, ...lead })), refused };
  return { ...body, digest: rsiDigest(body) };
}

// ------------------------------------------------------------------------------------------------------------------------ command line

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { cards: { type: 'string' }, signals: { type: 'string' }, pools: { type: 'string' }, out: { type: 'string' },
    'literature-fixture': { type: 'string' }, 'literature-record': { type: 'string' } } });
  if (positionals.join(' ') !== 'check' || !values.cards || !values.out || (values['literature-fixture'] && values['literature-record'])) {
    console.error('usage: tool_leads.mjs check --cards cards.json --out leads.json [--signals signals.json] [--pools DIR] [--literature-fixture f | --literature-record f]');
    process.exit(2);
  }
  const read = async (path) => { const bytes = await readFile(path); return { bytes, json: JSON.parse(bytes.toString('utf8')) }; };
  const cards = await read(values.cards), signals = values.signals ? await read(values.signals) : null;
  // A fixture means no network at all; without one the index is asked, and `--literature-record` keeps what it said for a replay.
  const recorded = recordingReader(values['literature-fixture'] ? fixtureReader((await read(values['literature-fixture'])).json) : networkReader());
  const doc = await checkLeads({ cards: cards.json, cardsSha256: sha(cards.bytes), signals: signals?.json ?? null, signalsSha256: signals ? sha(signals.bytes) : null,
    pools: values.pools ? await readPools(values.pools) : null, literature: recorded, inventory: await loadInventory() });
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, `${JSON.stringify(doc, null, 2)}\n`);
  if (values['literature-record']) await writeFile(values['literature-record'], `${JSON.stringify({ schema: LITERATURE_SCHEMA, responses: await recorded.responses() }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'ok', leads: doc.leads.length, refused: doc.refused.length, digest: doc.digest }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { console.error(error?.code && error.message !== error.code ? `${error.code}: ${error.message}` : error?.message ?? error); process.exit(1); });
