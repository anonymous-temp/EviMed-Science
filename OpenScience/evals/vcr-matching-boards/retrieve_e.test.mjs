// Board E's retrieval runner: the topics, the search the model is asked to write (held equal to the skill and the tool description),
// the product's own list over a tiny local collection built by ingest_e.py, the rerank, the guards and the second run that pays nothing.
// The model and the reranker are local servers; no network, no key, no label.
//
//   node --test retrieve_e.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCollections, tmp } from './retrieve_e_fixture.mjs';
import { ENGLISH_REGISTRY_SENTENCE, EXIT, SKILL_SEARCH_SENTENCE, TOOL_SUMMARY_SENTENCE, TOOL_TERMS_SENTENCE, chatOnce, parseOptions, parseTopics, questionnaireNote, requestFromAnswer, runRetrieval, searchMessages, selectedTopics, topicId } from './retrieve_e.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../../apps/server/src');
const cleanups = /** @type {Array<() => void>} */ ([]);
after(() => { for (const fn of cleanups) fn(); });

const XML_2021 = `<topics task="2021 TREC Clinical Trials">
<topic number="1">
A 58-year-old woman with stage IV lung adenocarcinoma, EGFR L858R positive, progressed on osimertinib. Smoker &amp; hypertensive.
</topic>
<topic number="2">
A 7 year old boy with migraine and aura.
</topic>
</topics>`;
const XML_2023 = `<topics task="2023 TREC Clinical Trials">
  <topic number="1" template="glaucoma">
    <field name="definitive diagnosis">primary open angle glaucoma</field>
    <field name="intraocular pressure"></field>
    <field name="age">61</field>
  </topic>
</topics>`;

describe('the topics', () => {
  test('free-text topics keep their text and decode entities; ids follow the split files', () => {
    const topics = parseTopics(XML_2021, 2021);
    assert.deepEqual(topics.map((topic) => [topic.id, topic.number]), [['trec-20211', 1], ['trec-20212', 2]]);
    assert.match(topics[0].note, /^A 58-year-old woman.*Smoker & hypertensive\.$/su);
    assert.equal(topicId(2022, 10), 'trec-202210');
    assert.equal(topicId(2023, 7), 'trec-2023-7');
  });
  test('a questionnaire topic becomes plain lines and leaves out the fields nobody filled', () => {
    const [topic] = parseTopics(XML_2023, 2023);
    assert.equal(topic.id, 'trec-2023-1');
    assert.equal(topic.note, 'Condition questionnaire: glaucoma\ndefinitive diagnosis: primary open angle glaucoma\nage: 61');
    assert.equal(questionnaireNote('', [['a', ' ']]), 'Condition questionnaire');
  });
  test('an empty or numberless topic is refused, not skipped', () => {
    assert.throws(() => parseTopics('<topics><topic number="1">  </topic></topics>', 2021), { code: 'topic_invalid' });
    assert.throws(() => parseTopics('<topics><topic>x</topic></topics>', 2021), { code: 'topic_invalid' });
    assert.throws(() => parseTopics('<topics/>', 2021), { code: 'topic_invalid' });
  });
  test('split_e.json keeps the dev topics of split.json and adds the first ten of 2023', () => {
    const old = JSON.parse(fs.readFileSync(path.join(HERE, 'split.json'), 'utf8'));
    const split = JSON.parse(fs.readFileSync(path.join(HERE, 'split_e.json'), 'utf8'));
    assert.deepEqual(split.dev.trec_2021, old.dev.trec_2021);
    assert.deepEqual(split.dev.trec_2022, old.dev.trec_2022);
    assert.deepEqual(split.dev.trec_2023, Array.from({ length: 10 }, (_, at) => `trec-2023-${at + 1}`));
    assert.deepEqual(split.test.trec_2023, Array.from({ length: 30 }, (_, at) => `trec-2023-${at + 11}`));
    assert.deepEqual(split.unscorable.trec_2023, ['trec-2023-2', 'trec-2023-11', 'trec-2023-40'], 'the three 2023 topics the official qrels do not judge');
    const all = Object.values(split.dev).flat().concat(Object.values(split.test).flat());
    assert.equal(new Set(all).size, all.length, 'no topic is in both sets');
  });
});

