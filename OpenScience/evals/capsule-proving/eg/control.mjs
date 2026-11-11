// Read-only observations; no memories, evidence or approvals are fabricated.
export async function control(app, action, { userId } = {}) {
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
