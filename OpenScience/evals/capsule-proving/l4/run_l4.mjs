#!/usr/bin/env node
/** L4: product embedding shortlist and product DECIDE/BUILD, with public planted-pair gold.
 * Run on the lab: node evals/capsule-proving/l4/run_l4.mjs --phase screen|decide|native|report|all
 * [--sizes 50,200,600] [--root /srv/evimed/runs] [--data /srv/evimed/data/memdata-data/l4].
 * Each independent, disjoint product group has its own OfflineLoop and checkpoint. Exhausting those
 * groups removes the nightly 100-method/6-group scheduling bounds, not the product's decision/build logic.
 * `all` runs screening, the exhaustive group diagnostic, the defect re-test and a native full-store pass.
 * `native` is one sequential lane and never overwrites an in-progress diagnostic summary. Use `report`
 * after all lanes finish to join receipts, diagnose retrieval misses and regenerate idempotent ledger rows.
 * No learned SCREEN judge is enabled: this measures the deployed embedding screen, not a new prompt.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { MAX_ACTIVE_LEARNED_METHODS, METHOD_SKILL_SCHEMA, METHOD_SIMILARITY_PAIR_FLOOR, METHOD_SIMILARITY_TOP_K } from '@evimed/domain';
import { CONSOLIDATION_LIMITS, groupPairs, groupKey, resolveAssignments } from '../../../apps/server/src/methodConsolidation.mjs';
import { KbEmbedder } from '../../../apps/server/src/kbEmbedding.mjs';
import { OfflineLoop, OFFLINE_USER } from '../learn/offlineLoop.mjs';
import { createDeepSeekClient, firstLine } from '../run/deepseek.mjs';
import { estimateCostCny, wilson as wilson95 } from '../run/ledger.mjs';

export const FLOORS = Array.from({ length: 11 }, (_, i) => (30 + i * 5) / 100);
export const KINDS = ['duplicate', 'subset', 'conflict', 'unrelated'];
const TYPES = { duplicate: 'merge', subset: 'subset', conflict: 'conflicts_with' };
const hash = value => createHash('sha256').update(value).digest('hex');
export const pairKey = (a, b) => JSON.stringify([a, b].sort());
const json = file => readFile(file, 'utf8').then(JSON.parse);
async function optional(file) { try { return await json(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function save(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 1)}\n`); await rename(`${file}.tmp`, file); }
async function parkIncompleteState(dir) {
  try { await rename(path.join(dir, 'library.json'), path.join(dir, 'interrupted-library.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const note = (dir, value) => appendFile(path.join(dir, 'STATUS'), `${new Date().toISOString()} ${JSON.stringify(value)}\n`);
export const zeroTokens = () => ({ prompt: 0, completion: 0, cached: 0, extractionPrompt: 0, extractionCompletion: 0 });
const tokensOf = usage => ({ ...zeroTokens(), prompt: usage.promptTokens ?? 0, completion: usage.completionTokens ?? 0, cached: usage.cachedTokens ?? 0 });
const sumTokens = rows => rows.reduce((sum, row) => Object.fromEntries(Object.keys(sum).map(k => [k, sum[k] + (row[k] ?? 0)])), zeroTokens());

export const FILLER_WORDING = { '密码': '认证凭据', '令牌': '授权凭据', '密钥': '加密凭据', '身份证': '个人证件', '手机号': '移动电话号码', '银行卡': '支付卡' };
/** Only generic nouns in known public filler rules are substituted; never used on planted gold or real inputs. */
export function admittedMethod(method) {
  if (method.source !== 'filler') return method;
  const replace = text => Object.entries(FILLER_WORDING).reduce((value, [from, to]) => value.replaceAll(from, to), text);
  return { ...method, body: replace(method.body), whenToUse: replace(method.whenToUse) };
}

/** Labels and original ids NEVER reach the model or embedder. Planted bodies remain verbatim within Workflow. */
export function methodInput(method) {
  method = admittedMethod(method);
  const name = `method-${hash(method.id).slice(0, 16)}`;
  const title = method.body.match(/^#+\s+(.+)$/m)?.[1] ?? method.whenToUse;
  return { frontmatter: { name, description: title, whenToUse: method.whenToUse,
    metadata: { role: 'functional', applies_when: method.whenToUse, not_when: 'Outside the stated situation.',
      derived_from: 'run:l4-import', evimed_schema: METHOD_SKILL_SCHEMA } },
  body: ['## Purpose', title, '', '## When to Use', method.whenToUse, '', '## Inputs',
    'The inputs specified by the supplied procedure.', '', '## Workflow', method.body, '',
    '## Verification', 'Use the checks specified in the supplied procedure.', '', '## Constraints',
    'Use the constraints specified in the supplied procedure.', '', '## Output', 'The result specified in the supplied procedure.'].join('\n'),
  provenance: { origin: 'inferred', runId: 'l4-import' } };
}

export async function seed(loop, methods) {
  const mapping = {};
  for (const method of methods) {
    const input = methodInput(method);
    // Stable opaque names make imports identical across sizes, arms and restarts.
    const found = [...loop.documents.rows.values()].find(row => row.payload?.frontmatter?.name === input.frontmatter.name);
    const document = found ?? await loop.learning.createCandidate(OFFLINE_USER, input);
    if (document.payload.status !== 'approved') throw new Error('L4 seed was not approved by the product');
    mapping[method.id] = document.id;
  }
  return mapping;
}

export function screenRows(pairs, gold) {
  return FLOORS.map(floor => {
    const kept = pairs.filter(pair => pair.score >= floor);
    const keys = new Set(kept.map(pair => pairKey(pair.a, pair.b)));
    const byKind = Object.fromEntries(KINDS.map(kind => {
      const labelled = gold.filter(pair => pair.relation === kind);
      const hits = labelled.filter(pair => keys.has(pairKey(pair.a, pair.b))).length;
      return [kind, { n: labelled.length, hits, recall: labelled.length ? hits / labelled.length : null, ci95: labelled.length ? wilson95(hits, labelled.length) : null }];
    }));
    const positives = gold.filter(pair => pair.relation !== 'unrelated');
    const hits = positives.filter(pair => keys.has(pairKey(pair.a, pair.b))).length;
    return { floor, candidates: kept.length, n: positives.length, hits, recall: hits / positives.length,
      ci95: wilson95(hits, positives.length), byKind, groups: groupPairs(kept, { maxGroups: 10000 }).length };
  });
}

/** Highest floor preserving each positive relation's attainable recall at 0.30 in EVERY size.
 * A calibration recommendation, not independent validation (public planted pairs, one seed). */
export function recommend(summaries) {
  const good = FLOORS.filter(floor => summaries.every(summary => ['duplicate', 'subset', 'conflict'].every(kind =>
    summary.screen.find(row => row.floor === floor).byKind[kind].hits >= summary.screen[0].byKind[kind].hits)));
  return { floor: Math.max(...good), rule: 'Highest floor preserving per-kind recall attained at 0.30 in every library; public calibration only.',
    costs: summaries.map(summary => ({ size: summary.size, ...summary.screen.find(row => row.floor === Math.max(...good)) })) };
}

/** Group assignments are expanded to pair claims with directed subset scoring. All other pairs are weak none labels. */
export function scoreDecisions(gold, predictions) {
  const claimed = new Map();
  for (const claim of predictions) claimed.set(`${pairKey(claim.a, claim.b)}:${claim.type}:${claim.wider ?? ''}`, claim);
  const claims = [...claimed.values()];
  const byKind = {};
  for (const kind of ['duplicate', 'subset', 'conflict']) {
    const expected = gold.filter(pair => pair.relation === kind);
    const actual = claims.filter(pair => pair.type === TYPES[kind]);
    const correct = (claim, pair) => pairKey(claim.a, claim.b) === pairKey(pair.a, pair.b)
      && (kind !== 'subset' || claim.wider === pair.a);
    const tp = actual.filter(claim => expected.some(pair => correct(claim, pair))).length;
    const precision = actual.length ? tp / actual.length : null;
    const recall = expected.length ? tp / expected.length : null;
    byKind[kind] = { tp, predicted: actual.length, n: expected.length, precision, recall,
      f1: precision !== null && recall !== null && precision + recall ? 2 * precision * recall / (precision + recall) : 0,
      precisionCi95: actual.length ? wilson95(tp, actual.length) : null, recallCi95: expected.length ? wilson95(tp, expected.length) : null,
      falsePositives: actual.filter(claim => !expected.some(pair => correct(claim, pair))) };
  }
  const negatives = gold.filter(pair => pair.relation === 'unrelated');
  const violated = negatives.filter(pair => claims.some(claim => pairKey(claim.a, claim.b) === pairKey(pair.a, pair.b)));
  const abstained = gold.filter(pair => !claims.some(claim => pairKey(claim.a, claim.b) === pairKey(pair.a, pair.b))).length;
  const trueApart = negatives.length - violated.length;
  const apartPrecision = abstained ? trueApart / abstained : null;
  const apartRecall = negatives.length ? trueApart / negatives.length : null;
  byKind.unrelated = { n: negatives.length, keptApart: trueApart, predicted: abstained,
    precision: apartPrecision, recall: apartRecall,
    f1: apartPrecision !== null && apartRecall !== null && apartPrecision + apartRecall ? 2 * apartPrecision * apartRecall / (apartPrecision + apartRecall) : 0,
    precisionCi95: abstained ? wilson95(trueApart, abstained) : null, recallCi95: negatives.length ? wilson95(trueApart, negatives.length) : null,
    note: 'Unrelated precision counts abstention over the labelled pair universe only; includes pairs not retrieved/read. Recall is the planted look-alike kept-apart rate.', violated };
  const labelled = claims.filter(claim => gold.some(pair => pairKey(pair.a, pair.b) === pairKey(claim.a, claim.b)));
  return { byKind, predictions: claims, labelledPredictions: labelled.length,
    unlabelledPredictions: claims.length - labelled.length,
    precisionCaveat: 'Non-planted pairs are unlabelled, provisionally none. Precision is weak-label precision; inspect false positives before treating them as errors.' };
}

export function claimsOf(assignments, mapping) {
  const reverse = new Map(Object.entries(mapping).map(([original, id]) => [id, original]));
  const members = Object.values(mapping).map(id => ({ id, payload: { frontmatter: { name: id.replace(/^method:learned:/, '') } } }));
  const claims = [];
  for (const { entry: assignment, skills: ids, wider, replaces } of resolveAssignments(members, assignments)) {
    if (!ids) continue;
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      if (assignment.RELATION_TYPE === 'subset' && ![ids[a], ids[b]].includes(wider)) continue;
      if (assignment.RELATION_TYPE === 'supersedes' && ![ids[a], ids[b]].includes(replaces)) continue;
      claims.push({ a: reverse.get(ids[a]), b: reverse.get(ids[b]), type: assignment.RELATION_TYPE,
        ...(wider ? { wider: reverse.get(wider) } : {}), ...(replaces ? { replaces: reverse.get(replaces) } : {}), reason: assignment.REASON });
    }
  }
  return claims;
}

