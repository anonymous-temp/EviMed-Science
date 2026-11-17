// Snapshot only delivered versions, without following links or reading outside the workspace.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openScopedFileNoFollow } from './security.mjs';

export async function readLearningDeliveryBindings(project, run, { atDelivery = false } = {}) {
  const named = value => String(typeof value === 'string' ? value : value?.path ?? '');
  const kinds = Object.entries(run.artifactKinds ?? {});
  const files = run.presentedFiles?.length ? run.presentedFiles.map(named)
    : kinds.length ? kinds.filter(([, kind]) => kind === 'deliverable').map(([file]) => file)
    : ['artifacts', 'unverifiedArtifacts', 'outputFiles'].flatMap(field => (run[field] ?? []).map(named));
  const bindings = [];
  for (const file of [...new Set(files)].slice(0, 4)) {
    if (!file || file.length > 200 || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) continue;
    let opened;
    try {
      opened = await openScopedFileNoFollow(project.workspaceDir, path.join(project.workspaceDir, file));
      if (!opened.stat.isFile() || opened.stat.size > 16 * 1024 * 1024) continue;
      const before = opened.stat;
      // A delayed completion hook cannot bind bytes another turn wrote after this run ended.
      const ended = Date.parse(run.finishedAt ?? "");
      if (atDelivery && (!Number.isFinite(ended) || before.mtimeMs > ended + 1)) continue;
      const bytes = await opened.handle.readFile();
      const after = await opened.handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) continue;
      bindings.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex') });
    } catch { /* A missing or unreadable version cannot be bound. */ }
    finally { await opened?.handle.close().catch(() => {}); }
  }
  return bindings;
}
