// Paired existing general-task cases; both arms keep the memory plugin and candidate flags.
// Only the seeded arm gets the frozen case seed statements, through a prior real conversation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runCell } from '../../general-tasks/runner/cell.mjs';
import { buildPlan, judge, summarize } from '../../general-tasks/runner/run.mjs';
import { runConversation } from '../lx/conversation.mjs';
import { caseSha } from '../synthetic/learnsets.mjs';
import { argsOf, setup, account, read, save, settle, ipc } from './common.mjs';

const args = argsOf(process.argv.slice(2));
if (!['seeded', 'empty'].includes(args.arm)) throw new Error('--arm seeded|empty required');
const suite = path.resolve(args.tree, 'evals/general-tasks');
const { cases } = await read(`${suite}/cases.json`);
const seedsFile = `${args.data}/g10-seeds/seeds.json`;
const { seeds } = await read(seedsFile);
const byId = new Map(seeds.map(s => [s.caseId, s]));
for (const c of cases) {
  const seed = byId.get(c.id);
  const sha = caseSha(c);
  if (!seed || seed.caseSha256 !== sha) throw new Error(`Seed/case digest mismatch: ${c.id}`);
}
const plan = buildPlan(cases, { ids: args.cases?.split(','), set: 'all', arm: 'B', variants: ['normal'] });
const ctx = await setup(args);
await fs.mkdir(`${args.out}/records`, { recursive: true });
await fs.mkdir(`${args.out}/judged`, { recursive: true });
await save(`${args.out}/run.json`, { runId: path.basename(args.out), arm: args.arm, tree: { path: args.tree, commit: ctx.commit },
  flags: { lockIsolation: true, safetyNotes: false, normalVariantsOnly: true, seedMemory: args.arm === 'seeded', memoryPluginInBothArms: true },
  seedDigest: createHash('sha256').update(await fs.readFile(seedsFile)).digest('hex'), plannedCases: plan.flatMap(u => u.cases.map(c => c.id)) });
try {
  for (const unit of plan) {
    const name = `${unit.id}-r1`;
    const dir = `${args.out}/units/${unit.id}`;
    if (await read(`${args.out}/records/${name}.json`)) {
      if (!await read(`${args.out}/judged/${name}.json`)) judge(args, args.out, name);
      const identity = await read(`${dir}/account.json`);
      if (identity && !await read(`${dir}/usage.json`)) await save(`${dir}/usage.json`, await ipc(ctx.h, 'usage', { userId: identity.userId }));
      await fs.rm(`${dir}/in-flight.json`, { force: true });
      ctx.status(`skip ${name}`); continue;
    }
    if (await read(`${dir}/in-flight.json`)) {
      // A half-attempt must not turn the empty arm into a remembered second attempt.
      const archived = `${args.out}/interrupted/${unit.id}-${Date.now()}`;
      await fs.mkdir(`${args.out}/interrupted`, { recursive: true });
      await fs.rename(dir, archived);
      const files = `${args.out}/records/${name}.files`;
      if (await fs.stat(files).catch(() => null)) await fs.rename(files, `${archived}/task-files`);
      ctx.status(`${name} interrupted; evidence archived, restarting on a fresh identity`);
    }
    await save(`${dir}/in-flight.json`, { at: new Date().toISOString(), arm: args.arm });
    const identity = await account(ctx.h, `${dir}/account.json`, 'eg10');
    if (args.arm === 'seeded' && !await read(`${dir}/seed.json`)) {
      const statements = unit.cases.flatMap(c => byId.get(c.id).statements.map(s => s.text));
      const record = await runConversation({ ...identity, projectId: 'default', sessionId: `seed-${unit.id.replaceAll('+', '-')}`,
        first: `Please remember the following details about me for later conversations.\n\n${statements.join('\n')}`, next: () => null, maxTurns: 1, automated: false, memoryBusyRetryMs: 180_000, dataDir: ctx.dataDir, outDir: `${dir}/seed`, timeoutMs: args.timeoutMin * 60_000, log: ctx.status });
      const commits = await settle(ctx.h, identity.userId, ctx.status);
      const snapshot = await ipc(ctx.h, 'lxEGSnapshot', { userId: identity.userId });
      await save(`${dir}/seed.json`, { statements, record, commits, snapshot });
      ctx.status(`${unit.id} seeded ${statements.length} statements; files=${snapshot.metrics.files} timedOut=${commits.timedOut}`);
    }
    const spec = { id: unit.id, family: unit.cases[0].family, inputs: unit.cases[0].inputs ?? [], turns: unit.cases.flatMap(c => c.turns),
      manual_trigger: unit.cases.find(c => c.manual_trigger)?.manual_trigger, seed_methods: unit.cases[0].seed_methods };
    const record = await runCell({ api: identity.api, account: identity, spec, fixtureRoot: `${suite}/fixtures`, dataDir: ctx.dataDir,
      outDir: `${args.out}/records/${name}.files`, timeoutMs: Math.max(args.timeoutMin, ...unit.cases.map(c => c.timeout_min ?? 0)) * 60_000,
      log: ctx.status, automated: false, waitMemoryTools: true });
    Object.assign(record, { name, caseIds: unit.cases.map(c => c.id), turnOffsets: Object.fromEntries(unit.cases.map((c, i) => [c.id, unit.cases.slice(0, i).reduce((n, p) => n + p.turns.length, 0)])),
      variant: 'normal', profile: 'normal', rep: 1, arm: args.arm, tree: { path: args.tree, commit: ctx.commit } });
    await save(`${args.out}/records/${name}.json`, record);
    await save(`${dir}/usage.json`, await ipc(ctx.h, 'usage', { userId: identity.userId }));
    judge(args, args.out, name); summarize(args.out);
    await fs.rm(`${dir}/in-flight.json`, { force: true });
    ctx.status(`DONE ${name} arm=${args.arm}`);
  }
  summarize(args.out); ctx.status(`DONE G10 ${args.arm}`);
} finally { await ctx.close(); }
