// Read only the supplied project ledger copies. Never crawl account storage or read key files.
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = text => createHash('sha256').update(text).digest('hex');

export async function countRecordedHits(directories, days, now = Date.now()) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw Error('days must be 1 through 365');
  const since = now - days * 86400000;
  const calls = new Map(), observedRuns = new Set();
  let partial = false, segments = 0;
  for (const directory of new Set(directories.map(dir => path.resolve(dir)))) {
    const files = (await readdir(directory)).filter(name => /^runs(?:\.\d{6})?\.jsonl$/.test(name));
    if (!files.includes('runs.jsonl')) throw Error('missing runs.jsonl in a supplied project ledger');
    if (files.filter(name => name !== 'runs.jsonl').sort().some((name, i) => name !== `runs.${String(i + 1).padStart(6, '0')}.jsonl`)) throw Error('missing run ledger segment');
    segments += files.length;
    for (const name of files) {
      const lines = createInterface({ input: createReadStream(path.join(directory, name)), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        const receipt = row.memoryRecall;
        if (receipt?.version !== 1 || row.event !== 'learning') continue;
        if (Date.parse(row.at) >= since && Date.parse(row.at) <= now) {
          observedRuns.add(directory + '/' + row.id);
          partial ||= receipt.partial || receipt.state === 'incomplete';
        }
        for (const op of receipt.operations) {
          const at = Date.parse(op.at);
          if (!op.entry.endsWith('.search') || !(at >= since && at <= now)) continue;
          const hits = op.refs.filter(i => receipt.references[i]?.source === 'history').length;
          calls.set(JSON.stringify([directory, row.id, op.id]), hits);
        }
      }
    }
  }
  const counts = [...calls.values()];
  const hits = counts.filter(n => n > 0).length;
  return { days, since: new Date(since).toISOString(), until: new Date(now).toISOString(), segments,
    runsWithReceipts: observedRuns.size, recordedSearches: counts.length, searchesWithHistory: hits,
    deliveredHistoryExcerpts: counts.reduce((a,b) => a+b, 0), partial,
    historicalHit: hits ? 'observed' : counts.length ? 'none_in_recorded_searches' : 'unknown' };
}

export async function probeKnownQuote({ base, key, owner, projectId, sessionId, quote }, request = fetch) {
  if (!key || !owner || !projectId || !sessionId || !quote?.trim() || quote.length > 2000) throw Error('missing diagnostic identity, quote or credential');
  const url = new URL(base);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw Error('provide an HTTPS origin or loopback');
  const root = new URL('/api/agent-memory/v1', url.origin).href;
  const headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  const read = async (href, body) => {
    const response = await request(href, { method: body ? 'POST' : 'GET', headers, redirect:'error', signal: AbortSignal.timeout(15000),
      ...(body ? {body: JSON.stringify(body)} : {}) });
    if (!response.ok) throw Error('memory API returned HTTP ' + response.status);
    return (await response.json()).data;
  };
  const status = await read(root);
  if (status.accountHash !== hash(owner) || status.speaksFor !== 'account' || !status.capabilities?.rawConversationRecall?.available
    || !['memory.read','memory.history.read'].every(scope => status.scopes?.includes(scope))
    || status.projectId && status.projectId !== projectId) throw Error('account or project permission could not be verified');
  const reply = await read(root + '/recall', { query:quote, projectId, scope:'conversation', methods:'none', include:['history'] });
  const proof = reply.historyAccess;
  if (!proof || proof.ownerHash !== hash(owner) || proof.scope !== 'project' || proof.projectId !== projectId
    || !['memory.read','memory.history.read'].every(scope => proof.requiredScopes?.includes(scope))) throw Error('history permission receipt mismatch');
  const hit = reply.history?.find(row => !row.withdrawn && row.projectId === projectId && row.sessionId === sessionId &&
    row.contextOnly === true && row.confirmed === false && row.messages.some(m => m.sourceRole === 'user' && m.text.includes(quote)));
  return { matched: Boolean(hit), queryHash: hash(quote), historyAccess: proof,
    ...(hit ? { uri: hit.uri, contentHash: hash(JSON.stringify(hit.messages)) } : {}) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [base, owner, projectId, sessionId, days, ...directories] = process.argv.slice(2);
  if (!directories.length) throw Error('usage: memory-history-diagnostic.mjs ORIGIN OWNER PROJECT SESSION DAYS LEDGER_DIR... < known-quote.txt');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const recorded = await countRecordedHits(directories, Number(days));
  const probe = await probeKnownQuote({ base, owner, projectId, sessionId, key:process.env.EVIMED_DIAGNOSTIC_TOKEN,
    quote: Buffer.concat(chunks).toString('utf8').trim() });
  process.stdout.write(JSON.stringify({ recorded, probe }, null, 2) + '\n');
  if (!probe.matched) process.exitCode = 1;
}
