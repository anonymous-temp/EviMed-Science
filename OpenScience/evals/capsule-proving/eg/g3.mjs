// The existing native-browser longitudinal evaluation, placed on the isolated lab harness.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { argsOf, setup, ipc, save } from './common.mjs';
const args = argsOf(process.argv.slice(2));
Object.assign(process.env, { OPEN_SCIENCE_LEARNING_ENABLED: 'true', EVAL_METHOD_RANKER: '1',
  OPEN_SCIENCE_STATIC_DIR: path.resolve(args.tree, 'apps/web/dist'), OPEN_SCIENCE_LEARNING_WINDOW: '', EVAL_JUDGE_USAGE_LOG: `${args.out}/judge-usage.jsonl` });
const ctx = await setup(args);
process.env.EG_CONTROL_DIR = `${args.out}/control`;
const database = `evimed_test_${path.basename(args.out).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 60);
let child;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child?.kill('SIGTERM'));
try {
  const argv = [path.resolve(args.tree, 'evals/capsule-proving/eg/g3_host.py'), '--tree', args.tree, '--out', args.out,
    '--port', String(args.port), '--pg-port', String(args.pgPort), '--database', database];
  for (const [flag, key] of [['--scenarios', 'scenarios'], ['--repeats', 'repeats']]) if (args[key]) argv.push(flag, args[key]);
  const code = await new Promise((resolve, reject) => {
    child = spawn('python3', argv, { stdio: ['ignore', 'pipe', 'inherit'] });
    readline.createInterface({ input: child.stdout }).on('line', async line => {
      if (!line.startsWith('EG_CONTROL ')) { process.stdout.write(`${line}\n`); return; }
      const request = JSON.parse(line.slice('EG_CONTROL '.length));
      if (!/^[0-9a-f]{32}$/.test(request.id)) throw new Error('Bad eval control id');
      try { await save(`${process.env.EG_CONTROL_DIR}/${request.id}.json`, { value: await ipc(ctx.h, 'lxEGIdleLearning', { userIds: request.userIds }) }); }
      catch (e) { await save(`${process.env.EG_CONTROL_DIR}/${request.id}.json`, { error: e.message }); }
    });
    child.on('error', reject); child.on('exit', resolve);
  });
  if (code !== 0) throw new Error(`Longitudinal runner exited ${code}`);
  ctx.status('DONE G3 native browser scenarios');
} finally { child?.kill('SIGTERM'); await ctx.close(); }
