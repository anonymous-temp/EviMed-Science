/** Driver-only local daemon selection, never a serving configuration or global Docker context mutation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {openScopedFileNoFollow,readStableFileHandle} from '../../apps/server/src/security.mjs';
const contexts=new Set(['default','colima','colima-evimed-extension-acceptance']);
export function assessmentDockerEnvironment(environment=process.env) {
 const selected=environment.DOCKER_CONTEXT;
 if(selected!==undefined&&!contexts.has(selected))throw new Error('assessment_docker_context_refused');
 return {...(typeof environment.PATH==='string'?{PATH:environment.PATH}:{}),...(selected?{DOCKER_CONTEXT:selected}:{})};
}
/** Wrap only the existing owned test transport. Literal context survives the serving controller's deliberately closed env.
 * Original transport continues to own exact argv, definite missing-bind retries and joined Docker start/cancel.
 */
export async function bindAssessmentDockerLauncher(file,environment=process.env) {
 const selected=assessmentDockerEnvironment(environment).DOCKER_CONTEXT;
 if(!selected)return;
 if(!path.isAbsolute(file)||path.basename(file)!=='docker-fixture.mjs')throw new Error('assessment_launcher_path_refused');
 const root=path.dirname(file),info=await fs.lstat(root);
 if(!info.isDirectory()||info.isSymbolicLink()||await fs.realpath(root)!==root||(info.mode&0o077))throw new Error('assessment_launcher_root_refused');
 const opened=await openScopedFileNoFollow(root,file);
 try{if(opened.stat.size<1||opened.stat.size>65536||(opened.stat.mode&0o077))throw new Error('assessment_launcher_refused');await readStableFileHandle(opened.handle,opened.stat);}
 finally{await opened.handle.close();}
 const transport=path.join(root,'docker-transport.mjs');await fs.link(file,transport);await fs.unlink(file);
 try{await fs.writeFile(file,`#!${process.execPath}\nprocess.env.DOCKER_CONTEXT=${JSON.stringify(selected)};await import('./docker-transport.mjs');\n`,{mode:0o700,flag:'wx'});}
 catch(error){await fs.rename(transport,file);throw error;}
}
