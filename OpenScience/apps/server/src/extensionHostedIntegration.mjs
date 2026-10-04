import path from 'node:path';
import { canonicalJson } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { deploymentGenerationIdentities, deploymentProofIdentity } from './extensionDeployment.mjs';
import { ExtensionQualification } from './extensionQualification.mjs';
import { ExtensionGenerationService, extensionMountIdentity } from './extensionGenerationService.mjs';
import { ExtensionGenerationWorker } from './extensionGenerationWorker.mjs';
import { ExtensionPreparationWorker } from './extensionPreparationWorker.mjs';
import { ExtensionOperationService } from './extensionOperationService.mjs';
import { ExtensionOperationWorker } from './extensionOperationWorker.mjs';
import { ExtensionDocumentResources } from './extensionDocumentResources.mjs';
import { createExtensionGatewayHandler, createExtensionInvocationResolver } from './extensionGateway.mjs';
import { createExtensionInvocationLookup } from './extensionInvocationLookup.mjs';
import { ExtensionActorBindings } from './extensionActorBindings.mjs';

/** Compose existing metadata, jobs, native generation and contained operations.
 * The deployment manifest is protected local state, never a customer body.
 * @param {{config:any,database:any,store:any,agentRuns:any,runtimeManager:any,controller:any,extensions:any,plugins:any,pluginWorker:any,deployment:any,resolveProject:any,audit:any}} dependencies */
export function createHostedExtensionIntegration({ config, database, store, agentRuns, runtimeManager, controller,
  extensions, plugins, pluginWorker, deployment, resolveProject, audit }) {
  const currentIdentity = async () => {
    const image = await runtimeManager.inspectRuntimeImage();
    return deploymentGenerationIdentities(deployment, image.imageId);
  };
  const qualification = new ExtensionQualification({ root: deployment.qualificationRoot, secret: config.modelGatewaySigningSecret,
    currentIdentity: async entry => {
      const current = await currentIdentity();
      return deploymentProofIdentity(deployment, entry, current.baseRuntimeImageDigest);
    }, surfaces: entry => deployment.surfaces.get(entry.id),
  });
  const generations = new ExtensionGenerationService(database, {
    config: { dataDir: config.dataDir, skillArtifactsRoot: path.join(config.dataDir, '.openscience', 'skill-library'),
      maxGlobalBytes: 1024 * 1024 * 1024, maxOwnerBytes: 256 * 1024 * 1024, minFreeBytes: 512 * 1024 * 1024 },
    extensionService: extensions, pluginService: plugins, admittedArtifacts: deployment.admittedArtifacts,
    identities: currentIdentity, proofAuthority: ({ entry, identity }) => qualification.authority(entry, { identity }),
  });
  extensions.proofAuthority = entry => qualification.authority(entry);
  return composeExtensionExecution({config,database,store,agentRuns,runtimeManager,controller,extensions,plugins,pluginWorker,deployment,resolveProject,audit},{qualification,generations});
}
/** Shared execution composition; metadata always uses the genuine qualification reader.
 * @param {any} dependencies @param {{qualification:any,generations:any}} services */
