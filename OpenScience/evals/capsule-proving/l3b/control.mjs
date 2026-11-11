// Read-only native-commit evidence alongside the existing LX controls. No synthetic method or memory writes.
import { control as lx } from '../lx/lx-control.mjs';
export async function control(app, action, args) {
  if (action !== 'lxMemoryState') return lx(app, action, args);
  if (process.env.OPEN_SCIENCE_MEMORY_ENABLED === 'false')
    return { at: new Date().toISOString(), disabled: true, commits: [] };
  return { at: new Date().toISOString(), worker: app.nativeMemoryWorker.status(),
    commits: (await app.store.database.query(`SELECT archive_uri,project_id,source_session,origin,state,operations,error,extraction,created_at,updated_at
      FROM evimed_memory.native_commits WHERE user_id=$1 ORDER BY created_at`, [args.userId])).rows };
}