/** Persist only one small embedding batch at a time. Cache is model+dimension+text bound. */
export async function diskEmbedder(options) {
  const pin = JSON.parse(await readFile(new URL('../../../deps-version.json', import.meta.url), 'utf8')).openviking.embedding;
  const engine = new KbEmbedder({ ...pin, apiKey: (await readFile(options.embedKey, 'utf8')).trim() });
  const directory = path.join(options.root, 'l4-embedding-cache', engine.modelKey);
  await mkdir(directory, { recursive: true });
  return { model: engine.modelKey, counters: engine.counters,
    embed: async texts => {
      const vectors = [];
      for (let at = 0; at < texts.length; at += 10) {
        const batch = texts.slice(at, at + 10);
        const files = batch.map(text => path.join(directory, `${hash(text)}.json`));
        const held = await Promise.all(files.map(optional));
        const missing = held.map((value, index) => value ? -1 : index).filter(index => index >= 0);
        if (missing.length) {
          const fresh = await engine.embedDocuments(missing.map(index => batch[index]));
          for (const [i, index] of missing.entries()) { held[index] = fresh[i]; await save(files[index], fresh[i]); }
        }
        vectors.push(...held);
      }
      return vectors;
    } };
}

async function warm(similarity, methods) {
  for (let at = 0; at < methods.length; at += 100) {
    const result = await similarity.pairs(methods.slice(at, at + 100), { floor: -1 });
    if (result.mode !== 'embedding') throw new Error('L4 requires embeddings; lexical fallback refused');
  }
}

export async function screenLibrary(options, size, embedder, model) {
  const dir = path.join(options.root, `l4-${size}-1`);
  await mkdir(dir, { recursive: true });
  const library = await json(path.join(options.data, `library-${size}.json`));
  const goldFile = await json(path.join(options.data, `gold-${size}.json`));
  const manifest = await json(path.join(options.data, 'manifest.json'));
  for (const name of [`library-${size}.json`, `gold-${size}.json`]) {
    if (hash(await readFile(path.join(options.data, name))) !== manifest.sha256[name]) throw new Error(`Input digest mismatch: ${name}`);
  }
  const saved = await optional(path.join(dir, 'summary.json'));
  if (saved?.screen) {
    if (saved.model !== model.model || saved.thinking !== model.thinking || saved.embedModel !== embedder.model
      || [`library-${size}.json`, `gold-${size}.json`].some(name => saved.inputDigests?.[name] !== manifest.sha256[name])) {
      throw new Error('L4 resume configuration/input mismatch; use a new run root');
    }
    return saved;
  }
  const loop = await OfflineLoop.open({ dir: path.join(dir, 'seed'), env: `l4-${size}`, model, embed: embedder.embed, embedModel: embedder.model });
  const mapping = await seed(loop, library.methods);
  const methods = [...loop.documents.rows.values()].filter(row => row.kind === 'method');
  await save(path.join(dir, 'mapping.json'), mapping);
  await save(loop.statePath, { ...loop.state, documents: loop.documents.snapshot() });
  await note(dir, { phase: 'seeded', methods: methods.length });
  const before = { ...embedder.counters };
  await warm(loop.similarity, methods);
  const candidates = await loop.similarity.pairs(methods, { floor: FLOORS[0] });
  if (candidates.mode !== 'embedding') throw new Error('L4 requires embeddings; lexical fallback refused');
  const reverse = new Map(Object.entries(mapping).map(([original, id]) => [id, original]));
  const pairs = candidates.map(pair => ({ ...pair, a: reverse.get(pair.a), b: reverse.get(pair.b) }));
  await writeFile(path.join(dir, 'pairs.jsonl'), pairs.map(pair => JSON.stringify({ stage: 'screen', ...pair,
    gold: goldFile.pairs.find(g => pairKey(g.a, g.b) === pairKey(pair.a, pair.b))?.relation ?? 'unlabelled' })).join('\n') + '\n');
  const native = (await loop.learning.listMethods(OFFLINE_USER, { limit: CONSOLIDATION_LIMITS.maxMethods })).items;
  const nativePairs = await loop.similarity.pairs(native, { floor: METHOD_SIMILARITY_PAIR_FLOOR });
  const nativeGroups = groupPairs(nativePairs, { maxGroups: CONSOLIDATION_LIMITS.maxMethods });
  const nativeSet = new Set(native.map(document => reverse.get(document.id)));
  const nativeKeys = new Set(nativePairs.map(pair => pairKey(reverse.get(pair.a), reverse.get(pair.b))));
  const grouped = floor => {
    const groups = groupPairs(pairs.filter(pair => pair.score >= floor), { maxGroups: 10000 });
    return goldFile.pairs.filter(pair => pair.relation !== 'unrelated' && groups.some(group => group.includes(pair.a) && group.includes(pair.b))).length;
  };
  const summary = { schema: 'capsule-proving-l4/1', size, runId: `l4-${size}-1`, commit: options.commit, startedAt: new Date().toISOString(),
    inputDigests: manifest.sha256, model: model.model, thinking: model.thinking, concurrency: options.concurrency,
    adaptation: 'Opaque hash names; description is the source body title; supplied procedure inside seven-section Workflow wrapper. Planted bodies verbatim. No gold ids in prompts.',
    admissionAdaptations: library.methods.filter(method => JSON.stringify(admittedMethod(method)) !== JSON.stringify(method)).map(method => ({ id: method.id,
      rawRejectedBy: 'method_sensitive_content', changes: Object.entries(FILLER_WORDING).filter(([word]) => `${method.body}\n${method.whenToUse}`.includes(word)) })),
    embedModel: embedder.model, embedding: Object.fromEntries(Object.keys(before).map(key => [key, embedder.counters[key] - before[key]])),
    screen: screenRows(pairs, goldFile.pairs).map(row => ({ ...row, groupedPositiveHits: grouped(row.floor) })),
    productBounds: { ...CONSOLIDATION_LIMITS, topK: METHOD_SIMILARITY_TOP_K,
      note: 'Without J1 (deployed setting), maxScreenPairs does not truncate the shortlist. maxMethods still limits sleep/integrate to newest 100.',
      nativeMethods: native.length, nativeCandidatesAt050: nativePairs.length, nativeGroupsAt050: nativeGroups.length,
      nativePositivePairsInWindow: goldFile.pairs.filter(pair => pair.relation !== 'unrelated' && nativeSet.has(pair.a) && nativeSet.has(pair.b)).length,
      nativePositivePairHitsAt050: goldFile.pairs.filter(pair => pair.relation !== 'unrelated' && nativeKeys.has(pairKey(pair.a, pair.b))).length,
      nativeFirstPassGroupsAt050: Math.min(nativeGroups.length, CONSOLIDATION_LIMITS.maxGroups) }, decide: {} };
  await save(path.join(dir, 'summary.json'), summary);
  await note(dir, { phase: 'screen-complete', candidates: pairs.length });
  return summary;
}