export function composeExtensionExecution({config,database,store,agentRuns,runtimeManager,controller,extensions,pluginWorker,deployment,resolveProject,audit},{qualification,generations}) {
  extensions.proofAuthority = entry => qualification.authority(entry);
  runtimeManager.extensionArtifacts = new Map(deployment.admittedDescriptors.map(item => [item.id, item]));
  runtimeManager.extensionGenerationResolver = async project => {
    const state = await generations.current(project), candidate = state?.payload.effective;
    if (!candidate) return null;
    try {
      const terminalKnownRuntime = state.payload.phase === 'failed' && state.payload.terminalApplyFailure?.preservedRuntime === true
        && canonicalJson(state.payload.terminalApplyFailure.reference) === canonicalJson(state.payload.desired?.reference ?? null);
      if (!['effective', 'rolled-back'].includes(state.payload.phase) && !terminalKnownRuntime) return null;
      if (state.payload.phase !== 'rolled-back' && !terminalKnownRuntime) {
        const actual = await database.transaction(client => database.withTransactionClient(client,
          () => generations.snapshot({ id: candidate.scope.actorId, accountCreatedAt: candidate.scope.actorAccountCreatedAt }, project.id, client)));
        // What is mounted is compared, not the evidence it was assembled under: a release that moves the adapter or
        // permission source revisions, or a re-measured qualification, must not unmount an extension that is still
        // exactly what the project selected (owner ruling 2026-10-04).
        return extensionMountIdentity(actual.manifest) === extensionMountIdentity(candidate) ? candidate : null;
      }
      // A terminal rollback keeps the observed last-good runtime usable for
      // ordinary research. This is availability, never operation authority:
      // every tool still checks current selection, caller grants and proof.
      const installed = runtimeManager.currentGeneration(project);
      if (!state.payload.lastGood
        || canonicalJson(state.payload.lastGood.reference) !== canonicalJson(candidate.reference)
        || canonicalJson(installed?.reference ?? null) !== canonicalJson(candidate.reference)
        || state.payload.runtimeGeneration !== runtimeManager.runtimeGeneration(project)) return null;
      const baseline = await database.transaction(client => database.withTransactionClient(client,
        () => generations.ordinaryRuntimeBaseline(project, client)));
      if (candidate.scope.ownerId !== project.userId || candidate.scope.projectId !== project.id
        || candidate.scope.ownerAccountCreatedAt !== baseline.owner.accountCreatedAt || candidate.scope.projectCreatedAt !== baseline.owner.projectCreatedAt
        || baseline.identity.baseRuntimeImageDigest !== candidate.identity.baseRuntimeImageDigest
        || canonicalJson(baseline.personal) !== canonicalJson(candidate.projection.personal)
        || canonicalJson([baseline.legacy]) !== canonicalJson(candidate.projection.plugins.filter(plugin => plugin.compatibility === 'legacy-citation-v1'))) return null;
      await generations.verifyManifest(project, candidate.reference);
      return candidate;
    } catch (error) {
      await audit('extension.generation.cold', 'refused', { userId: project.userId, projectId: project.id, code: error?.code ?? 'product_state_unavailable' });
      return null;
    }
  };
  const apply = new ExtensionGenerationWorker({ service: generations, runtime: runtimeManager, resolveProject,
    ledgerBusy: async project => (await agentRuns.activeRuns(project)).length > 0 });
  pluginWorker.generationWorker = apply;
  const preparation = new ExtensionPreparationWorker({ service: extensions, controller, admittedArtifacts: deployment.admittedArtifacts,
    onPrepared: async job => {
      const selected = await database.query(`SELECT project_id FROM evimed_product.documents WHERE kind='extension-defaults'
        AND id LIKE 'extensions:project:%' AND deleted_at IS NULL
        AND payload->'selections' @> $1::jsonb ORDER BY user_id,project_id LIMIT 101`, [JSON.stringify([{ installationId: job.payload.installationId, actorId: job.userId }])]);
      if (selected.rows.length > 100) throw new HttpError(413, 'project_scan_too_large', 'Too many projects select this extension.');
      for (const row of selected.rows) await reconcile({ id: job.userId, accountCreatedAt: job.payload.accountCreatedAt }, row.project_id);
    },
  });
  extensions.cancelPreparation = identity => controller.cancelPreparation(identity);
  const documents = new ExtensionDocumentResources({ config, database, store, access: extensions.access,
    resolveGeneration: principal => {
      const descriptor = deployment.admittedDescriptors.find(item => item.coordinate.repository === 'Jesse-njx/dsh-cowork');
      if (!descriptor) throw new HttpError(503, 'product_state_unavailable', 'The document extension is unavailable.');
      return generations.operationIdentity({ id: principal.userId }, principal.projectId, descriptor.id, principal.jti);
    },
  });
  const actors = new ExtensionActorBindings({ database, access: extensions.access, runtimeManager, secret: config.modelGatewaySigningSecret });
  const operations = new ExtensionOperationService({ database, dataDir: config.dataDir, signingSecret: config.modelGatewaySigningSecret,
    generations, controller, resources: documents.resolver,
    resolveInvocation: createExtensionInvocationResolver({ lookup: createExtensionInvocationLookup({ store, runtimeManager,
      resolveActor: (auth, invocation, message, transcript) => actors.resolve(auth, invocation, message, transcript) }) }),
  });
  const worker = new ExtensionOperationWorker({ service: operations });
  const gateway = createExtensionGatewayHandler({ runtimeManager, service: operations });
  /** Only unchanged desired intent is reconciled; native jobs keep their own revision/lease proof. */
  const reconcile = async (user, projectId) => {
    const desired = await extensions.project(user, projectId);
    return generations.reconcile(user, projectId, { expectedRevision: desired.revision });
  };
  const projectState = async (user, projectId, view) => {
    const project = await extensions.access.project(user, projectId), state = await generations.current(project), candidate = state?.payload.effective;
    const actual = runtimeManager.currentGeneration(project);
    if (!candidate || !actual || state.payload.runtimeGeneration !== runtimeManager.runtimeGeneration(project)
      || canonicalJson(candidate.reference) !== canonicalJson(actual.reference)) return view;
    const selections = [];
    for (const selection of view.selections) {
      const pin = candidate.projection.plugins.find(item => item.extensionId === selection.catalogueId && item.enabled
        && item.integrity === selection.integrity && item.configRevision === view.revision);
      let effective = false;
      if (pin && selection.enabled) {
        try { await generations.operationIdentity(user, projectId, pin.extensionId, state.payload.runtimeGeneration); effective = true; }
        catch { /* The saved intent remains visible; stale runtime authority never becomes an effective claim. */ }
      }
      selections.push({ ...selection, effective, phase: effective ? 'effective' : selection.phase });
    }
    return { ...view, selections, effectiveGeneration: selections.some(item => item.effective) ? candidate.reference.generationHash : null };
  };
  const joinAccount = async (userId, projectId = null) => {
    if (!await operations.joinAccount(userId, projectId)) return false;
    const jobs = (await database.query("SELECT id,status FROM evimed_product.jobs WHERE user_id=$1 AND ($2::text IS NULL OR payload->'projectTarget'->>'projectId'=$2) AND kind='extension-prepare' AND status IN ('queued','running') ORDER BY id", [userId, projectId])).rows;
    for (const job of jobs) {
      try { await extensions.cancelJob({ id: userId }, job.id); } catch { return false; }
    }
    return true;
  };
  return { qualification, generations, preparation, documents, actors, operations, worker, gateway, reconcile, projectState, joinAccount,
    joinProject: (userId, projectId) => joinAccount(userId, projectId) };
}
