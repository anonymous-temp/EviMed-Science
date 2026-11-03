/** Controller-owned snapshots are outside the runtime's project mount. Paths from a model are never download authority. */
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HttpError, openScopedFileNoFollow, writeFileAtomicNoFollow, resolveScopedPath, mimeFor, directorySize } from './security.mjs';
import { workspaceChangedFiles } from './runWorkspaceChanges.mjs';
export const analysisDigest = value => createHash('sha256').update(value).digest('hex');
/** Where every analysis of one account keeps its preserved bytes. @param {any} config @param {string} userId */
export function analysisAccountRoot(config,userId) {
  return path.join(config.dataDir,'.openscience','data-analysis',analysisDigest(userId));
}
/** @param {any} config @param {string} userId @param {string} analysisId */
export function analysisSnapshotRoot(config,userId,analysisId) {
  return path.join(analysisAccountRoot(config,userId),analysisId);
}
/** Preserved bytes live outside the project, so a project's or an account's deletion does not reach them: one analysis's, or all of an account's.
 * @param {any} config @param {string} userId @param {string|null} [analysisId] */
export async function removeAnalysisSnapshots(config,userId,analysisId=null) {
  await rm(analysisId?analysisSnapshotRoot(config,userId,analysisId):analysisAccountRoot(config,userId),{recursive:true,force:true});
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
/** Why one file the run produced could not be preserved, or null when the fault is not about that file and the snapshot should be tried again.
 * @param {any} error @returns {string|null} */
function unavailableReason(error) {
  if (error?.message==='invalid path'||['path_outside_scope','invalid_path','symlink_not_allowed','path_forbidden','ELOOP'].includes(error?.code)) return 'unsafe_path';
  if (['ENOENT','file_not_found'].includes(error?.code)) return 'missing';
  if (error?.code==='not_a_file'||error?.code==='EISDIR') return 'not_a_file';
  if (error?.code==='analysis_artifact_limit') return 'too_large';
  if (['analysis_snapshot_limit','project_scan_too_large'].includes(error?.code)) return 'snapshot_limit';
  if (['EACCES','EPERM'].includes(error?.code)) return 'unreadable';
  return null;
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
/** Select a coherent bundle before reading its summary/results. A copied nested
 * bundle is retained for download, but cannot silently override its parent.
 * Sibling alternatives need one explicitly presented bundle or remain ambiguous.
 * @param {string[]} paths @param {string[]} candidates @param {string[]} presented @param {any[]} notices */
function primaryAnalysisOutput(paths,candidates,presented,notices) {
  // Unavailable current markers still establish identity. Otherwise a missing or
  // oversized current JSON file would silently promote a readable old copy.
  const valid=candidates.filter(file=>file.length<=512&&!path.isAbsolute(file)&&!file.split('/').includes('..')&&file===path.posix.normalize(file));
  const roots=[...new Set(valid.filter(file=>['analysis-output.json','analysis-results.json'].includes(path.posix.basename(file))).map(file=>path.posix.dirname(file)))];
  const inside=(file,directory)=>directory==='.'||file.startsWith(`${directory}/`);
  const outer=roots.filter(root=>!roots.some(other=>other!==root&&inside(root,other)));
  if(roots.length>outer.length)notices.push({code:'nested_output_bundles'});
  const explicit=roots.filter(root=>presented.some(file=>valid.includes(file)&&path.posix.dirname(file)===root));
  const selected=explicit.length?explicit:outer;
  if(selected.length!==1){if(selected.length>1)notices.push({code:'primary_output_ambiguous'});return null;}
  const directory=selected[0];
  const member=name=>{const file=path.posix.join(directory,name);return paths.includes(file)?file:null;};
  const reports=paths.filter(file=>path.posix.dirname(file)===directory&&/\.(md|txt)$/i.test(file));
  return {directory,manifestPath:member('analysis-output.json'),resultsPath:member('analysis-results.json'),reportPath:member('statistical-report.md')??(reports.length===1?reports[0]:null)};
}
/** @param {any} project @param {any} run @param {string} root @param {any} config */
export async function snapshotAnalysisRun(project,run,root,config) {
  const notices=[],artifacts=[], roles=new Map(),texts=new Map();
  const unverified=new Set((run.unverifiedArtifacts??[]).filter(item=>typeof item==='string'));
  // The statistical contract lists its principal files, not every program-written
  // figure/table below them. Dedicated analysis workspaces have one admitted root
  // turn, so the existing bounded change detector can safely supply those outputs.
  // The scoped opener below still refuses symlinks; a manifest never grants access.
  const changed = await workspaceChangedFiles(project.workspaceDir, {
    since: Date.parse(run.startedAt ?? ''),
    until: Number.isFinite(Date.parse(run.finishedAt ?? '')) ? Date.parse(run.finishedAt) : Date.now(),
    limit: 65,
  });
  // Only a file the run itself declared was checked by the delivery contract. One found by change detection alone is a scratch file:
  // it is preserved and listed, and it is not `verified` however the run's own files fared.
  const declared=new Set([...(run.outputFiles ?? []),...(run.artifacts ?? []),...(run.presentedFiles ?? [])].filter(item=>typeof item==='string'));
  const candidates=[...new Set([...declared,...unverified,...changed].filter(item=>typeof item==='string' && !item.startsWith('analysis-inputs/')))];
  let total=0,structuredResults=null,summary='',outputManifestSeen=false;
  for (const relative of candidates.slice(0,64)) {
    try {
      if (relative.length>512 || path.isAbsolute(relative) || relative.split('/').includes('..') || relative.startsWith('analysis-inputs/')) throw new Error('invalid path');
      const bytes=await analysisRead(project.workspaceDir,relative,config.dataAnalysisMaxArtifactBytes);
      if (total+bytes.length>config.dataAnalysisMaxSnapshotBytes) throw new HttpError(413,'analysis_snapshot_limit','The analysis snapshot storage limit was reached.');
      total+=bytes.length;
      const sha256=await keepAnalysisBytes(root,bytes,config.dataAnalysisMaxSnapshotBytes);
      artifacts.push({id:`art_${analysisDigest(`${run.id}:${relative}:${sha256}`).slice(0,40)}`,filename:path.posix.basename(relative),path:relative,sha256,bytes:bytes.length,role:role(relative),mediaType:mimeFor(relative),verification:!unverified.has(relative)&&declared.has(relative)&&run.verification==='verified'?'verified':'unverified'});
      if(bytes.length<=65_536&&/\.(json|md|txt)$/i.test(relative))texts.set(relative,bytes.toString('utf8'));
    } catch (error) {
      // A file that cannot be preserved is listed with its reason and the rest of the result is returned. A fault that is not about
      // this file (the preserved-bytes storage failing) is thrown, and the caller keeps the reservation to try the snapshot again.
      const reason=unavailableReason(error);
      if (reason===null) throw error;
      notices.push({code:'artifact_unavailable',path:relative.slice(0,512),reason});
    }
  }
  const paths=artifacts.map(artifact=>artifact.path);
  const primaryOutput=primaryAnalysisOutput(paths,candidates,run.presentedFiles??[],notices);
  if(primaryOutput?.resultsPath){
    try {const data=JSON.parse(texts.get(primaryOutput.resultsPath));if(data?.schemaVersion!==1||!Array.isArray(data.analyses)||data.analyses.length>64)throw new Error();structuredResults=data;}
    catch {notices.push({code:'structured_results_invalid'});}
  }
  if(primaryOutput?.manifestPath){
    outputManifestSeen=true;
    try {
      const source=texts.get(primaryOutput.manifestPath);
      if(!source||Buffer.byteLength(source)>32_768)throw new Error();
      const manifest=JSON.parse(source);if(manifest?.schemaVersion!==1)throw new Error();
      summary=typeof manifest.summary==='string'?manifest.summary.slice(0,8000):'';
      for(const kind of ['tables','figures','code'])for(const entry of(Array.isArray(manifest[kind])?manifest[kind].slice(0,64):[])){
        const referenced=typeof entry==='string'?entry:entry?.path;
        const matches=typeof referenced==='string'?[...new Set([referenced,path.posix.join(primaryOutput.directory,referenced)])].filter(candidate=>paths.includes(candidate)):[];
        if(matches.length!==1)notices.push({code:matches.length?'manifest_reference_ambiguous':'manifest_reference_unavailable'});
        else roles.set(matches[0],kind==='tables'?'table':kind==='figures'?'figure':'code');
      }
    }catch{notices.push({code:'output_manifest_invalid'});}
  }
  if(!summary&&primaryOutput?.reportPath)summary=(texts.get(primaryOutput.reportPath)??'').slice(0,8000);
  if(!summary&&!primaryOutput&&!notices.some(notice=>notice.code==='primary_output_ambiguous')){
    const reports=paths.filter(file=>/\.(md|txt)$/i.test(file)&&texts.has(file));
    if(reports.length===1)summary=texts.get(reports[0]).slice(0,8000);
  }
  for(const artifact of artifacts)if(roles.has(artifact.path))artifact.role=roles.get(artifact.path);
  if(candidates.length>64)notices.push({code:'artifact_count_limit'});
  if(unverified.size)notices.push({code:'unverified_artifacts'});
  if(!structuredResults)notices.push({code:'structured_results_unavailable'});
  if(!outputManifestSeen)notices.push({code:'output_manifest_unavailable'});
  if(!artifacts.length)notices.push({code:'no_artifacts'});
  if(!summary)notices.push({code:'summary_unavailable'});
  return {summary,structuredResults,primaryOutput,artifacts,notices: [...notices,...(Array.isArray(run.notices)?run.notices.slice(0,32).map(item=>({code:String(item?.code??'run_notice').slice(0,100)})):[])].slice(0,128),frozenAt:new Date().toISOString()};
}