describe('the search the model is asked to write', () => {
  const squash = (/** @type {string} */ text) => text.replace(/\s+/gu, ' ');
  test('the sentence is the skill\'s, word for word', () => {
    const skill = fs.readFileSync(path.resolve(HERE, '../../capability-skills/vcr-matching/SKILL.md'), 'utf8');
    assert.ok(squash(skill).includes(squash(SKILL_SEARCH_SENTENCE)), 'SKILL.md says exactly this about the search');
  });
  test('the sentences about terms and summary are the tool description\'s, word for word', () => {
    const python = fs.readFileSync(path.resolve(HERE, '../../runtime/mcp/evimed-research/vcr_platform.py'), 'utf8');
    // The description is built from adjacent string literals; join them as Python does.
    const joined = squash(python.replace(/"\s*\n\s*"/gu, ''));
    assert.ok(joined.includes(squash(TOOL_TERMS_SENTENCE)), 'the terms sentence is in the tool description');
    assert.ok(joined.includes(squash(TOOL_SUMMARY_SENTENCE)), 'the summary sentence is in the tool description');
  });
  test('the messages carry both sentences and the record, and ask for JSON', () => {
    const [system, user] = searchMessages('A person with asthma.');
    assert.equal(system.role, 'system');
    assert.ok(system.content.includes(SKILL_SEARCH_SENTENCE) && system.content.includes(TOOL_SUMMARY_SENTENCE) && system.content.includes(TOOL_TERMS_SENTENCE));
    assert.match(system.content, /one JSON object/u);
    assert.equal(user.content, 'Patient record:\n\nA person with asthma.');
  });
  test('the english variant adds one sentence and nothing else', () => {
    const [plain] = searchMessages('A person with asthma.');
    const [english] = searchMessages('A person with asthma.', 'english');
    assert.equal(english.content, `${plain.content}\n${ENGLISH_REGISTRY_SENTENCE}`);
    assert.equal(searchMessages('x', 'skill')[0].content, plain.content);
    assert.throws(() => parseOptions(['--split', 's', '--topics', 't', '--collections', 'c', '--out', 'o', '--key-file', 'k', '--exp', 'r1', '--prompt', 'chinese'], {}), { code: 'option_invalid' });
  });
  test('the answer becomes the product\'s own request; arguments past the tool\'s limits are cut and counted', () => {
    const terms = Array.from({ length: 40 }, (_, at) => `phrase ${at}`);
    const { request, adjusted } = requestFromAnswer({ condition: ' lung  cancer ', terms: [...terms, 'x'.repeat(300)], summary: 'stage IV', age: '58', sex: 'FEMALE', region: null });
    assert.equal(request.condition, 'lung cancer');
    assert.equal(request.terms.length, 32);
    assert.deepEqual([request.age, request.sex, request.scope, request.limit, request.region], [58, 'female', 'any', 500, null]);
    assert.deepEqual(adjusted.sort(), ['terms_cut_to_32', 'terms_too_long_dropped']);
    assert.equal(requestFromAnswer({ condition: 'asthma', age: 200, sex: 'unknown' }).request.age, null);
    assert.throws(() => requestFromAnswer({ terms: ['x'] }), { code: 'search_invalid' });
  });
});

/** A model that writes the search for whatever condition the record names, counting calls; `mode` switches its failure. */
async function fakeServers() {
  const state = { chat: 0, rerank: 0, mode: 'ok', bodies: /** @type {any[]} */ ([]), rerankBodies: /** @type {any[]} */ ([]) };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (request.url === '/chat/completions') {
        state.chat += 1;
        state.bodies.push(parsed);
        const record = String(parsed.messages?.[1]?.content ?? '');
        const price = state.mode === 'expensive' ? { prompt_tokens: 2_000_000, prompt_cache_miss_tokens: 2_000_000, prompt_cache_hit_tokens: 0, completion_tokens: 150 } : { prompt_tokens: 1200, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1200, completion_tokens: 150 };
        if (state.mode === 'broken') { response.end(JSON.stringify({ choices: [{ message: { content: 'not json' } }], usage: { prompt_tokens: 100, completion_tokens: 5 } })); return; }
        const lung = /lung/iu.test(record), glaucoma = /glaucoma/iu.test(record);
        const answer = lung ? { condition: 'lung cancer', terms: ['EGFR lung adenocarcinoma', 'osimertinib'], summary: 'Stage IV EGFR lung adenocarcinoma after osimertinib.', age: 58, sex: 'female', region: null }
          : glaucoma ? { condition: 'glaucoma', terms: ['primary open angle glaucoma'], summary: 'Primary open angle glaucoma.', age: 61, sex: null, region: null }
            : { condition: 'migraine', terms: ['migraine aura'], summary: 'A child with migraine.', age: 7, sex: 'male', region: null };
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: price }));
      } else if (request.url === '/reranks') {
        state.rerank += 1;
        state.rerankBodies.push(parsed);
        // The reranker likes "osimertinib" most and a plain "lung cancer" trial least.
        const results = parsed.documents.map((/** @type {string} */ document, /** @type {number} */ index) => ({ index, relevance_score: /osimertinib/iu.test(document) ? 0.9 : /EGFR/u.test(document) ? 0.6 : 0.1 }));
        response.end(JSON.stringify({ results, usage: { total_tokens: 4000 }, request_id: `r-${state.rerank}` }));
      } else { response.statusCode = 404; response.end('{}'); }
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  cleanups.push(() => server.close());
  return { state, base: `http://127.0.0.1:${port}`, rerankUrl: `http://127.0.0.1:${port}/reranks` };
}