async function usageLog(file) {
  const lines = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  return lines.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** Each group is run through the product's actual sleep (approve, decide, apply, build, guards, stamps).
 * Independent stores remove nightly scheduling caps for an exhaustive diagnostic. Group membership
 * and opaque method ids come from the full-library product shortlist, never from gold. */
export async function runGroup({ dir, originals, pairs, embedder, model, floor, groupId }) {
  const completed = await optional(path.join(dir, 'result.json'));
  if (completed) return completed;
  // A crash between the library checkpoint and its receipt must replay from original heads, not seed changed/retired heads.
  // Exact prompt answers remain cached and all earlier paid calls remain in calls.jsonl.
  await parkIncompleteState(dir);
  const loop = await OfflineLoop.open({ dir, env: `l4-group-${groupId}`, model, embed: embedder.embed, embedModel: embedder.model });
  const mapping = await seed(loop, originals);
  const documents = [...loop.documents.rows.values()].filter(row => row.kind === 'method');
  await warm(loop.similarity, documents);
  const similarity = loop.similarity;
  // Freeze the exact full-library shortlist. Recomputing topK within a group would add edges.
  loop.consolidation.similarity = { ...similarity, pairs: async () => {
    const result = pairs.map(pair => ({ ...pair, a: mapping[pair.a], b: mapping[pair.b] }));
    Object.defineProperty(result, 'mode', { value: 'embedding' });
    return result;
  } };
  const seen = [];
  loop.consolidation.dispatch = async request => {
    await save(path.join(dir, `${request.input.action}-${hash(request.dispatchId).slice(0, 12)}-request.json`), request);
    seen.push(request);
    return loop.steps.dispatch(request);
  };
  const outputs = [];
  loop.consolidation.readResult = async identity => {
    const result = await loop.steps.readResult(identity);
    outputs.push({ dispatchId: identity.dispatchId, result });
    return result;
  };
  const before = new Map(documents.map(document => [document.id, document.payload]));
  const result = await loop.consolidation.sleep({ job: { id: `l4-${groupId}`, userId: OFFLINE_USER, projectId: loop.project.id, payload: { action: 'sleep' } } });
  const decisions = outputs.filter(entry => seen.find(request => request.dispatchId === entry.dispatchId)?.input.action === 'decide');
  const assignments = decisions.flatMap(entry => entry.result.output?.assignments ?? []);
  const after = [...loop.documents.rows.values()].filter(row => row.kind === 'method');
  const reverse = new Map(Object.entries(mapping).map(([original, id]) => [id, original]));
  const revisions = outputs.filter(entry => seen.find(request => request.dispatchId === entry.dispatchId)?.input.action === 'build')
    .flatMap(entry => entry.result.output?.revisions ?? []);
  const outcome = { groupId, floor, ids: originals.map(method => method.id), mapping, result, assignments,
    predictions: claimsOf(assignments, mapping), outputs,
    effects: { created: after.filter(document => !before.has(document.id)).map(document => ({ id: document.id, name: document.payload.frontmatter.name,
      role: document.payload.frontmatter.metadata.role, provenance: document.payload.provenance })),
    retired: after.filter(document => before.has(document.id) && document.payload.status === 'retired').map(document => reverse.get(document.id)),
    deleted: [...before.keys()].filter(id => !after.some(document => document.id === id && !document.deletedAt)).map(id => reverse.get(id)),
    amended: after.filter(document => before.has(document.id) && document.payload.contentDigest !== before.get(document.id).contentDigest).map(document => reverse.get(document.id)),
    pendingMerges: after.filter(document => document.payload.provenance?.pendingRetirements?.length).map(document => document.id),
    proposedRetirements: revisions.filter(revision => revision.operation === 'retire').map(revision => ({ id: reverse.get(revision.methodId) ?? revision.methodId, supersededBy: revision.supersededBy })) },
    usage: tokensOf((await usageLog(path.join(dir, 'calls.jsonl'))).reduce((sum, row) => ({ promptTokens: sum.promptTokens + (row.promptTokens ?? 0),
      completionTokens: sum.completionTokens + (row.completionTokens ?? 0), cachedTokens: sum.cachedTokens + (row.cachedTokens ?? 0) }), { promptTokens: 0, completionTokens: 0, cachedTokens: 0 })) };
  await save(loop.statePath, { ...loop.state, documents: loop.documents.snapshot() });
  await save(path.join(dir, 'result.json'), outcome);
  await note(dir, { phase: 'complete', groupId, tokens: outcome.usage });
  return outcome;
}

export async function pool(values, concurrency, work) {
  let at = 0;
  const results = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) { const index = at++; if (index >= values.length) return; results[index] = await work(values[index], index); }
  }));
  return results;
}

