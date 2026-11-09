import { compactEvolutionRecords } from './evolutionRetention.mjs';

const POLL_MS = 15 * 60_000;
/** The one document that says which UTC day's pass has been taken, so a restart or a second process does not repeat it. */
const STATE_ID = 'evolution-retention-state';

/**
 * The daily pass of `evolutionRetention.mjs`. A day is claimed with a compare-and-swap on one ledger record, under the ledger's advisory lock, before the pass runs: at most
 * one pass a UTC day across restarts and processes, whether it succeeded or not (a pass that timed out is not asked again at every poll, and the rows wait for tomorrow's).
 * @param {{database:any, ledger:any, config?:any, canRun?:()=>Promise<boolean>, logger?:{error:(message:string, detail?:any)=>void}}} dependencies
 */
export function createEvolutionRetentionRunner({ database, ledger, config = {}, canRun = async () => true, logger = console }) {
  const counters = { passes: 0, failed: 0, recordsDeleted: 0 };
  /** @type {ReturnType<typeof setInterval>|null} */ let timer = null;
  /** @type {Promise<any>|null} */ let active = null;
  let closed = false;
  async function run() {
    if (closed || !(await canRun())) return null;
    const day = ledger.now().toISOString().slice(0, 10);
    const claimed = await ledger.withLock('retention-day', async () => {
      const prior = await ledger.get(STATE_ID);
      if (prior?.payload.day === day) return false;
      await ledger.save('retention-state', STATE_ID, { day, claimedAt: ledger.now().toISOString() }, prior);
      return true;
    });
    if (!claimed) return null;
    try {
      const deleted = Number(await compactEvolutionRecords(database, await ledger.owner(), { config, now: ledger.now(), admission: canRun }) ?? 0);
      counters.passes += 1; counters.recordsDeleted += deleted;
      return deleted;
    } catch (error) {
      counters.failed += 1;
      logger.error('Evolution retention failed', { code: /** @type {any} */ (error)?.code ?? 'evolution_retention_failed' });
      return null;
    }
  }
  /** One poll: never overlaps itself, never throws. */
  function tick() {
    if (active) return active;
    active = run().catch((/** @type {any} */ error) => { counters.failed += 1; logger.error('Evolution retention failed', { code: error?.code ?? 'evolution_retention_failed' }); })
      .finally(() => { active = null; });
    return active;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return {
    counters, tick, stop,
    start() { if (timer || closed) return; timer = setInterval(() => { void tick(); }, POLL_MS); timer.unref(); void tick(); },
    async close() { closed = true; stop(); await active; },
    status: () => ({ running: active !== null }),
  };
}
