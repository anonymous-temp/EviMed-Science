// Read-only observations; no memories, evidence or approvals are fabricated.
export async function control(app, action, { userId, userIds = [] } = {}) {
  if (action === 'lxEGIdleLearning') {
    // Host kernels share a bridge port; reclaim completed internal learning kernels before the next native conversation.
    // Production containers have separate loopbacks. Never interrupt a job or a live internal run.
    for (const owner of userIds) {
      if (!/^cl-s[0-9]+[ab]-[0-9a-f]{8}$/.test(owner)) throw new Error('Expected a longitudinal throwaway identity');
      const busy = await app.store.database.query("SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND kind=ANY($2::text[]) AND (status='running' OR (status='queued' AND run_after<=clock_timestamp())) LIMIT 1", [owner, ['distill', 'consolidate', 'learning-evidence']]);
      if (busy.rows.length) return { busy: true };
    }
    const stopped = [];
    for (const owner of userIds) {
      const user = await app.store.userById(owner);
      if (!user) continue;
      let project;
      try { project = await app.store.requireProject(user, 'evimed-learning'); } catch (e) { if (e.status !== 404) throw e; continue; }
      const live = (await app.agentRuns.list(project)).some(r => ['queued', 'running', 'planned', 'dispatching', 'starting', 'waiting'].includes(r.status));
      if (live) return { busy: true };
      await app.runtimeManager.stop(project); stopped.push(owner);
    }
    return { busy: false, stopped };
  }
  if (action === 'lxEGCommits') {
    const rows = (await app.store.database.query('SELECT engine_session,archive_uri,state,error,created_at,updated_at FROM evimed_memory.native_commits WHERE user_id=$1 ORDER BY created_at', [userId])).rows;
    return { at: new Date().toISOString(), total: rows.length, pending: rows.filter(r => ['pending', 'failed'].includes(r.state)).length, rows };
  }
  if (action === 'lxEGSnapshot') {
    const held = await app.nativeMemory.files(userId);
    const files = Object.fromEntries(held.map(f => [f.relPath, f.body]));
    return { at: new Date().toISOString(), files, metrics: { files: held.length, chars: held.reduce((n, f) => n + f.body.length, 0) } };
  }
  throw new Error(`Unknown EG observation: ${action}`);
}
