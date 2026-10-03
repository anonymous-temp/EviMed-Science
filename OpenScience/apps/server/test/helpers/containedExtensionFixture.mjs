/** Explicit immutable observations from the portable preparer; no ignored cache path is an input. */
import {readAcceptanceInputs} from '../../../../scripts/ops/extension-saas-acceptance-inputs.mjs';
import {createAssessmentDescriptor} from '../../../../scripts/ops/extension-saas-acceptance-manifest.mjs';
export function containedExtensionExecutionIdentity(descriptor,sequence){
  return {jobId:'operation-'+sequence,leaseToken:'fixture-execution-lease',attempts:1,operationId:'owned-operation',
    userId:'fixture-owner',ownerId:'fixture-owner',ownerAccountCreatedAt:'2026-10-02',membershipEpoch:null,
    projectId:'fixture-project',accountCreatedAt:'2026-10-02',projectCreatedAt:'2026-10-02',runtimeGeneration:'runtime-fixture',
    extensionGenerationHash:'a'.repeat(64),descriptorId:descriptor.id,artifactDigest:descriptor.artifactDigest,
    installationId:'fixture-installation',installationRevision:1};
}
export async function containedExtensionDescriptor(environment=process.env){
  if(environment.EVIMED_EXTENSION_ACCEPTANCE_INPUTS){
    const inputs=await readAcceptanceInputs(environment.EVIMED_EXTENSION_ACCEPTANCE_INPUTS);
    if(environment.COWORK_TEST_IMAGE&&environment.COWORK_TEST_IMAGE!==inputs.images.coworkImageId)throw new Error('Prepared and configured images disagree.');
    return inputs.descriptor;
  }
  return createAssessmentDescriptor({imageId:environment.COWORK_TEST_IMAGE,integrity:environment.COWORK_TEST_INTEGRITY,closureExpectedSHA:environment.COWORK_TEST_CLOSURE_SHA256});
}
