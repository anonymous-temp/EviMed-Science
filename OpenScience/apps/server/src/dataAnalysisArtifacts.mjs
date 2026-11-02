/** Controller-owned snapshots are outside the runtime's project mount. Paths from a model are never download authority. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HttpError, openScopedFileNoFollow, writeFileAtomicNoFollow, resolveScopedPath, mimeFor, directorySize } from './security.mjs';
export const analysisDigest = value => createHash('sha256').update(value).digest('hex');
/** @param {any} config @param {string} userId @param {string} analysisId */
export function analysisSnapshotRoot(config,userId,analysisId) {
  return path.join(config.dataDir,'.openscience','data-analysis',analysisDigest(userId),analysisId);
}
/** @param {string} root @param {string} relative @param {number} limit */
export async function analysisRead(root,relative,limit) {
  const opened = await openScopedFileNoFollow(root,resolveScopedPath(root,relative));
  try {
    if (!opened.stat.isFile() || opened.stat.size > limit) throw new HttpError(413,'analysis_artifact_limit','The artifact exceeds the byte limit.');
    // readFile has no streaming limit when the runtime grows a file during the read.
    const chunks = []; let size=0;
    for await (const chunk of opened.handle.createReadStream({autoClose:false})) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413,'analysis_artifact_limit','The artifact exceeds the byte limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks,size);
  } finally { await opened.handle.close(); }
}
/** @param {string} root @param {Buffer} bytes @param {number} maxTotal */
export async function keepAnalysisBytes(root,bytes,maxTotal) {
  const sha256=analysisDigest(bytes);
  try{const previous=await analysisRead(root,sha256,bytes.length);if(analysisDigest(previous)!==sha256)throw new HttpError(409,'analysis_artifact_changed','Preserved bytes changed.');return sha256;}
  catch(error){if(!['ENOENT','file_not_found'].includes(error?.code))throw error;}
  if(await directorySize(root,{maxEntries:10000})+bytes.length>maxTotal)throw new HttpError(413,'analysis_snapshot_limit','The analysis snapshot storage limit was reached.');
  await writeFileAtomicNoFollow(root,path.join(root,sha256),bytes,{mode:0o600});
  return sha256;
}
/** @param {string} filename */
function role(filename) {
  const ext=path.extname(filename).toLowerCase();
  if (['.png','.svg','.jpg','.jpeg','.webp'].includes(ext)) return 'figure';
  if (['.csv','.tsv','.xlsx'].includes(ext)) return 'table';
  if (['.py','.r','.js','.mjs','.ipynb','.sql'].includes(ext)) return 'code';
  if (['.md','.pdf','.html','.docx','.txt'].includes(ext)) return 'report';
  return 'data';
}
/** @param {any} project @param {any} run @param {string} root @param {any} config */
export async function snapshotAnalysisRun(project,run,root,config) {
  const notices=[],artifacts=[], roles=new Map();
  const unverified=new Set((run.unverifiedArtifacts??[]).filter(item=>typeof item==='string'));
  const candidates=[...new Set([...(run.outputFiles ?? []),...(run.artifacts ?? []),...(run.presentedFiles ?? []),...unverified].filter(item=>typeof item==='string'))];
  let total=0,structuredResults=null,summary='',outputManifestSeen=false;
  for (const relative of candidates.slice(0,64)) {
    try {
      if (relative.length>512 || path.isAbsolute(relative) || relative.split('/').includes('..') || relative.startsWith('analysis-inputs/')) throw new Error('invalid path');
      const bytes=await analysisRead(project.workspaceDir,relative,config.dataAnalysisMaxArtifactBytes);
      if (total+bytes.length>config.dataAnalysisMaxSnapshotBytes) throw new HttpError(413,'analysis_snapshot_limit','The analysis snapshot storage limit was reached.');
      total+=bytes.length;
      const sha256=await keepAnalysisBytes(root,bytes,config.dataAnalysisMaxSnapshotBytes);
      artifacts.push({id:`art_${analysisDigest(`${run.id}:${relative}:${sha256}`).slice(0,40)}`,filename:path.posix.basename(relative),path:relative,sha256,bytes:bytes.length,role:role(relative),mediaType:mimeFor(relative),verification:unverified.has(relative)?'unverified':run.verification==='verified'?'verified':'unverified'});
      if (!summary && /\.(md|txt)$/i.test(relative) && bytes.length<=65_536) summary=bytes.toString('utf8').slice(0,8000);
      if (path.basename(relative)==='analysis-results.json' && bytes.length<=65_536) {
        try { const data=JSON.parse(bytes.toString('utf8')); if (data.schemaVersion!==1 || !Array.isArray(data.analyses) || data.analyses.length>64) throw new Error(); structuredResults=data; }
        catch { notices.push({code:'structured_results_invalid'}); }
      }
      if (path.basename(relative)==='analysis-output.json' && bytes.length<=32_768) {
        outputManifestSeen=true;
        try {const manifest=JSON.parse(bytes.toString('utf8'));if(manifest.schemaVersion!==1)throw new Error();summary=typeof manifest.summary==='string'?manifest.summary.slice(0,8000):'';
          for(const kind of ['tables','figures','code']) for(const entry of (Array.isArray(manifest[kind])?manifest[kind].slice(0,64):[])) {
            const referenced=typeof entry==='string'?entry:entry?.path;
            const matches=typeof referenced==='string'?[...new Set([referenced,path.posix.join(path.posix.dirname(relative),referenced)])].filter(candidate=>candidates.includes(candidate)):[];
            if(matches.length!==1)notices.push({code:matches.length?'manifest_reference_ambiguous':'manifest_reference_unavailable'});
            else roles.set(matches[0],kind==='tables'?'table':kind==='figures'?'figure':'code');
          }
        } catch {notices.push({code:'output_manifest_invalid'});}
      }
    } catch (error) {
      // Missing/oversized files are visible partial results. Snapshot storage failure holds the next turn.
      if (!['ENOENT','file_not_found','path_outside_scope','invalid_path','symlink_not_allowed','analysis_artifact_limit','path_forbidden','not_a_file','ELOOP'].includes(error?.code) && error?.message!=='invalid path') throw error;
      notices.push({code:'artifact_unavailable',path:relative.slice(0,512)});
    }
  }
  for(const artifact of artifacts)if(roles.has(artifact.path))artifact.role=roles.get(artifact.path);
  if(candidates.length>64)notices.push({code:'artifact_count_limit'});
  if(unverified.size)notices.push({code:'unverified_artifacts'});
  if(!structuredResults)notices.push({code:'structured_results_unavailable'});
  if(!outputManifestSeen)notices.push({code:'output_manifest_unavailable'});
  if(!artifacts.length)notices.push({code:'no_artifacts'});
  if(!summary)notices.push({code:'summary_unavailable'});
  return {summary,structuredResults,artifacts,notices: [...notices,...(Array.isArray(run.notices)?run.notices.slice(0,32).map(item=>({code:String(item?.code??'run_notice').slice(0,100)})):[])].slice(0,128),frozenAt:new Date().toISOString()};
}
