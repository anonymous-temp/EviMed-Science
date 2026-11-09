import { createHash } from 'node:crypto';
import { canonicalJson, canonicalExtensionCoordinate, researchNativeReceiptDigest, researchNativeArtifactDigest } from '@evimed/domain';
import { extensionRequestObject } from './extensionAccess.mjs';
import { extensionPreparationIdentity } from './extensionToolController.mjs';
import { HttpError } from './security.mjs';

const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const invalid = () => new HttpError(400, 'extension_contract_invalid', 'The native artifact preparation did not match.');
/** Extend the existing leased controller; its run, cancellation, markers and physical cleanup stay authoritative.
 * @param {any} tools @param {{nativeBundles:any[],imageId:()=>Promise<string>,resolvePreparation:any}} options */
export function attachNativePreparation(tools, { nativeBundles, imageId, resolvePreparation }) {
  const native = new Map(nativeBundles.map(item => [item.id, structuredClone(item)]));
  const isolatedPrepare = tools.prepare.bind(tools);
  tools.nativeBundles = native;
  /** @param {any} body @param {{signal?:AbortSignal}} [options] */
  tools.prepare = async (body, { signal } = {}) => {
    extensionRequestObject(body, ['descriptorId', 'identity']);
    const descriptor = native.get(body.descriptorId);
    if (!descriptor) return isolatedPrepare(body, { signal });
    const identity = extensionPreparationIdentity(body.identity);
    const authorize = async () => {
      const actual = await resolvePreparation(identity, descriptor);
      if (!actual || actual.descriptorId !== descriptor.id || actual.artifactDigest !== descriptor.artifactDigest ||
          canonicalJson(actual.identity) !== canonicalJson(identity)) throw invalid();
    };
    await authorize();
    const immutableImage = await imageId();
    if (!/^sha256:[a-f0-9]{64}$/u.test(immutableImage)) throw invalid();
    const output = await tools.run({ imageId: immutableImage, artifactDigest: descriptor.artifactDigest }, identity,
      { mounts: [], entrypoint: ['--entrypoint', 'node'], command: ['/usr/local/bin/evimed-research-bundles.mjs', 'inspect', descriptor.id] }, null, signal);
    let receipt;
    try { receipt = JSON.parse(output); } catch { throw invalid(); }
    if (researchNativeReceiptDigest(receipt, digest) !== descriptor.receiptDigest ||
        researchNativeArtifactDigest(descriptor, digest) !== descriptor.artifactDigest ||
        receipt.closureDigest !== descriptor.closureDigest || receipt.integrity !== descriptor.integrity ||
        canonicalExtensionCoordinate(receipt.coordinate) !== canonicalExtensionCoordinate(descriptor.coordinate) ||
        await imageId() !== immutableImage) throw invalid();
    await authorize();
    return { artifactDigest: descriptor.artifactDigest, integrity: descriptor.integrity,
      coordinate: canonicalExtensionCoordinate(descriptor.coordinate), receiptDigest: descriptor.receiptDigest,
      imageId: immutableImage, qualified: false, joined: true };
  };
  return tools;
}
