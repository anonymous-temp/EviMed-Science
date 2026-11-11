// G1: ordered real conversations, followed by new conversations at the source checkpoints.
// Gold is read only by the separate selection/scoring processes, never this driver.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { runConversation } from '../lx/conversation.mjs';
import { loadCases } from '../run/cases.mjs';
import { argsOf, setup, account, read, save, settle, ipc, profileOpening } from './common.mjs';

const args = argsOf(process.argv.slice(2));
const sample = await read(args.selection);
if (!sample || sample.n !== 100) throw new Error('A frozen 100-question selection is required');
const users = (args.users ?? sample.users.join(',')).split(',');
const cases = await loadCases({ set: 'synthetic-users', split: 'dev', dataDir: args.data, only: users });
const ctx = await setup(args);
const runId = path.basename(args.out);
await save(`${args.out}/run.json`, { runId, set: 'synthetic-users', split: 'dev', arm: 'product-path', commit: ctx.commit, engine: await read(`${args.out}/engine.json`),
  flags: { lockIsolation: true, safetyNotes: false, conversationDriver: 'LX', generatedAssistant: true, historyTimestamps: 'wall-clock' },
  options: { caseIds: users }, model: { answer: 'deepseek-flash', thinking: 'enabled' }, selection: args.selection });

