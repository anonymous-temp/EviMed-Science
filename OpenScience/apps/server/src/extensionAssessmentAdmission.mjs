import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson, canonicalExtensionCoordinate, extensionProofAdapterRevision } from '@evimed/domain';
import { HttpError } from './security.mjs';

const authorities = new WeakSet();
const refused = () => new HttpError(400, 'extension_proof_untrusted', 'Assessment admission is unavailable.');
const digest = value => 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Privileged independent assessment-process construction only. No serving configuration or request selects this authority.
 * evaluate must check current real principals/preparation/image facts in the owned disposable database on every call.
 * Nothing here writes qualification, marks a catalogue effective, or survives process restart.
 * @param {{dataDir:string,evaluate:(input:any)=>Promise<boolean>}} options
 */
export function createExtensionAssessmentAdmission({ dataDir, evaluate }) {
  if (!path.isAbsolute(dataDir) || typeof evaluate !== 'function') throw refused();
  const root = path.resolve(dataDir), authorityId = digest(randomBytes(32).toString('hex'));
  const bindings = new Map(); let closed = false;
  const marker = Object.freeze({ authorityId, evidenceState: 'source-assessed', qualified: false });
  const authority = Object.freeze({
    root, marker,
    async evaluate(input) {
      const captured = JSON.parse(canonicalJson(input));
      if (closed || !await evaluate(structuredClone(captured))) throw refused();
      const admissionDigest = digest({ authorityId, input: captured });
      bindings.set(admissionDigest, captured); return { assessmentAdmissionDigest: admissionDigest };
    },
    async verifyManifest(config, manifest) {
      if (closed || path.resolve(config.dataDir) !== root || canonicalJson(manifest.assessmentAdmission) !== canonicalJson(marker)) throw refused();
      for (const plugin of manifest.projection.plugins.filter(value => value.compatibility !== 'legacy-citation-v1')) {
        if (plugin.receiptDigest || !plugin.assessmentAdmissionDigest) throw refused();
        const input = bindings.get(plugin.assessmentAdmissionDigest);
        if (!input || input.entry.id !== plugin.extensionId || input.artifact.artifactDigest !== plugin.artifactDigest
          || input.project.id !== manifest.scope.projectId || input.project.userId !== manifest.scope.ownerId
          || input.identity.runtimeImageDigest !== manifest.identity.baseRuntimeImageDigest
          || input.identity.permissionProfileRevision !== manifest.identity.permissionProfileRevision
          || plugin.adapterRevision !== input.identity.adapterRevision
          || input.identity.adapterRevision !== extensionProofAdapterRevision(input.artifact.adapterRevision, manifest.identity.adapterRevision,
            value => createHash('sha256').update(value).digest('hex'))
          || plugin.integrity !== input.identity.packageIntegrity || plugin.integrity !== input.entry.integrity
          || canonicalExtensionCoordinate(plugin.coordinate) !== canonicalExtensionCoordinate(input.entry.coordinate)
          || input.identity.sourceCommit !== (plugin.coordinate.kind === 'github' ? plugin.coordinate.commit : null)
          || plugin.executionClass !== input.entry.executionClass || plugin.executionClass !== input.identity.executionClass
          || !await evaluate(structuredClone(input))) throw refused();
        const installation=manifest.bindings.installations.find(value=>value.extensionId===plugin.extensionId
          &&value.assessmentAdmissionDigest===plugin.assessmentAdmissionDigest);
        if(!installation || installation.receiptDigest || installation.artifactDigest!==plugin.artifactDigest
          || installation.integrity!==plugin.integrity || installation.coordinate!==canonicalExtensionCoordinate(plugin.coordinate))throw refused();
      }
      return true;
    },
    close() { closed = true; bindings.clear(); },
  });
  authorities.add(authority); return authority;
}
/** Only an object minted in this process can permit assessment bytes. @param {any} authority @param {any} config */
export function assertExtensionAssessmentAdmission(authority, config) {
  if (!authorities.has(authority) || authority.root !== path.resolve(config.dataDir)) throw refused();
  return authority;
}
