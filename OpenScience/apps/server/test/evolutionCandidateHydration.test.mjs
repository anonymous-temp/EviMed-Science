import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {hydrateCandidateFiles} from '../src/evolutionRuns.mjs';
test('candidate references hydrate complete UTF-8 bytes only from this run deliveries beside its manifest',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'candidate-hydration-'));
 try{
 await mkdir(path.join(root,'out/scripts'),{recursive:true});await writeFile(path.join(root,'out/tool-candidate.json'),'{}');await writeFile(path.join(root,'out/scripts/method.py'),'def method(specification):\n return specification\n');
 const project={workspaceDir:root},run={artifacts:['out/tool-candidate.json','out/scripts/method.py']};
 const legacy={files:{'scripts/method.py':'scripts/method.py'}};
 assert.match((await hydrateCandidateFiles(project,run,legacy)).files['scripts/method.py'],/^def method/);
 const explicit={files:{'SKILL.md':'Inline instructions'},filePaths:{'scripts/method.py':'scripts/method.py'}};
 assert.equal((await hydrateCandidateFiles(project,run,explicit)).files['SKILL.md'],'Inline instructions');
 const inline={files:{'SKILL.md':'Inline instructions'}};assert.strictEqual(await hydrateCandidateFiles(project,run,inline),inline);
 await assert.rejects(hydrateCandidateFiles(project,{artifacts:['out/tool-candidate.json']},legacy));
 await assert.rejects(hydrateCandidateFiles(project,run,{filePaths:{'scripts/method.py':'../outside.py'}}));
 await assert.rejects(hydrateCandidateFiles(project,run,{filePaths:{'scripts/method.py':path.join(os.tmpdir(),'other-workspace/method.py')}}));
 await assert.rejects(hydrateCandidateFiles(project,run,legacy,4));
 await symlink(path.join(root,'out/scripts/method.py'),path.join(root,'out/scripts/link.py'));
 await assert.rejects(hydrateCandidateFiles(project,{artifacts:[...run.artifacts,'out/scripts/link.py']},{filePaths:{'scripts/link.py':'scripts/link.py'}}));
 await writeFile(path.join(root,'out/scripts/method.py'),Buffer.from([0xff]));await assert.rejects(hydrateCandidateFiles(project,run,legacy),/UTF-8/);
 }finally{await rm(root,{recursive:true,force:true});}
});
