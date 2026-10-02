/** Real contained execution boundary. Actor/lease resolver setup is explicitly fixture-only, never serving qualification. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAcceptanceInputs } from './extension-saas-acceptance-inputs.mjs';
import { createHash } from 'node:crypto';
import { ExtensionToolController } from '../../apps/server/src/extensionToolController.mjs';
import { ExtensionResourceResolver } from '../../apps/server/src/extensionResourceResolver.mjs';
import { createNativeValidationFixture } from '../../apps/server/test/helpers/nativeSkillValidationFixture.mjs';
import { createFixtures } from '../runtime/extensions/cowork/fixtures.mjs';
import { createAssessmentDescriptor } from './extension-saas-acceptance-manifest.mjs';
import { assessmentDockerEnvironment, bindAssessmentDockerLauncher } from './extension-saas-acceptance-docker.mjs';
const repo = path.resolve(new URL('../../../', import.meta.url).pathname), hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function runContainedDocumentControls({ image, nativeImage, closureExpectedSHA, integrity, signal = null }) {
  assessmentDockerEnvironment();
  assert.match(image, /^sha256:[a-f0-9]{64}$/); assert.match(nativeImage, /^sha256:[a-f0-9]{64}$/);
  const parent = path.join(repo, '.evimed-local/extensions/build/fixtures'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'saas-contained-')));
  const descriptor = await createAssessmentDescriptor({ imageId: image, closureExpectedSHA, integrity });
  let validator, controller, cleanupFailure = null, failure = null, report;
  try {
    // Reuse the independently reviewed test-only definite missing-bind shim; never retry uncertain create/timeout.
    validator = await createNativeValidationFixture({ dataDir: root, image: nativeImage });
    await bindAssessmentDockerLauncher(path.join(root, 'docker-fixture.mjs'));
    const inputRoot = path.join(root, 'public'), files = await createFixtures(inputRoot), scope = { userId: 'fixture-actor', projectId: 'fixture-project' };
    const resources = new ExtensionResourceResolver({ lookupResource: async (_scope, id) => files[id] ? { ownerId: scope.userId, projectId: scope.projectId,
      relativePath: files[id].file, format: files[id].format, sha256: files[id].sha256, revision: 1 } : null,
    verifyProvenance: async () => ({ revision: 1, dataClass: 'public' }), rootFor: async () => inputRoot, lookupTarget: async () => null });
    const preparation = { jobId: 'fixture-prepare', leaseToken: 'fixture-leased-attempt', attempts: 1, installationId: 'fixture-installation', installationRevision: 1, accountCreatedAt: 'fixture-account-epoch', projectTarget: null };
    let sequence = 0;
    const identity = () => ({ jobId: 'fixture-operation-' + (++sequence), leaseToken: 'fixture-leased-attempt', attempts: 1, operationId: 'fixture-operation',
      ...scope, accountCreatedAt: 'fixture-account-epoch', projectCreatedAt: 'fixture-project-epoch', runtimeGeneration: 'fixture-native-generation',
      extensionGenerationHash: 'a'.repeat(64), descriptorId: descriptor.id, artifactDigest: descriptor.artifactDigest,
      installationId: preparation.installationId, installationRevision: 1 });
    controller = new ExtensionToolController({ admittedDescriptors: [descriptor], stateRoot: path.join(root, 'controller'), inputRoot,
      adapterRoot: path.join(repo, 'OpenScience/scripts/runtime/extensions/cowork'), dockerBin: path.join(root, 'docker-fixture.mjs'),
      resolvePreparation: async (actual, selected) => { assert.deepEqual(actual, preparation); assert.equal(selected.artifactDigest, descriptor.artifactDigest); return { identity: actual, descriptorId: descriptor.id, artifactDigest: descriptor.artifactDigest }; },
      resolveOperation: async (operationId, _request, expected, attempt) => {
        assert.equal(operationId, 'fixture-operation'); assert.equal(expected.descriptorId, descriptor.id); assert.equal(expected.artifactDigest, descriptor.artifactDigest);
        assert.equal(attempt.userId, scope.userId); assert.equal(attempt.projectId, scope.projectId); return { ...attempt };
      }, resolveInputSnapshot: async (_operationId, resourceId) => { const snapshot = await resources.snapshot(scope, resourceId); return { filePath: path.join(inputRoot, files[resourceId].file), format: snapshot.format, dataClass: snapshot.dataClass, bytes: snapshot.bytes.length, sha256: hash(snapshot.bytes) }; } });
    const actualContainers = [], command = controller.command.bind(controller);
    controller.command = async (...args) => {
      const result = await command(...args);
      if (args[0][0] === 'create' && controller.timeoutMs >= 15000) {
        const id = result.stdout.trim(); assert.match(id, /^[a-f0-9]{64}$/);
        const actual = JSON.parse((await command(['inspect', id])).stdout)[0];
        assert.equal(actual.Id, id); assert.equal(actual.Image, image); assert.equal(actual.Config.User, '10001:10001');
        assert.equal(actual.HostConfig.NetworkMode, 'none'); assert.equal(actual.HostConfig.ReadonlyRootfs, true);
        assert.equal(actual.HostConfig.PidsLimit, 64); assert(actual.HostConfig.CapDrop.includes('ALL'));
        assert.equal(actual.Mounts.some(mount => /secrets|credentials|extension-qualification/.test(mount.Source)), false);
        assert.equal(actual.Config.Env.some(item => /(?:API_KEY|PROVIDER_TOKEN|CDSS_API_TOKEN)=/.test(item)), false);
        actualContainers.push({ imageId: actual.Image, user: actual.Config.User, networkMode: actual.HostConfig.NetworkMode, readOnly: actual.HostConfig.ReadonlyRootfs, pidsLimit: actual.HostConfig.PidsLimit, noCredentialMounts: true });
      }
      return result;
    };
    signal?.throwIfAborted();
    const admitted = await controller.prepare({ descriptorId: descriptor.id, identity: preparation }, { signal }); assert.equal(admitted.qualified, false); assert.equal(admitted.artifactDigest, descriptor.artifactDigest);
    const invoke = request => { signal?.throwIfAborted(); return controller.execute({ descriptorId: descriptor.id, operationId: 'fixture-operation', request, identity: identity() }, { signal }); };
    const read = await invoke({ operation: 'doc_read', resourceId: 'res_docx' }); assert(JSON.stringify(read.data).includes('公开文档')); assert.equal(read.physicallyAbsent, true);
    const notebook = await invoke({ operation: 'doc_read', resourceId: 'res_notebook' }); assert(JSON.stringify(notebook.data).includes('must remain inert'));
    const inert = await invoke({ operation: 'doc_write', targetId: 'public_notebook', format: 'ipynb', spec: { kind: 'create', cells: [{ type: 'code', source: 'raise SystemExit("must remain inert")' }] } });
    assert.equal(inert.data.codeExecuted, false); const notebookBytes = JSON.parse(Buffer.from(inert.data.contentBase64, 'base64'));
    assert.equal(notebookBytes.cells[0].execution_count, null); assert.deepEqual(notebookBytes.cells[0].outputs, []);
    await assert.rejects(invoke({ operation: 'doc_read', resourceId: 'res_external' }));
    await assert.rejects(invoke({ operation: 'doc_read', resourceId: 'res_macro' }));
    const created = await invoke({ operation: 'doc_write', targetId: 'public_xlsx', format: 'xlsx', spec: { kind: 'create', sheets: [{ name: '公开', cells: [{ ref: 'A1', value: '实际隔离输出' }] }] } });
    assert.equal(created.data.codeExecuted, false); const bytes = Buffer.from(created.data.contentBase64, 'base64'); assert.equal(hash(bytes), created.data.sha256);
    controller.timeoutMs = 150;
    let timedOutJoined = false;
    await assert.rejects(controller.run(descriptor, identity(), { mounts: [], entrypoint: ['--entrypoint', 'node'], command: ['-e', 'setInterval(()=>{},1000)'] }, null, signal), error => { timedOutJoined = error.joined === true; return timedOutJoined; });
    controller.timeoutMs = 15000;
    const after = await invoke({ operation: 'doc_read', resourceId: 'res_docx' }); assert.equal(after.joined, true); assert.equal(after.physicallyAbsent, true);
    const observations = [
      { caseId: 'SAAS-08', scope: 'actual-immutable-image-public-codec', setup: 'Exact artifact; synthetic actor/lease resolver only; real files/guard/container codec', expected: 'Chinese public documents readable, active/external assets refused, writes inert and hash-bound', actual: { assertions: 8, chineseDocxRead: true, notebookCodeExecuted: inert.data.codeExecuted, externalAssetRefused: true, macrosRefused: true, actualOutputDigest: 'sha256:' + hash(bytes) } },
      { caseId: 'SAAS-16', scope: 'actual-contained-image-inventory', setup: 'Fixture-only authorization setup; no signed qualification receipt', expected: 'External closure+all image file/dir modes/hash bind platform adapter before execution; no provider keys/customer mounts', actual: { assertions: 3 + actualContainers.length * 7, actualContainers, imageInventoryMatched: true, artifactDigest: admitted.artifactDigest, noProviderKeysMounted: true, qualified: admitted.qualified } },
      { caseId: 'SAAS-17', scope: 'actual-physical-deadline-and-next-operation', setup: 'Fixed harmless stalled Node process under the same contained image/lifecycle', expected: 'Deadline joins physical process and frees capacity; following allowed operation succeeds', actual: { assertions: 3, timedOutJoined, subsequentReadSucceeded: after.ok, physicallyAbsent: after.physicallyAbsent } },
    ];
    report = { qualified: false, artifact: descriptor, nativeFixtureImage: nativeImage, observations, cleanup: { physicallyJoined: true },
      limitation: 'Containment/codec boundary only; lease/principal setup is fixture authority, not default hosted grant/proof/auth and not full case qualification.' };
  } catch (error) { failure = error; } finally {
    for (const close of [() => controller?.close(), () => validator?.close()]) { try { await close(); } catch (error) { cleanupFailure = error; } }
    if (!cleanupFailure) await fs.rm(root, { recursive: true, force: true });
  }
  if (cleanupFailure) throw new Error('contained_boundary_cleanup_unconfirmed');
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController(), interrupted = () => abort.abort('assessment_interrupted'); process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
  try {
    const inputs = process.env.EVIMED_EXTENSION_ACCEPTANCE_INPUTS ? await readAcceptanceInputs(process.env.EVIMED_EXTENSION_ACCEPTANCE_INPUTS) : null;
    const result = await runContainedDocumentControls({ image: inputs?.images.coworkImageId ?? process.env.COWORK_TEST_IMAGE, nativeImage: inputs?.images.nativeSdkImageId ?? process.env.NATIVE_SKILL_VALIDATOR_IMAGE,
      closureExpectedSHA: inputs?.artifact.closureExpectedSHA ?? process.env.COWORK_TEST_CLOSURE_SHA256, integrity: inputs?.artifact.integrity ?? process.env.COWORK_TEST_INTEGRITY, signal: abort.signal });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(JSON.stringify({ status: 'failed', qualified: false, code: error?.code ?? error?.name ?? 'contained_boundary_failed' }) + '\n'); process.exitCode = 1; }
  finally { process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted); }
}
