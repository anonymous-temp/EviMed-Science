/** Exact workspace read for the native trial-benchmark wrapper transformation. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HttpError,openScopedFileNoFollow,readStableFileHandle,resolveScopedPath } from './security.mjs';
export async function readVcrBenchmarkFile(project,relative) {
  if (typeof relative!=='string' || !relative || path.isAbsolute(relative)) throw new HttpError(400,'vcr_benchmark_invalid','Select a relative prediction file in this workspace.');
  const file=await openScopedFileNoFollow(project.workspaceDir,resolveScopedPath(project.workspaceDir,relative));
  try {
    if (!file.stat.isFile() || file.stat.size>400*1024) throw new HttpError(400,'vcr_benchmark_invalid','The prediction file exceeds its bound.');
    const bytes=await readStableFileHandle(file.handle,file.stat);const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if (!parsed || typeof parsed!=='object' || Array.isArray(parsed) || !Array.isArray(parsed.comparisons)) throw new HttpError(400,'vcr_benchmark_invalid','A prediction file requires comparisons.');
    return {...parsed,sourceFile:{name:path.basename(relative),sha256:createHash('sha256').update(bytes).digest('hex')}};
  } finally {await file.handle.close();}
}