function workspace() {
  const root = tmp('run');
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'topics'));
  fs.writeFileSync(path.join(root, 'topics', 'topics2021.xml'), XML_2021);
  fs.writeFileSync(path.join(root, 'topics', 'topics2023.xml'), XML_2023);
  fs.writeFileSync(path.join(root, 'split.json'), JSON.stringify({ dev: { trec_2021: ['trec-20211', 'trec-20212'], trec_2023: ['trec-2023-1'] } }));
  fs.writeFileSync(path.join(root, 'deepseek.key'), 'sk-test-not-a-key\n');
  fs.writeFileSync(path.join(root, 'dashscope.key'), 'ds-test-not-a-key\n');
  return root;
}

const options = (/** @type {string} */ root, /** @type {string} */ collections, /** @type {Awaited<ReturnType<typeof fakeServers>>} */ servers, /** @type {string[]} */ extra = []) => parseOptions([
  '--split', path.join(root, 'split.json'), '--topics', path.join(root, 'topics'), '--collections', collections, '--out', path.join(root, 'out'), '--exp', 'r1',
  '--key-file', path.join(root, 'deepseek.key'), '--dashscope-key-file', path.join(root, 'dashscope.key'), '--base-url', servers.base, '--rerank-url', servers.rerankUrl,
  '--allow-peak', '--concurrency', '2', ...extra], {});

