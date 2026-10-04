import {containedExtensionDescriptor} from './helpers/containedExtensionFixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EXTENSION_SAAS_CASE_IDS, extensionProofDigest } from '@evimed/domain';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { createControllerExtensionComposition } from '../src/extensionControllerComposition.mjs';
import { currentExtensionSourcePolicy, loadExtensionDeployment, deploymentGenerationIdentities, deploymentProofIdentity } from '../src/extensionDeployment.mjs';
import { ExtensionQualification } from '../src/extensionQualification.mjs';
import { ExtensionService } from '../src/extensionService.mjs';
import { ExtensionAccess } from '../src/extensionAccess.mjs';
import { PluginService } from '../src/pluginService.mjs';
import { ExtensionGenerationService } from '../src/extensionGenerationService.mjs';
import { ExtensionOperationService } from '../src/extensionOperationService.mjs';
import { ExtensionOperationWorker } from '../src/extensionOperationWorker.mjs';
import { ExtensionResourceResolver } from '../src/extensionResourceResolver.mjs';
import { createFixtures } from '../../../scripts/runtime/extensions/cowork/fixtures.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
let image = process.env.COWORK_TEST_IMAGE;
const baseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
test('default controller composition independently validates actual ledger/grants/generation/proof and executes joined public documents', {
  skip: (!image && !process.env.EVIMED_EXTENSION_ACCEPTANCE_INPUTS) || !baseUrl,
  timeout: 60000
}, async () => {
  // The receipt and runtime/invocation stamp are synthetic authorization controls ONLY.
  // The factory, signed state, PostgreSQL identities, immutable manifest, and Docker IO are actual.
  // This portable image has no DSH kernel: this test certifies no package or SaaS deployment.
  const repo = new URL('../../../../', import.meta.url).pathname,
    fixtureParent = path.join(repo, '.evimed-local/extensions/build/fixtures');
  await fs.mkdir(fixtureParent, {
    recursive: true
  });
  const root = await fs.realpath(await fs.mkdtemp(path.join(fixtureParent, 'composition-')));
  const isolated = await createGeoTestDatabase(baseUrl, 'cc');
  let db, composition;
  try {
    db = new ControlPlaneDatabase({
      databaseUrl: isolated.url,
      databasePoolMax: 1,
      databaseConnectionTimeoutMs: 1000
    });
    await db.migrate();
    await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Factory fixture','development'),('stranger','Unrelated fixture','development')");
    await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('alice','p','Factory fixture',1048576),('stranger','p','Other',1048576)");
    const account = (await db.query("SELECT created_at::text AS epoch FROM evimed_control.users WHERE id='alice'")).rows[0].epoch;
    const user = {
        id: 'alice',
        accountCreatedAt: account
      },
      publicRoot = path.join(root, 'public'),
      project = {
        userId: 'alice',
        id: 'p',
        baseDir: publicRoot
      };
    const resources = await createFixtures(publicRoot);
    const descriptor = await containedExtensionDescriptor();
    image = descriptor.imageId;
    const entry = {
      id: descriptor.id,
      title: 'Synthetic factory authority control',
      coordinate: descriptor.coordinate,
      executionClass: 'isolated-tool',
      integrity: descriptor.integrity,
      settingsSchema: {}
    };
    const artifact = {
      id: entry.id,
      coordinate: entry.coordinate,
      integrity: entry.integrity,
      artifactDigest: descriptor.artifactDigest,
      adapterRevision: descriptor.adapterDigest,
      suiteRevision: 'sha256:' + hash('synthetic-local-control-suite')
    };
    const surface = {
      id: entry.id,
      client: false,
      browser: false,
      externalActions: false,
      descriptorDigest: 'sha256:' + hash('synthetic-local-control-surfaces')
    };
    const config = {
      dataDir: root,
      databaseUrl: isolated.url,
      runtimeContainerBin: 'docker',
      runtimeContainerImage: image,
      modelGatewaySigningSecret: 'test-only-synthetic-factory-key-not-production-authority'
    };
    const parent = path.join(root, '.openscience');
    await fs.mkdir(parent, {
      mode: 0o700
    });
    await fs.writeFile(path.join(parent, 'extensions-deployment.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-10-02T00:00:00.000Z',
      dshVersion: '0.1.7-rc.2',
      policy: currentExtensionSourcePolicy(),
      catalogue: [entry],
      admittedArtifacts: [artifact],
      admittedDescriptors: [descriptor],
      surfaces: [surface]
    }), {
      mode: 0o400
    });
    const deployment = loadExtensionDeployment(config);
    assert.equal(deployment.status, 'configured');
    const proofIdentity = deploymentProofIdentity(deployment, entry, image),
      receipt = {
        schemaVersion: 1,
        identity: proofIdentity,
        cases: EXTENSION_SAAS_CASE_IDS.map(caseId => ({
          caseId,
          status: 'pass',
          observationDigests: ['sha256:' + hash('synthetic-control-' + caseId)],
          artifactDigests: [descriptor.artifactDigest]
        }))
      };
    receipt.receiptDigest = extensionProofDigest(receipt, hash);
    const qualification = new ExtensionQualification({
      root: deployment.qualificationRoot,
      secret: config.modelGatewaySigningSecret,
      currentIdentity: async () => proofIdentity,
      surfaces: () => deployment.surfaces.get(entry.id)
    });
    await fs.mkdir(deployment.qualificationRoot, {
      mode: 0o700
    });
    const envelope = {
      schemaVersion: 1,
      catalogueId: entry.id,
      receipt,
      surfaces: deployment.surfaces.get(entry.id)
    };
    await fs.writeFile(path.join(deployment.qualificationRoot, hash(entry.id) + '.json'), JSON.stringify({
      body: envelope,
      signature: qualification.signature(envelope)
    }), {
      mode: 0o400
    });
    const store = {
      requireProject: async (actor, id) => {
        if (actor.id !== 'alice' || id !== 'p') throw Object.assign(Error('unowned'), {
          status: 404
        });
        return project;
      }
    };
    const access = new ExtensionAccess({
        store
      }),
      extensions = new ExtensionService(db, {
        catalogue: [entry],
        access
      }),
      plugins = new PluginService(db);
    composition = createControllerExtensionComposition({
      config,
      deployment,
      database: db
    });
    assert.ok(composition);
    const installed = await extensions.install(user, {
      coordinate: entry.coordinate,
      scope: 'project',
      projectId: 'p',
      idempotencyKey: 'factory-install'
    });
    const preparation = await extensions.jobs.claim(['extension-prepare'], 'fixture-preparation');
    assert.equal(preparation.id, installed.job.id);
    const prepared = await composition.tools.prepare({
      descriptorId: entry.id,
      identity: {
        jobId: preparation.id,
        leaseToken: preparation.leaseToken,
        attempts: preparation.attempts,
        installationId: installed.installation.id,
        installationRevision: 1,
        accountCreatedAt: account,
        projectTarget: preparation.payload.projectTarget
      }
    });
    await extensions.jobs.finish(user.id, preparation.id, preparation.leaseToken, {
      ...prepared,
      installationId: installed.installation.id,
      installationRevision: 1
    });
    const desired = await extensions.project(user, 'p');
    const selected = await extensions.saveProject(user, 'p', {
      expectedRevision: desired.revision,
      selections: [{
        installationId: installed.installation.id,
        enabled: true,
        settings: {},
        connectionRefs: []
      }]
    });
    const generations = new ExtensionGenerationService(db, {
      config: {
        dataDir: root,
        skillArtifactsRoot: path.join(root, '.openscience/skill-library'),
        maxGlobalBytes: 64 * 1024 * 1024,
        maxOwnerBytes: 16 * 1024 * 1024,
        minFreeBytes: 1
      },
      extensionService: extensions,
      pluginService: plugins,
      admittedArtifacts: [artifact],
      identities: async () => deploymentGenerationIdentities(deployment, image),
      proofAuthority: ({
        entry,
        identity
      }) => qualification.authority(entry, {
        identity
      })
    });
    const state = await generations.reconcile(user, 'p', {
        expectedRevision: selected.revision
      }),
      candidate = state.payload.desired;
    assert.equal(candidate.projection.plugins.length, 2);
    await db.transaction(client => db.withTransactionClient(client, () => generations.markEffective(project, candidate, {
      runtimeGeneration: 'synthetic-factory-runtime'
    }, client)));
    const resolver = new ExtensionResourceResolver({
      lookupResource: async (_scope, id) => resources[id] ? {
        ownerId: 'alice',
        projectId: 'p',
        revision: 1,
        relativePath: resources[id].file,
        format: resources[id].format,
        sha256: resources[id].sha256
      } : null,
      verifyProvenance: async () => ({
        revision: 1,
        dataClass: 'public'
      }),
      rootFor: async () => publicRoot,
      lookupTarget: async (_scope, id) => id === 'result_xlsx' ? {
        ownerId: 'alice',
        projectId: 'p',
        revision: 1,
        format: 'xlsx',
        relativePath: 'outputs/extensions/result_xlsx.xlsx'
      } : null,
      maxProjectBytes: 1048576
    });
    const service = new ExtensionOperationService({
        database: db,
        dataDir: root,
        signingSecret: config.modelGatewaySigningSecret,
        generations,
        controller: composition.tools,
        resources: resolver,
        resolveInvocation: async (auth, _invocation, request) => ({
          userId: auth.userId,
          projectId: auth.projectId,
          runtimeGeneration: auth.runtimeGeneration,
          invocationId: auth.invocation,
          allowedOperations: [request.operation]
        })
      }),
      worker = new ExtensionOperationWorker({
        service
      });
    const auth = {
        userId: 'alice',
        projectId: 'p',
        runtimeGeneration: 'synthetic-factory-runtime',
        invocation: 'read-one'
      },
      readRequest = {
        descriptorId: entry.id,
        idempotencyKey: 'read-one',
        request: {
          operation: 'doc_read',
          resourceId: 'res_docx'
        }
      };
    const read = await service.submit(auth, readRequest);
    await worker.tick();
    const result = await service.status(auth, read.jobId);
    assert.equal(result.status, 'succeeded');
    assert(JSON.stringify(result.result).includes('公开文档'));
    const write = await service.submit({
      ...auth,
      invocation: 'write-one'
    }, {
      descriptorId: entry.id,
      idempotencyKey: 'write-one',
      request: {
        operation: 'doc_write',
        targetId: 'result_xlsx',
        format: 'xlsx',
        spec: {
          kind: 'create',
          sheets: [{
            name: 'Public',
            cells: [{
              ref: 'A1',
              value: '公开工厂控制'
            }]
          }]
        }
      }
    });
    await worker.tick();
    const output = await service.status({
      ...auth,
      invocation: 'write-one'
    }, write.jobId);
    assert.equal(output.status, 'succeeded');
    assert.equal(output.result.artifactPath, 'outputs/extensions/result_xlsx.xlsx');
    assert.equal(hash(await fs.readFile(path.join(publicRoot, output.result.artifactPath))), output.result.sha256);
    // The qualification record is a label (owner ruling 2026-10-04). With it gone neither the web side's per-operation
    // check nor the controller's `authorize` refuses an admitted, pinned extension under a live grant; before, the
    // controller re-read the signed record and answered 403 `extension_access_denied` for a missing or changed one.
    await fs.rm(path.join(deployment.qualificationRoot, hash(entry.id) + '.json'));
    const unlabelled = {
      ...auth,
      invocation: 'read-without-record'
    };
    const withoutRecord = await service.submit(unlabelled, {
      ...readRequest,
      idempotencyKey: 'read-without-record'
    });
    await worker.tick();
    const withoutRecordResult = await service.status(unlabelled, withoutRecord.jobId);
    assert.equal(withoutRecordResult.status, 'succeeded');
    assert(JSON.stringify(withoutRecordResult.result).includes('公开文档'));
    const rejectAttempt = async (key, mutate) => {
      const actor = {
        ...auth,
        invocation: key
      };
      await service.submit(actor, {
        ...readRequest,
        idempotencyKey: key
      });
      const job = await service.claim(key),
        identity = await service.markDispatch(job);
      await mutate(job);
      await assert.rejects(composition.tools.execute({
        descriptorId: entry.id,
        operationId: job.payload.operationId,
        request: job.payload.request,
        identity
      }));
      const ack = await composition.tools.cancelExecution(identity);
      assert.equal(ack.joined, true);
      assert.equal(ack.physicallyAbsent, true);
      assert.deepEqual(ack.identity, identity);
      await service.jobs.cancel('alice', job.id);
      await service.grants.remove(job.payload.operationId);
    };
    await rejectAttempt('expired-lease', job => db.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]));
    await rejectAttempt('changed-dispatch', job => db.query("UPDATE evimed_product.jobs SET payload=jsonb_set(payload,'{dispatch,installationRevision}','99') WHERE id=$1", [job.id]));
    await assert.rejects(service.status({
      ...auth,
      userId: 'stranger'
    }, read.jobId), {
      status: 404
    });
    await rejectAttempt('changed-account-epoch', () => db.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id='alice'"));
    assert.equal(await service.hasUnjoined(), false);
    assert.equal(await composition.tools.admissionAvailable(), true);
  } finally {
    await composition?.close();
    await db?.close();
    await isolated.drop();
    await fs.rm(root, {
      recursive: true,
      force: true
    });
  }
});
