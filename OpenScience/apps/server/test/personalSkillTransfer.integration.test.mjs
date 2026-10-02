import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parsePersonalSkill } from '@evimed/harness-port';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { SkillLibraryService } from '../src/skillLibraryService.mjs';
import { SkillLibraryArtifacts } from '../src/skillLibraryArtifacts.mjs';
import { PersonalSkillTransfer, exportPersonalSkills } from '../src/personalSkillTransfer.mjs';
import { createNativeValidationFixture } from './helpers/nativeSkillValidationFixture.mjs';
import { decodeSkillArchive } from '../src/skillArchive.mjs';
import { exportExtensionAccountRow } from '../src/extensionAccountExport.mjs';
import tar from 'tar-stream';
import { gzipSync } from 'node:zlib';

async function accountArchive(state){const pack=tar.pack(),chunks=[];pack.on('data',chunk=>chunks.push(chunk));const done=new Promise((resolve,reject)=>{pack.on('end',resolve);pack.on('error',reject);});
  await new Promise((resolve,reject)=>pack.entry({name:'account/customer-state.json'},Buffer.from(JSON.stringify(state)),error=>error?reject(error):resolve()));pack.finalize();await done;return gzipSync(Buffer.concat(chunks));}

test('real pool1 transfer preserves authored histories and bytes across owners, resumes once, and restores no project authority',
  { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, timeout: 60000 }, async () => {
    const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'pst');
    let database, root, dataDir, validator;
    try {
      database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 });
      await database.migrate();
      await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Source','development'),('bob','Recipient','development')");
      const rows = (await database.query('SELECT id,created_at::text AS "accountCreatedAt" FROM evimed_control.users')).rows;
      const alice = rows.find(row => row.id === 'alice'), bob = rows.find(row => row.id === 'bob');
      const image=process.env.NATIVE_SKILL_VALIDATOR_IMAGE;
      const base=image?new URL('../../../../.evimed-local/extensions/build/fixtures/',import.meta.url).pathname:os.tmpdir();
      await fs.mkdir(base,{recursive:true});dataDir=await fs.realpath(await fs.mkdtemp(path.join(base,'evimed-skill-transfer-')));
      root=path.join(dataDir,'.openscience','skill-library');await fs.mkdir(root,{recursive:true});
      if(image)validator=await createNativeValidationFixture({dataDir,image});
      const parser=validator?async(absolute,options)=>{const parts=path.relative(root,absolute).split(path.sep);return validator.validate({ownerHash:parts[0],kind:parts[1],contentId:parts[2],expectedName:options.expectedName??null});}:parsePersonalSkill;
      const artifacts = new SkillLibraryArtifacts({ root, parseSkill: parser, decodeArchive: decodeSkillArchive, minFreeBytes: 0 });
      const skills = new SkillLibraryService(database, { artifacts }), transfer = new PersonalSkillTransfer({ skills, artifacts });
      const bytes = Buffer.from('Original resource 原始资料'), hex = createHash('sha256').update(bytes).digest('hex');
      const resource = { path: 'references/原始资料.txt', id: 'resource:' + hex, digest: 'sha256:' + hex, size: bytes.length };
      await skills.withLibraryAccount(alice, () => artifacts.publish(alice, path.join('blobs', hex), bytes));
      const source = await skills.saveContent(alice, 'skill:source-fixture', { expectedRevision: 0, title: 'Review', description: 'Read evidence', instructions: 'Read the supplied source.' }, [resource],
        { invocation: { userInvocable: false, modelInvocable: false }, metadata: { provenance: 'authored' }, whenToUse: 'When a source is supplied.' });
      await skills.update(alice, source.id, { expectedRevision: 1, title: 'Review revised', description: 'Read evidence', instructions: 'Read and compare the supplied sources.' });
      const exported = await exportPersonalSkills({ skills, artifacts }, alice, [source.id]);
      const upload = await transfer.upload(bob, exported, 'portable');
      const preview = await transfer.preview(bob, { reference: upload.reference });
      assert.equal(preview.nativeValidation, 'pending'); assert.equal(preview.skills[0].revisions, 2);
      assert.equal((await skills.list(bob)).items.length, 0);
      await assert.rejects(transfer.preview(alice, { reference: upload.reference }));
      const input = { reference: upload.reference, idempotencyKey: 'one-confirmation' };
      const nativeParser=artifacts.parseSkill;artifacts.parseSkill=async()=>{throw new Error('Fixture transient native validation failure');};
      await assert.rejects(transfer.confirm(bob,input));
      const paused=(await transfer.pending(bob)).items[0];assert.equal(paused.mappings[0].imported,0);
      const reservedTarget=paused.mappings[0].targetId;artifacts.parseSkill=nativeParser;
      const first = await transfer.confirm(bob, input); assert.equal(first.status, 'in-progress');
      assert.equal(first.mappings[0].targetId,reservedTarget);
      const resumed = new PersonalSkillTransfer({ skills, artifacts });
      const pending = await resumed.pending(bob); assert.equal(pending.items[0].idempotencyKey, input.idempotencyKey);
      assert.equal(pending.items[0].mappings[0].imported, 1); assert.equal((await resumed.pending(alice)).items.length, 0);
      const final = await transfer.confirm(bob, input); assert.equal(final.status, 'complete'); assert.equal(final.activation, false);
      assert.equal((await resumed.pending(bob)).items.length, 0);
      assert.deepEqual(await transfer.confirm(bob, input), final);
      const target = await skills.get(bob, final.mappings[0].targetId);
      assert.notEqual(target.id, source.id); assert.notEqual(target.payload.nativeName, source.payload.nativeName);
      assert.equal(target.revision, 2); assert.equal(target.payload.invocation.modelInvocable, false);
      assert.equal((await skills.history(bob, target.id)).length, 2);
      assert.deepEqual(await artifacts.resourceBytes(bob, target.payload.resources[0]), bytes);
      assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_product.documents WHERE user_id='bob' AND kind='extension-defaults'")).rows[0].n, 0);
      const portable=JSON.parse(exported),currentAlice=await skills.get(alice,source.id);
      const state={version:1,account:{id:alice.id},documents:[exportExtensionAccountRow({...currentAlice,kind:'skill'})],
        revisions:(await skills.history(alice,source.id)).map(row=>exportExtensionAccountRow({...row,id:source.id,kind:'skill'})),
        personalSkillResources:portable.resources.map(resource=>({...resource,id:'resource:'+resource.digest.slice(7)}))};
      const accountUpload=await transfer.upload(bob,await accountArchive(state),'account');assert.equal(accountUpload.sourceSkills[0].sourceId,source.id);
      const accountInput={reference:accountUpload.reference,sourceSkillIds:[source.id],idempotencyKey:'selected-account-data'};
      assert.equal((await transfer.preview(bob,{reference:accountInput.reference,sourceSkillIds:accountInput.sourceSkillIds})).skills.length,1);
      await transfer.confirm(bob,accountInput);const accountDone=await transfer.confirm(bob,accountInput);assert.equal(accountDone.status,'complete');
      assert.notEqual(accountDone.mappings[0].targetId,target.id);assert.equal(accountDone.activation,false);
      const changed = JSON.parse(exported); changed.skills[0].revisions[0].title = 'Changed source';
      const other = await transfer.upload(bob, Buffer.from(JSON.stringify(changed)), 'portable');
      await assert.rejects(transfer.confirm(bob, { ...input, reference: other.reference }), { code: 'product_job_idempotency_conflict' });
      if(process.env.PERSONAL_SKILL_REPOSITORY_ARCHIVE){
        const archive=await fs.readFile(process.env.PERSONAL_SKILL_REPOSITORY_ARCHIVE),before=(await skills.list(alice)).items.length;
        const sourceReceipt=JSON.parse(await fs.readFile(path.join(path.dirname(process.env.PERSONAL_SKILL_REPOSITORY_ARCHIVE),'receipt.json'),'utf8'));
        assert.equal(createHash('sha256').update(archive).digest('hex'),sourceReceipt.archiveSHA256);
        const staged=await skills.upload(alice,'zip',archive),nativePreview=await skills.previewImport(alice,{resourceId:staged.resourceId});
        assert(nativePreview.instructions.length>0);assert.equal((await skills.list(alice)).items.length,before);
        const adopted=await skills.import(alice,{resourceId:staged.resourceId,title:'Fixed public repository acceptance'});
        assert.match(adopted.payload.nativeName,/^personal-/);assert.equal(adopted.payload.instructions,nativePreview.instructions);
        assert.equal((await skills.history(alice,adopted.id)).length,1);
      }
      await database.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id='bob'");
      await assert.rejects(transfer.confirm(bob, input), { code: 'unauthorized' });
    } finally { let failure;try{await validator?.close();}catch(error){failure=error;}finally{await database?.close();await isolated.drop();if(dataDir&&!failure)await fs.rm(dataDir,{recursive:true,force:true});}if(failure)throw failure; }
  });