describe('the runner on a tiny collection', () => {
  const collections = buildCollections();
  cleanups.push(() => fs.rmSync(collections, { recursive: true, force: true }));
  const quiet = { log: () => {}, balance: null };

  test('one search per topic, the reader\'s list in two arms, the rerank reordering the same candidates, every cost in the ledger', async () => {
    const servers = await fakeServers();
    const root = workspace();
    const o = options(root, collections, servers);
    const outcome = await runRetrieval(o, quiet);
    assert.equal(outcome.exitCode, EXIT.finished);
    assert.equal(servers.state.chat, 3, 'one model call a topic');
    const read = (/** @type {string} */ arm) => fs.readFileSync(path.join(root, 'out', 'r1', `retrieved-${arm}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const plain = read('no-rerank'), reranked = read('rerank');
    assert.deepEqual(plain.map((row) => row.topic), ['trec-20211', 'trec-20212', 'trec-2023-1']);
    const lung = plain[0], lungRerank = reranked[0];
    // The list is the product's: lung trials found, a 58-year-old woman, so the paediatric and glaucoma trials are not in it.
    assert.deepEqual([...lung.retrieved].sort(), ['NCT00000001', 'NCT00000002']);
    assert.deepEqual(lung.retrieved[0], 'NCT00000001', 'two trials match every phrase: the one that matches more of them comes first');
    assert.deepEqual([...lungRerank.retrieved].sort(), [...lung.retrieved].sort(), 'rerank reorders the same candidates and drops none');
    assert.equal(lungRerank.retrieved[0], 'NCT00000001');
    assert.equal(lungRerank.rerank.state, 'ranked');
    assert.equal(lungRerank.rerank.tokens, 4000);
    // A 7-year-old boy: the paediatric migraine trial stays, the adult one (18 to 65, female only) is left out by the record's own fields.
    assert.deepEqual(plain[1].retrieved, ['NCT00000003']);
    assert.equal(plain[1].leftOut.age + plain[1].leftOut.sex > 0, true);
    assert.equal(plain[2].retrieved[0], 'NCT00000005');
    assert.equal(plain[2].collection.id, 'trec-ct-2023', 'the 2023 topic searched the 2023 collection');
    assert.equal(plain[0].collection.id, 'trec-ct-2021');
    assert.match(plain[0].request.summary, /osimertinib/u);
    // The model's request carries the record and the skill's sentence; nothing in the run could have carried a label.
    assert.ok(JSON.stringify(servers.state.bodies[0]).includes(SKILL_SEARCH_SENTENCE.slice(0, 40)));
    assert.deepEqual(servers.state.bodies[0].thinking, { type: 'disabled' });
    assert.ok(servers.state.rerankBodies.every((body) => !/NCT0000000\d/u.test(body.query)), 'no identifier in the rerank query');
    // Spend: three model calls and the one rerank that had two candidates to order (a list of one is not sent to the reranker), all in the ledger.
    const ledger = fs.readFileSync(path.join(root, 'out', 'spend-ledger-e.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(ledger.length, 4);
    assert.equal(servers.state.rerank, 1);
    assert.equal(reranked[1].rerank.state, 'skipped');
    assert.ok(ledger.every((entry) => entry.costCny > 0 && entry.arm === 'r1'));
  });

  test('a second run pays for nothing and writes the same files', async () => {
    const servers = await fakeServers();
    const root = workspace();
    const o = options(root, collections, servers);
    await runRetrieval(o, quiet);
    const before = fs.readFileSync(path.join(root, 'out', 'r1', 'retrieved-rerank.jsonl'), 'utf8');
    const ledgerBefore = fs.readFileSync(path.join(root, 'out', 'spend-ledger-e.jsonl'), 'utf8');
    const calls = { chat: servers.state.chat, rerank: servers.state.rerank };
    const again = await runRetrieval(o, quiet);
    assert.equal(again.exitCode, EXIT.finished);
    assert.deepEqual({ chat: servers.state.chat, rerank: servers.state.rerank }, calls);
    assert.equal(fs.readFileSync(path.join(root, 'out', 'r1', 'retrieved-rerank.jsonl'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(root, 'out', 'spend-ledger-e.jsonl'), 'utf8'), ledgerBefore);
    // Other settings under the same experiment name are refused.
    await assert.rejects(runRetrieval(options(root, collections, servers, ['--thinking', 'high']), quiet), { code: 'exp_settings_differ' });
  });

  test('--no-rerank writes the plain arm only and asks the reranker nothing', async () => {
    const servers = await fakeServers();
    const root = workspace();
    const outcome = await runRetrieval(options(root, collections, servers, ['--no-rerank']), quiet);
    assert.equal(outcome.exitCode, EXIT.finished);
    assert.equal(servers.state.rerank, 0);
    assert.ok(fs.existsSync(path.join(root, 'out', 'r1', 'retrieved-no-rerank.jsonl')));
    assert.ok(!fs.existsSync(path.join(root, 'out', 'r1', 'retrieved-rerank.jsonl')));
  });

  test('a search the model wrote unreadably is a failed topic, counted, with nothing made up and the others kept', async () => {
    const servers = await fakeServers();
    const root = workspace();
    servers.state.mode = 'broken';
    const outcome = await runRetrieval(options(root, collections, servers, ['--limit-topics', '2']), quiet);
    assert.equal(outcome.exitCode, EXIT.failedTopics);
    assert.deepEqual(outcome.summary?.failed, ['trec-20211', 'trec-20212']);
    assert.equal(outcome.summary?.failures['trec-20211'], 'search_unreadable');
    assert.equal(fs.readFileSync(path.join(root, 'out', 'r1', 'retrieved-no-rerank.jsonl'), 'utf8'), '');
    // The model has been paid for the answers it gave, and the ledger says so.
    assert.equal(fs.readFileSync(path.join(root, 'out', 'spend-ledger-e.jsonl'), 'utf8').trim().split('\n').length, 2);
  });

  test('a cap the estimate already passes refuses the run before any paid call', async () => {
    const servers = await fakeServers();
    const root = workspace();
    const outcome = await runRetrieval(options(root, collections, servers, ['--cap-cny', '0.0004']), quiet);
    assert.equal(outcome.exitCode, EXIT.refused);
    assert.equal(servers.state.chat, 0);
  });

  test('a call that costs more than the estimate stops the run before the next one and keeps what is done', async () => {
    const servers = await fakeServers();
    const root = workspace();
    servers.state.mode = 'expensive';
    const outcome = await runRetrieval(options(root, collections, servers, ['--cap-cny', '0.05', '--concurrency', '1']), quiet);
    assert.equal(outcome.exitCode, EXIT.stopped);
    assert.equal(servers.state.chat, 1, 'the first call spent past the cap, so no second call was made');
    assert.equal(outcome.summary?.stopped?.code, 'cap');
    assert.equal(fs.readFileSync(path.join(root, 'out', 'spend-ledger-e.jsonl'), 'utf8').trim().split('\n').length, 1);
  });

  test('a full-price window refuses a run that needs a model call, unless allowed', async () => {
    const servers = await fakeServers();
    const root = workspace();
    const peak = new Date('2026-11-04T07:00:00Z');
    const o = options(root, collections, servers).allowPeak ? { ...options(root, collections, servers), allowPeak: false } : options(root, collections, servers);
    const outcome = await runRetrieval(o, { ...quiet, now: () => peak });
    assert.equal(outcome.exitCode, EXIT.refused);
    assert.equal(servers.state.chat, 0);
  });

  test('--plan-only prices the model calls and makes none', async () => {
    const servers = await fakeServers();
    const root = workspace();
    const outcome = await runRetrieval(options(root, collections, servers, ['--plan-only']), quiet);
    assert.equal(outcome.exitCode, EXIT.finished);
    assert.equal(servers.state.chat + servers.state.rerank, 0);
    assert.ok(outcome.estimateCny > 0);
  });
});

describe('options and the model call', () => {
  test('the experiment, the thinking setting and the years are checked', () => {
    const base = ['--split', 's', '--topics', 't', '--collections', 'c', '--out', 'o', '--key-file', 'k'];
    assert.throws(() => parseOptions([...base, '--exp', 'Bad Name'], {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions([...base, '--exp', 'r1', '--thinking', 'max'], {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions([...base, '--exp', 'r1', '--years', '2020'], {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions(['--exp', 'r1', '--split', 's', '--topics', 't', '--collections', 'c', '--out', 'o'], {}), { code: 'option_missing' });
    assert.equal(parseOptions([...base, '--exp', 'r1'], {}).concurrency, 3);
  });
  test('selectedTopics reads the split in its order and refuses a topic the official file lacks', () => {
    const root = workspace();
    const o = { split: path.join(root, 'split.json'), set: 'dev', years: [2021, 2023], topicsDir: path.join(root, 'topics'), limitTopics: null };
    assert.deepEqual(selectedTopics(o).map((topic) => topic.id), ['trec-20211', 'trec-20212', 'trec-2023-1']);
    assert.deepEqual(selectedTopics({ ...o, limitTopics: 1 }).map((topic) => topic.id), ['trec-20211']);
    fs.writeFileSync(path.join(root, 'split.json'), JSON.stringify({ dev: { trec_2021: ['trec-20219'] } }));
    assert.throws(() => selectedTopics(o), { code: 'topic_missing' });
    // A topic the split lists as unscorable (no official judgments) is not selected, so nothing is paid for it.
    fs.writeFileSync(path.join(root, 'split.json'), JSON.stringify({ dev: { trec_2021: ['trec-20211', 'trec-20212'] }, unscorable: { trec_2021: ['trec-20212'] } }));
    assert.deepEqual(selectedTopics({ ...o, years: [2021] }).map((topic) => topic.id), ['trec-20211']);
  });
  test('a transient failure is asked again, a refusal is not', async () => {
    let calls = 0;
    const flaky = async () => { calls += 1; return calls < 3 ? new Response('busy', { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }); };
    const done = await chatOnce({ baseUrl: 'http://x', apiKey: 'k', model: 'm', thinking: 'off', messages: [], fetchImpl: /** @type {any} */ (flaky) });
    assert.equal(done.content, '{}');
    assert.equal(calls, 3);
    calls = 0;
    const refused = async () => { calls += 1; return new Response('no', { status: 401 }); };
    await assert.rejects(chatOnce({ baseUrl: 'http://x', apiKey: 'k', model: 'm', thinking: 'off', messages: [], fetchImpl: /** @type {any} */ (refused) }), { code: 'model_http_401' });
    assert.equal(calls, 1);
  });
});