export function mergeHarms(gold, groups) {
  const known = new Map(gold.map(pair => [pairKey(pair.a, pair.b), pair.relation]));
  const wrong = groups.flatMap(group => group.predictions.filter(claim => claim.type === 'merge' && known.get(pairKey(claim.a, claim.b)) !== 'duplicate')
    .map(claim => ({ ...claim, groupId: group.groupId, gold: known.get(pairKey(claim.a, claim.b)) ?? 'unlabelled',
      destroyedIds: [claim.a, claim.b].filter(id => group.effects.deleted.includes(id) || group.effects.retired.includes(id)),
      canonicalCreated: group.effects.created.filter(method => method.provenance?.pendingRetirements?.length).map(method => method.id) })));
  return { proposed: wrong, harmfulMerges: wrong.filter(claim => claim.gold !== 'unlabelled' && claim.destroyedIds.length),
    suspectedUnlabelled: wrong.filter(claim => claim.gold === 'unlabelled'),
    note: 'Harmful merge = planted distinct pair merged and an original retired/deleted. Wrong proposals and unlabelled merges are separate; originals may stay active pending harm clearance.' };
}

/** Rebuild scored artifacts from paid group receipts; never dispatches a model. */
export async function refreshArtifacts(options, summary) {
  const dir = path.join(options.root, summary.runId);
  const gold = (await json(path.join(options.data, `gold-${summary.size}.json`))).pairs;
  const screenPairs = (await readFile(path.join(dir, 'pairs.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(pair => pair.stage === 'screen');
  const rows = [...screenPairs];
  for (const [floor, arm] of Object.entries(summary.decide)) {
    const count = groupPairs(screenPairs.filter(pair => pair.score >= Number(floor)), { maxGroups: 10000 }).length;
    const groups = [];
    for (let i = 0; i < count; i++) groups.push(await json(path.join(dir, `decide-${floor}`, `group-${String(i).padStart(3, '0')}`, 'result.json')));
    for (const group of groups) group.predictions = claimsOf(group.assignments, group.mapping);
    const assignmentsByGroup = new Map(groups.map(group => [group.groupId, new Map(group.assignments.map(assignment => [assignment.ASSIGNMENT, assignment]))]));
    for (const group of groups) {
      const builds = group.outputs.flatMap(output => output.result.output?.revisions ?? []);
      for (const created of group.effects.created) {
        const revision = builds.find(revision => revision.operation === 'create' && revision.name === created.name);
        created.relationType = assignmentsByGroup.get(group.groupId).get(revision?.assignment)?.RELATION_TYPE ?? null;
      }
    }
    Object.assign(arm, scoreDecisions(gold, groups.flatMap(group => group.predictions)), mergeHarms(gold, groups));
    arm.relationCounts = Object.fromEntries(['merge', 'subset', 'conflicts_with', 'shared_part', 'abstract_pattern', 'supersedes'].map(type =>
      [type, arm.predictions.filter(claim => claim.type === type).length]));
    for (const kind of ['duplicate', 'subset', 'conflict']) {
      const labelled = arm.predictions.filter(claim => claim.type === TYPES[kind] && gold.some(pair => pairKey(pair.a, pair.b) === pairKey(claim.a, claim.b))).length;
      arm.byKind[kind].labelledPredicted = labelled;
      arm.byKind[kind].precisionLabelledOnly = labelled ? arm.byKind[kind].tp / labelled : null;
    }
    arm.effects.created = groups.flatMap(group => group.effects.created);
    arm.buildFailures = groups.filter(group => group.result.noop?.includes('build_failed') || group.outputs.some(output =>
      output.dispatchId.startsWith('method-relations-build-') && output.result.status === 'failed')).map(group => group.groupId);
    arm.decideFailures = groups.filter(group => group.result.decideFailed).map(group => group.groupId);
    arm.refusals = groups.flatMap(group => group.result.refusals);
    // An accepted transport package may still be ignored by the writer (for example create aimed at an existing id).
    arm.createIdentityCollisions = groups.flatMap(group => group.outputs.flatMap(output => output.result.output?.revisions ?? [])
      .filter(revision => revision.operation === 'create' && Object.values(group.mapping).includes(revision.methodId))
      .map(revision => ({ groupId: group.groupId, assignment: revision.assignment, methodId: revision.methodId, name: revision.name })));
    arm.goldPairsRead = Object.fromEntries(KINDS.map(kind => [kind, gold.filter(pair => pair.relation === kind
      && groups.some(group => group.ids.includes(pair.a) && group.ids.includes(pair.b) && !group.result.decideFailed)).length]));
    arm.distinctRetirements = [];
    for (const [i, group] of groups.entries()) {
      if (!group.effects.retired.length) continue;
      const state = await json(path.join(dir, `decide-${floor}`, `group-${String(i).padStart(3, '0')}`, 'library.json'));
      const reverse = new Map(Object.entries(group.mapping).map(([original, id]) => [id, original]));
      for (const original of group.effects.retired) {
        const row = state.documents.rows.find(row => row.id === group.mapping[original]);
        for (const relation of row?.payload?.learning?.relations ?? []) {
          const target = reverse.get(relation.target);
          const labelled = gold.find(pair => pairKey(pair.a, pair.b) === pairKey(original, target));
          if (relation.type === 'supersedes' && labelled && labelled.relation !== 'duplicate') arm.distinctRetirements.push({ id: original, target,
            relation: 'supersedes', gold: labelled.relation, groupId: group.groupId });
        }
      }
    }
    for (const claim of arm.predictions) rows.push({ stage: 'decide', floor: Number(floor), ...claim,
      gold: gold.find(pair => pairKey(pair.a, pair.b) === pairKey(claim.a, claim.b))?.relation ?? 'unlabelled' });
  }
  const target = path.join(dir, 'pairs.jsonl');
  await writeFile(`${target}.tmp`, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await rename(`${target}.tmp`, target);
  summary.prices = { peakCnyPerMillion: options.prices, source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', verifiedAt: '2026-11-10',
    note: 'All experiment calls on 2026-11-10 after 13:00 UTC fall in off-peak hours (half these rates). Peak estimates remain conservative upper estimates.',
    embeddingCnyPerThousandUpper: 0.000525, embeddingSource: 'https://help.aliyun.com/zh/model-studio/embedding' };
  summary.embedding.costCnyUpper = (summary.embedding.tokens ?? 0) * 0.000525 / 1000;
  summary.finalizedAt = new Date().toISOString();
  summary.native = {};
  for (const floor of [...new Set([METHOD_SIMILARITY_PAIR_FLOOR, summary.recommendation.floor])]) {
    const result = await optional(path.join(dir, `native-${floor.toFixed(2)}`, 'result.json'));
    if (result) {
      const { outputs, ...compact } = result;
      const after = (await json(path.join(dir, `native-${floor.toFixed(2)}`, 'library.json'))).documents.rows;
      const mapping = await json(path.join(dir, 'mapping.json'));
      const active = new Set(Object.keys(mapping).filter(id => after.some(row => row.id === mapping[id] && row.payload.status === 'approved')));
      compact.plantedDistinctRetiredWithoutActiveGoldDuplicate = compact.effects.retired.filter(row => gold.some(pair => pair.relation !== 'duplicate'
        && [pair.a, pair.b].includes(row.id)) && !gold.some(pair => pair.relation === 'duplicate' && [pair.a, pair.b].includes(row.id)
          && active.has(pair.a === row.id ? pair.b : pair.a))).map(row => row.id);
      summary.native[floor.toFixed(2)] = compact;
    }
  }
  if (summary.defect1) {
    const calls = await usageLog(path.join(dir, 'defect1', 'calls.jsonl'));
    summary.defect1.totalTokensFromCalls = sumTokens(calls.map(call => tokensOf(call)));
    summary.defect1.costCnyPeakUpper = estimateCostCny({ tokens: summary.defect1.totalTokensFromCalls, prices: options.prices });
  }
  if (summary.decide['0.50'] && summary.decide['0.60']) {
    const sets = {};
    for (const floor of ['0.50', '0.60']) {
      sets[floor] = groupPairs(screenPairs.filter(pair => pair.score >= Number(floor)), { maxGroups: 10000 }).map(ids => JSON.stringify([...ids].sort()));
    }
    summary.floorComparison = { sameMemberGroups: sets['0.50'].filter(group => sets['0.60'].includes(group)).length,
      baselineGroups: sets['0.50'].length, recommendedGroups: sets['0.60'].length,
      caveat: 'Single stochastic model pass per arm. Many groups have identical members; do not attribute model-answer differences on those groups to the floor.' };
  }
  await save(path.join(dir, 'summary.json'), summary);
}

/** Small, English-keyed result artifact suitable for committing; raw prompts/receipts remain on the lab. */
export function compactReport(summaries) {
  const metrics = byKind => Object.fromEntries(Object.entries(byKind).map(([kind, row]) => [kind,
    Object.fromEntries(['n', 'tp', 'predicted', 'precision', 'recall', 'f1', 'precisionCi95', 'recallCi95', 'precisionLabelledOnly', 'keptApart']
      .filter(key => row[key] !== undefined).map(key => [key, row[key]]))]));
  const report = { schema: 'capsule-proving-l4-report/1', generatedAt: new Date().toISOString(),
    model: summaries[0].model, thinking: summaries[0].thinking, recommendation: summaries[0].recommendation,
    prices: summaries[0].prices, libraries: {}, totals: { tokens: zeroTokens(), modelCostCnyPeakUpper: 0, embeddingCostCnyUpper: 0 },
    limitations: [
      'Public single-seed calibration, 8/16 planted base families; libraries share planted pairs. Wilson intervals are descriptive, not independent held-out validation.',
      'Non-planted pairs are unlabelled, provisionally none: reported weak-label precision can count valid extra relations as false positives. Labelled-only precision is also included.',
      'Exhaustive diagnostic runs every full-library product group in an independent store. Native passes preserve all production scheduling and active-library limits.',
      'Single stochastic pass per floor. Many groups have the same members; answer differences on those groups are model variation, not evidence of a floor effect.',
      'Top-K and greedy grouping omit positive pairs even at 0.30. The active cap is 50, sleep reads newest 100 documents (retired included), then reads at most six new groups.',
      'Seven-section import wrapper, opaque method names, source title as description. Generic sensitive nouns substituted only in disclosed public filler methods; planted procedures unchanged.',
      'No learned SCREEN-judge variant, replay/harm-clearance episodes or independent gold for shared_part/abstract_pattern/supersedes. No product floor or other production code changed.',
    ] };
  const addCost = (tokens, cost) => { report.totals.tokens = sumTokens([report.totals.tokens, tokens]); report.totals.modelCostCnyPeakUpper += cost ?? 0; };
  for (const summary of summaries) {
    const entry = { rawPath: `/srv/evimed/runs/${summary.runId}`, baseCommit: summary.commit, inputDigests: summary.inputDigests,
      embedding: summary.embedding, admissionAdaptations: summary.admissionAdaptations ?? [], productBounds: summary.productBounds,
      screen: summary.screen, goldDiagnostics: summary.goldDiagnostics, floorComparison: summary.floorComparison,
      preRunEstimates: summary.preRunEstimates, scaleDecision: summary.scaleDecision, decide: {}, native: {}, defect1: summary.defect1 };
    report.totals.embeddingCostCnyUpper += summary.embedding.costCnyUpper ?? 0;
    for (const [floor, arm] of Object.entries(summary.decide)) {
      entry.decide[floor] = { groups: arm.groups, metrics: metrics(arm.byKind), goldPairsRead: arm.goldPairsRead,
        relationCounts: arm.relationCounts, tokens: arm.tokens, costCnyPeakUpper: arm.costCnyPeakUpper,
        effects: { created: arm.effects.created.map(row => ({ id: row.id, role: row.role, relationType: row.relationType })),
          retired: arm.effects.retired, amended: arm.effects.amended, deleted: arm.effects.deleted },
        harmfulMerges: arm.harmfulMerges, distinctRetirements: arm.distinctRetirements, wrongMergeProposals: arm.proposed.filter(claim => claim.gold !== 'unlabelled').map(({ reason, ...claim }) => claim),
        suspectedUnlabelledMerges: arm.suspectedUnlabelled.map(({ reason, ...claim }) => claim),
        decideFailures: arm.decideFailures, buildFailures: arm.buildFailures, refusals: arm.refusals, createIdentityCollisions: arm.createIdentityCollisions };
      addCost(arm.tokens, arm.costCnyPeakUpper);
    }
    for (const [floor, arm] of Object.entries(summary.native ?? {})) {
      entry.native[floor] = { metrics: metrics(arm.byKind), activeCap: arm.activeCap, readWindow: arm.readWindow,
        groupsFormed: arm.result.groupsFormed, groupsRead: arm.result.groups, tokens: arm.tokens, costCnyPeakUpper: arm.costCnyPeakUpper,
        effects: { approvedBefore: arm.effects.approvedBefore, approvedAfter: arm.effects.approvedAfter,
          created: arm.effects.created.map(row => ({ id: row.id, role: row.role })), retired: arm.effects.retired.map(row => row.id),
          amended: arm.effects.amended, deleted: arm.effects.deleted, stopped: arm.effects.stopped },
        harmfulRetirements: arm.harmfulRetirements, plantedDistinctRetiredWithoutActiveGoldDuplicate: arm.plantedDistinctRetiredWithoutActiveGoldDuplicate };
      addCost(arm.tokens, arm.costCnyPeakUpper);
    }
    if (summary.defect1?.totalTokensFromCalls) addCost(summary.defect1.totalTokensFromCalls, summary.defect1.costCnyPeakUpper);
    report.libraries[summary.size] = entry;
  }
  report.totals.costCnyPeakUpper = report.totals.modelCostCnyPeakUpper + report.totals.embeddingCostCnyUpper;
  report.totals.costCnyOffPeakEstimate = report.totals.modelCostCnyPeakUpper / 2 + report.totals.embeddingCostCnyUpper;
  report.totals.costNote = 'Token-based estimate, not an invoice; calls after 13:00 UTC on the experiment date are off-peak. Peak upper estimate used for the size-600 decision.';
  return report;
}

/** Reconcile every paid call and reconstruct overlap from its completion time and duration. */
export async function callEvidence(options, summaries) {
  const calls = [];
  for (const summary of summaries) {
    const dir = path.join(options.root, summary.runId);
    for (const [floor, arm] of Object.entries(summary.decide)) for (let i = 0; i < arm.groups; i++) {
      calls.push(...await usageLog(path.join(dir, `decide-${floor}`, `group-${String(i).padStart(3, '0')}`, 'calls.jsonl')));
    }
    for (const floor of Object.keys(summary.native ?? {})) calls.push(...await usageLog(path.join(dir, `native-${floor}`, 'calls.jsonl')));
    if (summary.defect1) calls.push(...await usageLog(path.join(dir, 'defect1', 'calls.jsonl')));
  }
  const paid = calls.filter(call => !call.cached);
  const events = paid.flatMap(call => [[Date.parse(call.at) - call.ms, 1], [Date.parse(call.at), -1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0, peak = 0;
  for (const [, change] of events) { active += change; peak = Math.max(peak, active); }
  return { paidCalls: paid.length, cachedCalls: calls.length - paid.length, maxConcurrentCalls: peak, limit: 4,
    observedModels: [...new Set(paid.map(call => call.model))], tokens: sumTokens(paid.map(call => tokensOf(call))),
    rejectedPackages: paid.filter(call => !call.ok).length,
    missingUsageCounters: paid.filter(call => !(call.promptTokens > 0) || !(call.completionTokens > 0)).length,
    startedAt: events.length ? new Date(events[0][0]).toISOString() : null,
    finishedAt: events.length ? new Date(events.at(-1)[0]).toISOString() : null };
}

/** Pairwise gold cosines separate threshold misses from the product's top-K limit; no gold changes retrieval. */
export async function enrichScreen(options, summary, embedder, model) {
  const dir = path.join(options.root, summary.runId);
  const loop = await OfflineLoop.open({ dir: path.join(dir, 'seed'), env: `l4-${summary.size}`, model, embed: embedder.embed, embedModel: embedder.model });
  const mapping = await json(path.join(dir, 'mapping.json'));
  const methods = [...loop.documents.rows.values()].filter(row => row.kind === 'method');
  const byId = new Map(methods.map(method => [method.id, method]));
  await warm(loop.similarity, methods);
  const pairs = (await readFile(path.join(dir, 'pairs.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(pair => pair.stage === 'screen');
  const keys = new Set(pairs.map(pair => pairKey(pair.a, pair.b)));
  const gold = (await json(path.join(options.data, `gold-${summary.size}.json`))).pairs;
  summary.goldDiagnostics = [];
  for (const pair of gold) {
    const answer = await loop.similarity.pairs([byId.get(mapping[pair.a]), byId.get(mapping[pair.b])], { floor: -1, topK: 1 });
    if (answer.mode !== 'embedding') throw new Error('Gold cosine diagnostic requires embeddings');
    summary.goldDiagnostics.push({ ...pair, score: answer[0].score, shortlistedAt030: keys.has(pairKey(pair.a, pair.b)),
      reasonAt030: keys.has(pairKey(pair.a, pair.b)) ? 'retrieved' : answer[0].score < 0.3 ? 'below-floor' : 'top-k-limit' });
  }
  const reverse = new Map(Object.entries(mapping).map(([original, id]) => [id, original]));
  const native = (await loop.learning.listMethods(OFFLINE_USER, { limit: 100 })).items;
  const nativeSet = new Set(native.map(method => reverse.get(method.id)));
  const nativePairs = await loop.similarity.pairs(native, { floor: 0.5 });
  const nativeKeys = new Set(nativePairs.map(pair => pairKey(reverse.get(pair.a), reverse.get(pair.b))));
  Object.assign(summary.productBounds, {
    nativePositivePairsInWindow: gold.filter(pair => pair.relation !== 'unrelated' && nativeSet.has(pair.a) && nativeSet.has(pair.b)).length,
    nativePositivePairHitsAt050: gold.filter(pair => pair.relation !== 'unrelated' && nativeKeys.has(pairKey(pair.a, pair.b))).length,
    nativeFirstPassPositivePairsGroupedAt050: gold.filter(pair => pair.relation !== 'unrelated'
      && groupPairs(nativePairs).some(group => group.includes(mapping[pair.a]) && group.includes(mapping[pair.b]))).length });
}

export async function decideLibrary(options, summary, floor, embedder, model) {
  const arm = floor.toFixed(2);
  if (summary.decide[arm]) return summary;
  const dir = path.join(options.root, summary.runId);
  const library = await json(path.join(options.data, `library-${summary.size}.json`));
  const gold = (await json(path.join(options.data, `gold-${summary.size}.json`))).pairs;
  const pairs = (await readFile(path.join(dir, 'pairs.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(pair => pair.stage === 'screen' && pair.score >= floor);
  const groups = groupPairs(pairs, { maxGroups: 10000 });
  const prior = await optional(path.join(options.root, 'l4-50-1', 'summary.json'));
  const sampled = Object.values(prior?.decide ?? {});
  const sampledGroups = sampled.reduce((total, arm) => total + arm.groups, 0);
  const sampledTokens = sumTokens(sampled.map(arm => arm.tokens));
  const forecastTokens = sampledGroups ? Object.fromEntries(Object.entries(sampledTokens).map(([key, value]) => [key, Math.ceil(value * groups.length / sampledGroups)]))
    : { ...zeroTokens(), prompt: groups.length * 60000, completion: groups.length * 30000 };
  summary.preRunEstimates = { ...summary.preRunEstimates, [arm]: { groups: groups.length, tokens: forecastTokens,
    costCnyPeakUpper: estimateCostCny({ tokens: forecastTokens, prices: options.prices }),
    basis: sampledGroups ? `Observed token use over ${sampledGroups} completed size-50 groups, scaled by group count.`
      : 'Pre-pilot allowance per group: 60k input + 30k output tokens covering DECIDE/BUILD and repairs; estimate, not a hard cap.' } };
  await save(path.join(dir, 'summary.json'), summary);
  process.stdout.write(`${JSON.stringify({ size: summary.size, floor, forecast: summary.preRunEstimates[arm] })}\n`);
  await note(dir, { phase: 'decide-start', floor, groups: groups.length, concurrency: options.concurrency });
  const outcomes = await pool(groups, options.concurrency, async (ids, i) => {
    const outcome = await runGroup({ dir: path.join(dir, `decide-${arm}`, `group-${String(i).padStart(3, '0')}`),
      originals: ids.map(id => library.methods.find(method => method.id === id)),
      pairs: pairs.filter(pair => ids.includes(pair.a) && ids.includes(pair.b)), embedder, model, floor, groupId: `${summary.size}-${arm}-${i}` });
    await note(dir, { phase: 'group-complete', floor, group: i, groups: groups.length, tokens: outcome.usage });
    return outcome;
  });
  const usage = sumTokens(outcomes.map(group => group.usage));
  const scored = scoreDecisions(gold, outcomes.flatMap(group => group.predictions));
  summary.decide[arm] = { ...scored, groups: outcomes.length, failedGroups: outcomes.filter(group => group.result.decideFailed).length,
    effects: { created: outcomes.flatMap(group => group.effects.created), retired: outcomes.flatMap(group => group.effects.retired),
      deleted: outcomes.flatMap(group => group.effects.deleted), amended: outcomes.flatMap(group => group.effects.amended),
      proposedRetirements: outcomes.flatMap(group => group.effects.proposedRetirements) },
    ...mergeHarms(gold, outcomes), tokens: usage, costCnyPeakUpper: estimateCostCny({ tokens: usage, prices: options.prices }),
    costNote: 'Conservative peak price estimate, not provider invoice; actual tokens including all repairs. Embedding billed separately.',
    scope: 'Every full-library product group once; product sleep per disjoint group in independent stores. Nightly scheduling caps bypassed; no repeated evolution or replay runs.' };
  await save(path.join(dir, `decide-${arm}`, 'groups.json'), outcomes.map(({ outputs, ...group }) => group));
  await save(path.join(dir, 'summary.json'), summary);
  await note(dir, { phase: 'decide-complete', floor, tokens: usage, costCnyPeakUpper: summary.decide[arm].costCnyPeakUpper });
  return summary;
}

/** A native, unmodified full-library sleep, alongside the exhaustive independent-group diagnostic.
 * The 100-method read window and global active cap are deliberately kept. Run one at a time when
 * the diagnostic has three workers: together these are at most four simultaneous model requests. */
export async function nativePass(options, summary, floor, embedder, model) {
  const arm = floor.toFixed(2);
  const dir = path.join(options.root, summary.runId, `native-${arm}`);
  const completed = await optional(path.join(dir, 'result.json'));
  if (completed) return completed;
  await mkdir(dir, { recursive: true });
  const initial = await json(path.join(options.root, summary.runId, 'seed', 'library.json'));
  // Every restart begins at the same frozen heads, reusing only exact model-step cache answers.
  await save(path.join(dir, 'library.json'), initial);
  const loop = await OfflineLoop.open({ dir, env: initial.env, model, embed: embedder.embed, embedModel: embedder.model });
  const mapping = await json(path.join(options.root, summary.runId, 'mapping.json'));
  const reverse = new Map(Object.entries(mapping).map(([original, id]) => [id, original]));
  const before = structuredClone([...loop.documents.rows.values()].filter(row => row.kind === 'method'));
  const window = (await loop.learning.listMethods(OFFLINE_USER, { limit: 100 })).items;
  await warm(loop.similarity, window);
  const similarity = loop.similarity;
  loop.consolidation.similarity = { ...similarity, pairs: methods => similarity.pairs(methods, { floor }) };
  const outputs = [], requests = [];
  loop.consolidation.dispatch = async request => {
    requests.push(request);
    await save(path.join(dir, `${request.input.action}-${hash(request.dispatchId).slice(0, 12)}-request.json`), request);
    return loop.steps.dispatch(request);
  };
  loop.consolidation.readResult = async identity => {
    const result = await loop.steps.readResult(identity);
    outputs.push({ dispatchId: identity.dispatchId, result });
    return result;
  };
  await note(dir, { phase: 'native-start', floor, fullMethods: before.length, window: window.length });
  const result = await loop.consolidation.sleep({ job: { id: `l4-native-${summary.size}-${arm}`, userId: OFFLINE_USER,
    projectId: loop.project.id, payload: { action: 'sleep' } } });
  const assignments = outputs.filter(output => requests.find(request => request.dispatchId === output.dispatchId)?.input.action === 'decide')
    .flatMap(output => output.result.output?.assignments ?? []);
  const gold = (await json(path.join(options.data, `gold-${summary.size}.json`))).pairs;
  const after = [...loop.documents.rows.values()].filter(row => row.kind === 'method');
  const beforeById = new Map(before.map(row => [row.id, row.payload.contentDigest]));
  const calls = await usageLog(path.join(dir, 'calls.jsonl'));
  const tokens = sumTokens(calls.map(call => tokensOf(call)));
  const outcome = { mode: 'native-full-library-single-sleep', floor, size: summary.size, activeCap: MAX_ACTIVE_LEARNED_METHODS,
    readWindow: window.length, result, assignments, outputs, ...scoreDecisions(gold, claimsOf(assignments, mapping)),
    effects: { approvedBefore: before.filter(row => row.payload.status === 'approved').length,
      approvedAfter: after.filter(row => row.payload.status === 'approved').length,
      created: after.filter(row => !beforeById.has(row.id)).map(row => ({ id: row.id, role: row.payload.frontmatter.metadata.role, provenance: row.payload.provenance })),
      retired: after.filter(row => beforeById.has(row.id) && row.payload.status === 'retired').map(row => ({ id: reverse.get(row.id),
        reason: row.payload.statusReason, supersedes: (row.payload.learning.relations ?? []).filter(relation => relation.type === 'supersedes')
          .map(relation => ({ ...relation, targetOriginal: reverse.get(relation.target) ?? null })) })),
      stopped: (result.stopped ?? []).map(entry => ({ ...entry, originalId: reverse.get(entry.id) ?? null })),
      deleted: before.filter(row => !after.some(next => next.id === row.id && !next.deletedAt)).map(row => reverse.get(row.id)),
      amended: after.filter(row => beforeById.has(row.id) && beforeById.get(row.id) !== row.payload.contentDigest).map(row => reverse.get(row.id)) },
    tokens, costCnyPeakUpper: estimateCostCny({ tokens, prices: options.prices }),
    scope: 'One product sleep over the complete imported store, no widened limits, no replacement grouping, no forced retirement clearance. Queued later jobs are not run.' };
  outcome.harmfulRetirements = outcome.effects.retired.flatMap(row => row.supersedes.filter(relation => relation.targetOriginal
    && gold.some(pair => pair.relation !== 'duplicate' && pairKey(pair.a, pair.b) === pairKey(row.id, relation.targetOriginal)))
    .map(relation => ({ id: row.id, target: relation.targetOriginal, type: 'supersedes' })));
  await save(loop.statePath, { ...loop.state, documents: loop.documents.snapshot() });
  await save(path.join(dir, 'result.json'), outcome);
  await note(dir, { phase: 'native-complete', floor, tokens, approvedAfter: outcome.effects.approvedAfter,
    retired: outcome.effects.retired.length, stopped: outcome.effects.stopped });
  return outcome;
}

/** Live defect 1 re-test on a pair DECIDE called merge. Record group digests and stamps on both sides. */
export async function defectRetest(options, summary, embedder, model) {
  if (summary.defect1) return;
  const dir = path.join(options.root, summary.runId, 'defect1');
  const merge = Object.values(summary.decide).flatMap(arm => arm.predictions).find(claim => claim.type === 'merge');
  if (!merge) { summary.defect1 = { answer: 'not-tested', reason: 'No live merge decision to exercise the filtered-merge branch.' }; return; }
  const library = await json(path.join(options.data, `library-${summary.size}.json`));
  const originals = library.methods.filter(method => [merge.a, merge.b].includes(method.id));
  await parkIncompleteState(dir);
  const loop = await OfflineLoop.open({ dir, env: `l4-defect1-${summary.size}`, model, embed: embedder.embed, embedModel: embedder.model });
  const mapping = await seed(loop, originals);
  const methods = [...loop.documents.rows.values()].filter(row => row.kind === 'method');
  await warm(loop.similarity, methods);
  const groupBefore = groupKey(methods);
  const job = { id: `l4-defect1-${summary.size}`, userId: OFFLINE_USER, projectId: loop.project.id, payload: { methodId: mapping[merge.a] } };
  const integrated = await loop.consolidation.integrate({ job });
  // The documents double mutates existing row objects on later puts. Freeze the evidence before sleep.
  const middle = structuredClone([...loop.documents.rows.values()].filter(row => row.kind === 'method'));
  const slept = await loop.consolidation.sleep({ job: { ...job, id: `${job.id}-sleep`, payload: { action: 'sleep' } } });
  summary.defect1 = { answer: integrated.deferredBuilds > 0 && integrated.relationTypes?.merge > 0 && slept.groups > 0 && slept.skippedUnchanged === 0 ? 'yes' : 'not-exercised-or-failed',
    meaning: 'Does sleep see a merge left deferred by integrate?', pair: [merge.a, merge.b], groupBefore, groupAfterIntegrate: groupKey(middle),
    sameGroup: groupBefore === groupKey(middle), integrated, slept, evidenceCapture: 'cloned-before-sleep',
    stampsAfterIntegrate: middle.map(method => ({ id: method.id, decided: method.payload.learning.decided ?? null })),
    tokens: tokensOf(loop.steps.usage) };
  await save(loop.statePath, { ...loop.state, documents: loop.documents.snapshot() });
  await save(path.join(dir, 'result.json'), summary.defect1);
  await save(path.join(options.root, summary.runId, 'summary.json'), summary);
}

export function ledgerRows(summary, options) {
  const base = { at: new Date().toISOString(), runId: summary.runId, commit: summary.commit, engine: { version: 'offline-product-learning', templatesDigest: 'not-applicable-no-openviking' },
    set: `l4-${summary.size}`, split: 'public', scorer: 'l4/1', rawPath: path.join(options.root, summary.runId), wallSeconds: 0, flags: { model: summary.model, thinking: summary.thinking },
    judged: { code: 0, judge: 0, unknown: 0, error: 0 } };
  const rows = summary.screen.map(row => ({ ...base, arm: `screen@${row.floor.toFixed(2)}`, metric: 'recall', n: row.n, value: row.recall, ci95: row.ci95,
    tokens: zeroTokens(), costCny: row.floor === FLOORS[0] ? summary.embedding?.costCnyUpper ?? null : 0,
    judged: { ...base.judged, code: row.n }, byKind: row.byKind, candidatePairs: row.candidates,
    flags: { ...base.flags, execution: 'embedding-shortlist', embeddingTokens: row.floor === FLOORS[0] ? summary.embedding?.tokens ?? 0 : 0 } }));
  for (const [floor, arm] of Object.entries(summary.decide)) for (const metric of ['precision', 'recall']) {
    const kinds = ['duplicate', 'subset', 'conflict'];
    const n = kinds.reduce((sum, kind) => sum + arm.byKind[kind][metric === 'precision' ? 'predicted' : 'n'], 0);
    const tp = kinds.reduce((sum, kind) => sum + arm.byKind[kind].tp, 0);
    rows.push({ ...base, arm: `decide@${floor}`, metric, n, value: n ? tp / n : 0, ci95: n ? wilson95(tp, n) : null,
      label: 'exhaustive-disjoint-groups', flags: { ...base.flags, execution: 'exhaustive-disjoint-groups' },
      tokens: metric === 'precision' ? arm.tokens : zeroTokens(), costCny: metric === 'precision' ? arm.costCnyPeakUpper : 0,
      judged: { ...base.judged, code: n }, byKind: arm.byKind,
      notes: `${arm.precisionCaveat} Cost/tokens attributed once on precision row; zero on recall row.` });
  }
  for (const [floor, arm] of Object.entries(summary.native ?? {})) for (const metric of ['precision', 'recall']) {
    const kinds = ['duplicate', 'subset', 'conflict'];
    const n = kinds.reduce((sum, kind) => sum + arm.byKind[kind][metric === 'precision' ? 'predicted' : 'n'], 0);
    const tp = kinds.reduce((sum, kind) => sum + arm.byKind[kind].tp, 0);
    rows.push({ ...base, arm: `decide@${floor}`, label: 'native-full-library', flags: { ...base.flags, execution: 'native-full-library' },
      metric, n, value: n ? tp / n : 0, ci95: n ? wilson95(tp, n) : null, judged: { ...base.judged, code: n },
      tokens: metric === 'precision' ? arm.tokens : zeroTokens(), costCny: metric === 'precision' ? arm.costCnyPeakUpper : 0,
      byKind: arm.byKind, notes: `${arm.scope} Peak cost attributed once on precision row. ${arm.precisionCaveat}` });
  }
  return rows;
}

export function parseArgs(argv) {
  const options = { phase: 'all', sizes: [50, 200, 600], root: '/srv/evimed/runs', data: '/srv/evimed/data/memdata-data/l4',
    embedKey: '/srv/evimed/secrets/dashscope.api-key', keyFile: '/srv/evimed/secrets/deepseek.api-key', concurrency: 3, thinking: 'disabled',
    prices: { inputPerMTok: 2, cachedInputPerMTok: 0.04, outputPerMTok: 8 } };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[++i];
    if (flag === '--phase') options.phase = value;
    else if (flag === '--sizes') options.sizes = value.split(',').map(Number);
    else if (flag === '--root' || flag === '--data' || flag === '--thinking') options[flag.slice(2)] = value;
    else if (flag === '--concurrency') options.concurrency = Number(value);
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!['screen', 'decide', 'all', 'report', 'native'].includes(options.phase) || !['enabled', 'disabled'].includes(options.thinking)
    || !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4 || options.sizes.some(size => ![50, 200, 600].includes(size))) throw new Error('Invalid L4 options');
  options.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const embedder = await diskEmbedder(options);
  const model = createDeepSeekClient({ keyFile: options.keyFile, model: 'deepseek-flash', thinking: options.thinking, timeoutMs: 600000 });
  const summaries = [];
  for (const size of options.sizes) summaries.push(await screenLibrary(options, size, embedder, model));
  const recommendation = recommend(summaries);
  if (options.phase !== 'native') await save(path.join(options.root, 'l4-recommendation.json'), recommendation);
  for (const summary of summaries) {
    summary.recommendation = recommendation;
    const dir = path.join(options.root, summary.runId);
    if (options.phase !== 'native') await save(path.join(dir, 'summary.json'), summary);
    if (['decide', 'all'].includes(options.phase)) {
      if (summary.size === 600) {
        const prior = await optional(path.join(options.root, 'l4-200-1', 'summary.json'));
        const costs = Object.values(prior?.decide ?? {}).map(arm => arm.costCnyPeakUpper);
        const cost200 = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
        summary.scaleDecision = { cost200, thresholdCny: 40, chosen: cost200 !== null && cost200 < 40 ? 'run-600' : 'skip-600',
          basis: 'Actual 200-arm token totals at conservative peak rates; excludes separately reported embeddings and defect re-test.' };
        await save(path.join(dir, 'summary.json'), summary);
        process.stdout.write(`${JSON.stringify({ size: 600, scaleDecision: summary.scaleDecision })}\n`);
        if (summary.scaleDecision.chosen === 'skip-600') { await note(dir, summary.scaleDecision); continue; }
      }
      for (const floor of [...new Set([METHOD_SIMILARITY_PAIR_FLOOR, recommendation.floor])]) await decideLibrary(options, summary, floor, embedder, model);
      await defectRetest(options, summary, embedder, model);
      if (options.phase === 'all') {
        for (const floor of [...new Set([METHOD_SIMILARITY_PAIR_FLOOR, recommendation.floor])]) await nativePass(options, summary, floor, embedder, model);
        await enrichScreen(options, summary, embedder, model);
        await refreshArtifacts(options, summary);
      }
    }
    if (options.phase === 'report') { await enrichScreen(options, summary, embedder, model); await refreshArtifacts(options, summary); }
    if (options.phase === 'native') {
      if (summary.size === 600) {
        const prior = await json(path.join(options.root, 'l4-200-1', 'summary.json'));
        const arms = Object.values(prior.decide ?? {});
        if (arms.length < 2 || arms.reduce((sum, arm) => sum + arm.costCnyPeakUpper, 0) >= 40) throw new Error('Size-600 native pass waits for both size-200 arms under CNY 40');
      }
      for (const floor of [...new Set([METHOD_SIMILARITY_PAIR_FLOOR, recommendation.floor])]) {
        const result = await nativePass(options, summary, floor, embedder, model);
        process.stdout.write(`${JSON.stringify({ size: summary.size, nativeFloor: floor, approvedAfter: result.effects.approvedAfter, costCnyPeakUpper: result.costCnyPeakUpper })}\n`);
      }
      // Native passes run concurrently with the exhaustive diagnostic: never overwrite its changing summary.
      continue;
    }
    await save(path.join(dir, 'ledger-rows.json'), ledgerRows(summary, options));
    await note(dir, { phase: options.phase === 'screen' ? 'screen-complete' : 'complete' });
    process.stdout.write(`${JSON.stringify({ size: summary.size, recommended: recommendation.floor, decide: Object.keys(summary.decide) })}\n`);
  }
  if (['report', 'all'].includes(options.phase)) {
    const report = compactReport(summaries);
    report.callEvidence = await callEvidence(options, summaries);
    report.callEvidence.tokensReconcile = JSON.stringify(report.callEvidence.tokens) === JSON.stringify(report.totals.tokens);
    if (!report.callEvidence.tokensReconcile || report.callEvidence.maxConcurrentCalls > 4) throw new Error('L4 call accounting/concurrency check failed');
    const files = ['./run_l4.mjs', '../learn/offlineLoop.mjs', '../learn/modelSteps.mjs', '../learn/documents.mjs',
      '../../../apps/server/src/methodConsolidation.mjs', '../../../apps/server/src/methodSimilarity.mjs', '../../../apps/server/src/learningService.mjs',
      '../../../packages/domain/src/methodGraph.mjs', '../../../packages/domain/src/constants.mjs', '../../../capabilities/method-relations/SKILL.md'];
    report.sourceDigests = {};
    for (const relative of files) {
      report.sourceDigests[relative] = hash(await readFile(new URL(relative, import.meta.url)));
    }
    await save(path.join(options.root, 'l4-report.json'), report);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${firstLine(error)}\n`); process.exitCode = 1; });
