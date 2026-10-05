#!/usr/bin/env node
/** Operator-only proposal preparation. Candidate bytes are data, never executed or installed. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {canonicalJson} from '@evimed/domain';
const sha=value=>createHash('sha256').update(value).digest('hex');
const refuse=message=>{throw new Error(message);};
function readImmutable(file){
 for(let current=path.resolve(file);;current=path.dirname(current)){if(fs.lstatSync(current).isSymbolicLink())refuse('Symlinked staging is refused.');if(path.dirname(current)===current)break;}
 const stat=fs.statSync(file);if(!stat.isFile()||stat.nlink!==1||stat.size>6*1024*1024||(stat.mode&0o222))refuse('Staged input must be a bounded immutable regular file.');return fs.readFileSync(file,'utf8');
}
function git(repo,args){const result=spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:repo,encoding:'utf8'});if(result.status!==0)refuse(result.stderr.trim()||'Git operation failed.');return result.stdout.trim();}
function rejectHidden(value){if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){if(/^(?:hiddenCases|holdoutCases|scoringRules|goldAnswers|hiddenGold)$/i.test(key))refuse('Hidden evaluation material cannot enter a proposal.');rejectHidden(item);}}
/** @param {{staging:string,repo?:string,branch?:string,dryRun?:boolean}} options */
export function prepareEvolutionPr({staging,repo=process.cwd(),branch,dryRun=false}){
 const stage=path.resolve(staging),manifestText=readImmutable(path.join(stage,'manifest.json')),body=readImmutable(path.join(stage,'pr-body.txt'));
 const manifest=JSON.parse(manifestText),identity=sha(canonicalJson(manifest));
 if(path.basename(stage)!==identity||manifest.schemaVersion!==1||manifest.digest!==`sha256:${sha(canonicalJson(manifest.files??{}))}`||manifest.prBodyDigest!==`sha256:${sha(body)}`)refuse('Proposal identity or immutable hashes do not match.');
 rejectHidden(manifest);
 const files=manifest.files;if(!files||typeof files!=='object'||Array.isArray(files))refuse('Candidate file map is required.');
 for(const [name,content]of Object.entries(files)){if(!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(name)||name.split('/').some(part=>part==='.'||part==='..'||part==='.git')||/(^|\/)(?:paper-gold|candidate-cases|evaluation-control|hidden)(\/|$)/i.test(name)||typeof content!=='string')refuse('Candidate path or hidden evaluator material is refused.');}
 const repository=git(repo,['rev-parse','--show-toplevel']),target=`OpenScience/evals/evolution-proposals/${identity}`,selectedBranch=branch??`evolution/proposal-${identity.slice(0,16)}`;
 git(repository,['check-ref-format','--branch',selectedBranch]);
 const descriptor={identity,branch:selectedBranch,target,reviewOnly:true,body,dryRun};if(dryRun)return descriptor;
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'evimed-evolution-pr-')),worktree=path.join(parent,'worktree');
 git(repository,['worktree','add','-b',selectedBranch,worktree,'HEAD']);
 try{
 const destination=path.join(worktree,target);for(let current=destination;current.startsWith(worktree+path.sep);current=path.dirname(current)){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())refuse('Proposal destination is symlinked.');}fs.mkdirSync(destination,{recursive:true});fs.writeFileSync(path.join(destination,'manifest.json'),canonicalJson(manifest)+'\n',{flag:'wx'});fs.writeFileSync(path.join(destination,'pr-body.txt'),body,{flag:'wx'});
 git(worktree,['add','--',target]);const changed=git(worktree,['diff','--cached','--name-only']).split('\n').filter(Boolean);if(changed.length!==2||changed.some(name=>!name.startsWith(target+'/')))refuse('Proposal exceeds its allowed directory.');
 git(worktree,['commit','-m',`Prepare evolution proposal ${identity.slice(0,16)}`]);return{...descriptor,commit:git(worktree,['rev-parse','HEAD'])};
 }finally{git(repository,['worktree','remove','--force',worktree]);fs.rmSync(parent,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const options={};for(const argument of process.argv.slice(2)){const match=/^--(staging|repo|branch)=(.+)$/.exec(argument);if(match)options[match[1]]=match[2];else if(argument==='--dry-run')options.dryRun=true;else refuse('Usage: open-evolution-pr.mjs --staging=<immutable directory> [--repo=<repository>] [--branch=<name>] [--dry-run]');}if(!options.staging)refuse('An immutable staging directory is required.');process.stdout.write(JSON.stringify(prepareEvolutionPr(options),null,2)+'\n');}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