async function observeAnswer(record, q, since) {
  const turn = record.turns.at(-1);
  const raw = (await fs.readFile(`${args.out}/cases/${q.user}/conversations/${q.qid}/t0-${turn.runId}.jsonl.gz`));
  const lines = zlib.gunzipSync(raw).toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const toolCalls = lines.flatMap(m => (m.parts ?? []).filter(p => p.type === 'tool').map(p => ({ name: p.tool, args: p.input,
    blocks: [typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '')], isError: p.status === 'error' })));
  const firstDir = `${ctx.dataDir}/first-requests`;
  const requests = [];
  for (const file of await fs.readdir(firstDir)) {
    const full = `${firstDir}/${file}`, stat = await fs.stat(full);
    if (stat.mtimeMs < since) continue;
    const request = await read(full);
    if (request.tools?.length > 10) requests.push({ file: full, ...request });
  }
  const first = requests.sort((a, b) => a.at.localeCompare(b.at))[0];
  const firstCopy = `${args.out}/cases/${q.user}/conversations/${q.qid}/first-request.json`;
  if (first) await save(firstCopy, first);
  const opening = first ? profileOpening(first) : '';
  return { qid: q.qid, caseId: q.user, arm: 'product-path', question: q.text, asOf: q.asOf, answer: turn.reply, opening: { profileBlock: opening }, toolCalls,
    usage: { ...(turn.run?.usage ?? {}), promptTokens: turn.run?.usage?.inputTokens ?? 0, completionTokens: turn.run?.usage?.outputTokens ?? 0,
      cachedTokens: turn.run?.usage?.cachedInputTokens ?? 0 }, runId: turn.runId, status: turn.run?.status, wallMs: turn.wallMs,
    evidence: { firstRequest: first ? firstCopy : null, availableTools: first?.tools?.map(t => t.function?.name ?? t.name) ?? [],
      sourceAsOf: q.asOf, productAt: record.startedAt, generatedAssistant: true },
    ...(!['completed', 'succeeded'].includes(turn.run?.status) ? { error: turn.error ?? turn.run?.errorCode ?? `run_${turn.run?.status}` } : {}) };
}
try {
  for (const item of cases) {
    const dir = `${args.out}/cases/${item.caseId}`;
    await fs.mkdir(dir, { recursive: true });
    const identity = await account(ctx.h, `${dir}/account.json`, 'eg1');
    const p = await read(`${dir}/progress.json`, { sessions: 0, answered: [] });
    let activeProject = null;
    const selected = sample.questions.filter(q => q.user === item.caseId);
    const max = Math.max(...selected.map(q => q.checkpoint));
    const converse = async (key, texts, project, onTurn = null) => {
      const projectId = project?.id ?? 'ordinary';
      const previous = await read(`${dir}/conversations/${key}.json`);
      if (previous) await save(`${dir}/conversation-attempts/${key}-${previous.startedAt.replaceAll(':', '-')}.json`, previous);
      if (activeProject && activeProject !== projectId) { identity.api.project = activeProject; await identity.api.call('POST', '/api/commands/stop_runtime', {}); }
      const record = await runConversation({ ...identity, projectId, projectName: project?.name, sessionId: `eg-${item.caseId}-${key}`,
        // Simulated people on isolated accounts: automated runs are deliberately ineligible for memory admission.
        first: texts[0], next: (_turn, i) => texts[i + 1] ?? null, maxTurns: texts.length, keepRuntime: true, automated: false, memoryBusyRetryMs: 180_000, continueAfterTimeout: true,
        waitMemoryTools: activeProject !== projectId, dataDir: ctx.dataDir, outDir: `${dir}/conversations/${key}`, timeoutMs: args.timeoutMin * 60_000,
        log: ctx.status, onTurn: async r => { await save(`${dir}/conversations/${key}.partial.json`, r); if (onTurn) await onTurn(r); } });
      activeProject = projectId;
      await save(`${dir}/conversations/${key}.json`, record);
      if (record.turns.some(t => t.error) || record.turns.length !== texts.length) throw new Error(`Conversation ${item.caseId}/${key} incomplete`);
      return record;
    };
    for (let n = p.sessions; n <= max; n++) {
      const questions = selected.filter(q => q.checkpoint === n && !p.answered.includes(q.qid));
      if (questions.length) {
        // A resume must never replace the state an earlier probe actually saw with a later state.
        if (!await read(`${dir}/snapshots/${n}.json`)) {
          const commits = await settle(ctx.h, identity.userId, ctx.status);
          await save(`${dir}/commits-${n}.json`, commits);
          const snapshot = await ipc(ctx.h, 'lxEGSnapshot', { userId: identity.userId });
          await save(`${dir}/snapshots/${n}.json`, { ...snapshot, afterSession: n, settle: commits });
        }
        for (const sq of questions) {
          const q = { ...item.questions.find(q => q.qid === sq.qid), user: item.caseId };
          if (!await read(`${dir}/question-snapshots/${q.qid}.json`)) await save(`${dir}/question-snapshots/${q.qid}.json`,
            { ...await ipc(ctx.h, 'lxEGSnapshot', { userId: identity.userId }), afterSession: n });
          const since = Date.now();
          ctx.status(`${item.caseId} question ${q.qid} checkpoint=${n}`);
          const record = await converse(q.qid, [q.text], q.project);
          const answer = await observeAnswer(record, q, since);
          await save(`${dir}/answer-records/${q.qid}.json`, answer);
          p.answered.push(q.qid); await save(`${dir}/progress.json`, p);
          ctx.status(`${item.caseId} answer ${q.qid} status=${answer.status}`);
        }
      }
      if (n === max) break;
      const session = item.sessions[n];
      const texts = session.messages.filter(m => m.role === 'user').map(m => m.text);
      ctx.status(`${item.caseId} ingest ${n + 1}/${max} ${session.sessionId} userTurns=${texts.length}`);
      const record = await converse(session.sessionId, texts, session.project);
      await fs.appendFile(`${dir}/ingest.jsonl`, `${JSON.stringify({ sessionId: session.sessionId, sourceAt: session.at, at: record.startedAt, runs: record.turns.map(t => t.runId), generatedAssistant: true, attachments: session.attachments ?? [] })}\n`);
      p.sessions = n + 1; await save(`${dir}/progress.json`, p);
    }
    identity.api.project = activeProject; await identity.api.call('POST', '/api/commands/stop_runtime', {});
    const answers = [];
    for (const q of selected) { const a = await read(`${dir}/answer-records/${q.qid}.json`); if (a) answers.push(a); }
    await fs.writeFile(`${dir}/answers.jsonl`, answers.map(a => JSON.stringify(a)).join('\n') + '\n');
    await save(`${dir}/usage.json`, await ipc(ctx.h, 'usage', { userId: identity.userId }));
    ctx.status(`${item.caseId} DONE sessions=${p.sessions} answers=${answers.length}`);
  }
  ctx.status('DONE G1 product conversations');
} finally { await ctx.close(); }
