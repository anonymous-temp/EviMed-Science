import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { ExtensionOperationService } from '../src/extensionOperationService.mjs';
import { ExtensionOperationWorker } from '../src/extensionOperationWorker.mjs';
const options = {
  skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL
};
async function fixture() {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'op');
  const db = new ControlPlaneDatabase({
    databaseUrl: isolated.url,
    databasePoolMax: 1,
    databaseConnectionTimeoutMs: 500
  });
  try {
    await db.migrate();
    await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development')");
    await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('alice','p','Project',1048576),('bob','p','Other',1048576)");
    const epochs = (await db.query('SELECT id,created_at::text AS epoch FROM evimed_control.users')).rows;
    const epoch = epochs.find(x => x.id === 'alice').epoch,
      projectEpoch = (await db.query("SELECT created_at::text AS epoch FROM evimed_control.projects WHERE user_id='alice' AND id='p'")).rows[0].epoch;
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'extension-operations-')));
    let permitted = true,
      calls = 0,
      absent = true;
    const scope = {
      userId: 'alice',ownerId:'alice',ownerAccountCreatedAt:epoch,membershipEpoch:null,
      projectId: 'p',
      accountCreatedAt: epoch,
      projectCreatedAt: projectEpoch,
      runtimeGeneration: 'r1',
      extensionGenerationHash: 'a'.repeat(64),
      descriptorId: 'cowork',
      artifactDigest: 'sha256:' + 'b'.repeat(64),
      installationId: 'extension:one',
      installationRevision: 1
    };
    const controller = {
      admissionAvailable: async () => true,
      execute: async body => {
        calls++;
        return {
          ok: true,
          data: {
            read: 'bounded',resourceId:body.request.resourceId,inputSha256:createHash('sha256').update('public fixture').digest('hex')
          },
          identity: body.identity,
          joined: true,
          physicallyAbsent: true
        };
      },
      cancelExecution: async identity => ({
        identity,
        joined: absent,
        physicallyAbsent: absent
      }),
      executionStatus: async identity => ({
        identity,
        joined: absent,
        physicallyAbsent: absent
      })
    };
    const service = new ExtensionOperationService({
      database: db,
      dataDir: root,
      signingSecret: 'test-only-long-purpose-bound-secret-string',
      generations: {
        operationIdentity: async () => {
          if (!permitted) throw Object.assign(Error('revoked'), {
            code: 'extension_access_denied'
          });
          return scope;
        }
      },
      resolveInvocation: async identity => ({
        userId: identity.userId,
        projectId: identity.projectId,
        runtimeGeneration: identity.runtimeGeneration,
        invocationId: identity.invocation?.callId ?? 'call-one',
        allowedOperations: ['doc_read']
      }),
      resources: {
        snapshot: async () => ({
          resourceId: 'public_one',
          format: 'pdf',
          dataClass: 'public',
          bytes: Buffer.from('public fixture')
        }),
        publish: async () => ({})
      },
      controller
    });
    const auth = {
      userId: 'alice',ownerId:'alice',ownerAccountCreatedAt:epoch,membershipEpoch:null,
      projectId: 'p',
      runtimeGeneration: 'r1',
      invocation: {
        signed: 'fixture'
      }
    };
    const request = {
      descriptorId: 'cowork',
      idempotencyKey: 'same',
      request: {
        operation: 'doc_read',
        resourceId: 'public_one'
      }
    };
    return {
      db,
      service,
      controller,
      auth,
      request,
      get calls() {
        return calls;
      },
      revoke: () => {
        permitted = false;
      },
      unknown: () => {
        absent = false;
      },
      known: () => {
        absent = true;
      },
      close: async () => {
        await db.close();
        await isolated.drop();
        await fs.rm(root, {
          recursive: true,
          force: true
        });
      }
    };
  } catch (error) {
    await db.close();
    await isolated.drop().catch(() => {});
    throw error;
  }
}
test('real pool1 concurrent admission has one durable job and one execute, replay and body mismatch are bounded', options, async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([f.service.submit(f.auth, f.request), f.service.submit(f.auth, f.request)]);
    assert.equal(a.jobId, b.jobId);
    await assert.rejects(f.service.submit(f.auth, {
      ...f.request,
      request: {
        operation: 'doc_read',
        resourceId: 'another'
      }
    }), {
      code: 'product_job_idempotency_conflict'
    });
    const worker = new ExtensionOperationWorker({
      service: f.service
    });
    await worker.tick();
    await worker.tick();
    assert.equal(f.calls, 1);
    assert.equal((await f.service.status(f.auth, a.jobId)).status, 'succeeded');
  } finally {
    await f.close();
  }
});
test('cross-account and revoked scope cannot hydrate or execute retained operation', options, async () => {
  const f = await fixture();
  try {
    const a = await f.service.submit(f.auth, f.request);
    await assert.rejects(f.service.status({
      ...f.auth,
      userId: 'bob'
    }, a.jobId), {
      status: 404
    });
    f.revoke();
    await new ExtensionOperationWorker({
      service: f.service
    }).tick();
    assert.equal(f.calls, 0);
    assert.equal((await f.service.jobs.get('alice', a.jobId)).status, 'failed');
  } finally {
    await f.close();
  }
});
test('unknown cancellation never terminalizes and restart recovers physical absence without redispatch', options, async () => {
  const f = await fixture();
  try {
    const a = await f.service.submit(f.auth, f.request);
    const job = await f.service.claim('worker-' + randomUUID());
    await f.service.markDispatch(job);
    f.unknown();
    const response = await f.service.cancel(f.auth, a.jobId);
    assert.equal(response.status, 'running');
    assert.equal(response.cancelRequested, true);
    assert.equal((await f.service.jobs.get('alice', a.jobId)).status, 'running');
    await f.service.recover();
    assert.equal(f.calls, 0);
    assert.equal((await f.service.jobs.get('alice', a.jobId)).status, 'running');
  } finally {
    await f.close();
  }
});
test('queued cancel joins no process, never dispatches, and removes only its grant', options, async () => {
  const f = await fixture();
  try {
    const a = await f.service.submit(f.auth, f.request);
    assert.equal((await f.service.cancel(f.auth, a.jobId)).status, 'canceled');
    await new ExtensionOperationWorker({
      service: f.service
    }).tick();
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});
test('finite admission capacity refuses excess and cannot be bypassed by another request key', options, async () => {
  const f = await fixture();
  try {
    f.service.maxUserPending = 1;
    await f.service.submit(f.auth, f.request);
    await assert.rejects(f.service.submit({
      ...f.auth,
      invocation: {
        callId: 'call-two'
      }
    }, {
      ...f.request,
      idempotencyKey: 'second'
    }), {
      code: 'product_state_unavailable'
    });
  } finally {
    await f.close();
  }
});
test('account recreation cannot reuse old operation admission epoch', options, async () => {
  const f = await fixture();
  try {
    await f.db.query("DELETE FROM evimed_control.users WHERE id='alice'");
    await f.db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','New Alice','development')");
    await f.db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('alice','p','New project',1048576)");
    await assert.rejects(f.service.submit(f.auth, f.request), {
      code: 'extension_access_denied'
    });
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});
test('signed operation resolution requires exact live dispatch attempt, never a forged descriptor or lease', options, async () => {
  const f = await fixture();
  try {
    await f.service.submit(f.auth, f.request);
    const job = await f.service.claim('binding-worker'),
      identity = await f.service.markDispatch(job);
    const scope = await f.service.resolveOperation(job.payload.operationId, job.payload.request, {
      descriptorId: 'cowork',
      artifactDigest: identity.artifactDigest
    }, identity);
    assert.equal(scope.userId, 'alice');
    const snapshot=await f.service.resolveInputSnapshot(job.payload.operationId,'public_one',identity);assert.equal(await fs.readFile(snapshot.filePath,'utf8'),'public fixture');
    await assert.rejects(f.service.resolveOperation(job.payload.operationId, job.payload.request, {
      descriptorId: 'foreign'
    }, identity));
    await assert.rejects(f.service.resolveOperation(job.payload.operationId, job.payload.request, {}, {
      ...identity,
      leaseToken: randomUUID()
    }));
  } finally {
    await f.close();
  }
});
test('joined recovery closes only the original dispatch and never repeats a timed-out write', options, async () => {
  const f = await fixture();
  try {
    const admitted = await f.service.submit(f.auth, f.request),
      job = await f.service.claim('recovery-worker');
    await f.service.markDispatch(job);
    await f.service.retain(job, {
      code: 'transport_uncertain'
    });
    f.known();
    await f.service.recover();
    assert.equal((await f.service.jobs.get('alice', admitted.jobId)).status, 'failed');
    assert.equal(f.calls, 0);
    await new ExtensionOperationWorker({
      service: f.service
    }).tick();
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});
test('mismatched physical acknowledgment retains cancellation and reserved capacity', options, async () => {
  const f = await fixture();
  try {
    const admitted = await f.service.submit(f.auth, f.request),
      job = await f.service.claim('mismatch-worker');
    await f.service.markDispatch(job);
    f.controller.cancelExecution = async identity => ({
      identity: {
        ...identity,
        attempts: 99
      },
      joined: true,
      physicallyAbsent: true
    });
    assert.equal((await f.service.cancel(f.auth, admitted.jobId)).status, 'running');
    assert.equal(await f.service.hasUnjoined(), true);
  } finally {
    await f.close();
  }
});
test('finite snapshot storage refuses before grant or durable work creation', options, async () => {
  const f = await fixture();
  try {
    f.service.maxStorageBytes = 100;
    await assert.rejects(f.service.submit(f.auth, f.request), {
      code: 'product_state_unavailable'
    });
    assert.equal((await f.db.query("SELECT count(*)::int AS count FROM evimed_product.jobs WHERE kind='extension-execute'")).rows[0].count, 0);
    assert.deepEqual(await fs.readdir(f.service.dataDir), []);
  } finally {
    await f.close();
  }
});
test('different request keys cannot execute the same trusted native call twice', options, async () => {
  const f = await fixture();
  try {
    const a = await f.service.submit(f.auth, f.request),
      b = await f.service.submit(f.auth, {
        ...f.request,
        idempotencyKey: 'another-key'
      });
    assert.equal(a.jobId, b.jobId);
    await new ExtensionOperationWorker({
      service: f.service
    }).tick();
    assert.equal(f.calls, 1);
  } finally {
    await f.close();
  }
});

test('lease expiry before dispatch fails without inventing a physical joined result', options, async () => {
 const f=await fixture();try{const a=await f.service.submit(f.auth,f.request),job=await f.service.claim('before-dispatch');await f.db.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);await f.service.recover();assert.equal((await f.service.jobs.get('alice',a.jobId)).status,'failed');assert.equal(f.calls,0);}finally{await f.close();}
});

test('revocation after dispatch refuses result hydration without releasing an unjoined operation', options, async () => {
 const f=await fixture();try{const a=await f.service.submit(f.auth,f.request),job=await f.service.claim('revoke-late');const identity=await f.service.markDispatch(job);f.revoke();await assert.rejects(f.service.complete(job,{ok:true,data:{read:'must not publish',resourceId:'public_one',inputSha256:createHash('sha256').update('public fixture').digest('hex')},identity,joined:true,physicallyAbsent:true}));assert.equal((await f.service.jobs.get('alice',a.jobId)).status,'running');assert.equal(await f.service.hasUnjoined(),true);}finally{await f.close();}
});

test('project deletion joins only that project and holds unknown physical work instead of canceling other projects', options, async () => {
  const f=await fixture();
  try {
    const first=await f.service.submit(f.auth,f.request),job=await f.service.jobs.get(f.auth.userId,first.jobId);
    await f.db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('alice','other','Other owned project',1048576)");
    const other=await f.service.jobs.enqueue('alice','extension-execute',{...job.payload,scope:{...job.payload.scope,projectId:'other'}},
      {projectId:'other',idempotencyKey:'other-project-fixture'});
    const claimed=await f.service.claim('project-join-fixture');assert.equal(claimed.id,first.jobId);await f.service.markDispatch(claimed);
    f.unknown();assert.equal(await f.service.joinAccount('alice','p'),false);
    assert.equal((await f.service.jobs.get('alice',first.jobId)).status,'running');
    assert.equal((await f.service.jobs.get('alice',other.id)).status,'queued');
    f.known();
    assert.equal(await f.service.joinAccount('alice','p'),true);
    assert.equal((await f.service.jobs.get('alice',first.jobId)).status,'canceled');
    assert.equal((await f.service.jobs.get('alice',other.id)).status,'queued');
  } finally { await f.close(); }
});

test('maintenance drain refuses new claims while previously dispatched joined work can settle', options, async () => {
  const f=await fixture();
  try {
    const accepted=await f.service.submit(f.auth,f.request),job=await f.service.claim('maintenance-fixture'),identity=await f.service.markDispatch(job);
    await f.db.query("INSERT INTO evimed_product.maintenance_lease(singleton,request_id,requested_at,expires_at,durable_hold) VALUES(true,'drain-fixture',clock_timestamp(),clock_timestamp()+interval '1 minute',false)");
    assert.equal(await f.service.claim('blocked-by-drain'),null);
    const result=await f.controller.execute({request:job.payload.request,identity});await f.service.complete(job,result);
    assert.equal((await f.service.status(f.auth,accepted.jobId)).status,'succeeded');
    await assert.rejects(f.service.submit({...f.auth,invocation:{callId:'new-during-drain'}},{...f.request,idempotencyKey:'new-during-drain'}),{code:'product_state_unavailable'});
  } finally { await f.close(); }
});
