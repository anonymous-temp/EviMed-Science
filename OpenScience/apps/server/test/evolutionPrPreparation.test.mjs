import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {createEvolutionEngineReviewWriter} from '../src/evolutionEngineReview.mjs';
import {prepareEvolutionPr} from '../../../scripts/dev/open-evolution-pr.mjs';
test('operator PR generator commits only review input in a separate branch and never switches caller branch',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'evolution-pr-test-')),repo=path.join(root,'repo'),dataDir=path.join(root,'data');await mkdir(repo);await mkdir(dataDir);
 const git=args=>{const result=spawnSync('git',args,{cwd:repo,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
 try{
 git(['init','-b','main']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);await writeFile(path.join(repo,'baseline.txt'),'baseline');git(['add','.']);git(['commit','-m','Baseline']);const head=git(['rev-parse','HEAD']);
 const files={'SKILL.md':'Review only','scripts/proposal.py':'raise RuntimeError("Must never execute")'},digest='sha256:'+createHash('sha256').update(canonicalJson(files)).digest('hex');
 const descriptor=await createEvolutionEngineReviewWriter({dataDir})({card:{id:'card'},candidate:{id:'candidate',files},digest}),staging=path.join(dataDir,descriptor.relativeDirectory);
 assert.ok(descriptor.prepareCommand.includes('--dry-run'));
 const dry=prepareEvolutionPr({repo,staging,dryRun:true});assert.equal(dry.reviewOnly,true);assert.equal(git(['branch','--list',dry.branch]),'');
 const prepared=prepareEvolutionPr({repo,staging});assert.equal(git(['branch','--show-current']),'main');assert.equal(git(['rev-parse','HEAD']),head);assert.equal(git(['status','--porcelain']),'');
 assert.deepEqual(git(['diff','--name-only',head,prepared.commit]).split('\n').sort(),[prepared.target+'/manifest.json',prepared.target+'/pr-body.txt']);assert.equal(git(['worktree','list','--porcelain']).split('worktree ').length,2);
 for(const unsafeFiles of [{'../escape.py':'code'},{'paper-gold/hidden.json':'gold'}]){const unsafeDigest='sha256:'+createHash('sha256').update(canonicalJson(unsafeFiles)).digest('hex');const unsafe=await createEvolutionEngineReviewWriter({dataDir})({card:{id:'unsafe'},candidate:{files:unsafeFiles},digest:unsafeDigest});assert.throws(()=>prepareEvolutionPr({repo,staging:path.join(dataDir,unsafe.relativeDirectory),dryRun:true}),/refused/);}
 const manifestFile=path.join(staging,'manifest.json');await chmod(manifestFile,0o644);await writeFile(manifestFile,(await readFile(manifestFile,'utf8')).replace('Review only','Changed'));await chmod(manifestFile,0o444);assert.throws(()=>prepareEvolutionPr({repo,staging,dryRun:true}),/hashes/);
 }finally{await rm(root,{recursive:true,force:true});}
});
