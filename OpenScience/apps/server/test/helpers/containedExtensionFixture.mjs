/** Explicit immutable observations from the portable preparer; no ignored cache path is an input. */
import {readAcceptanceInputs} from '../../../../scripts/ops/extension-saas-acceptance-inputs.mjs';
import {createAssessmentDescriptor} from '../../../../scripts/ops/extension-saas-acceptance-manifest.mjs';
export async function containedExtensionDescriptor(environment=process.env){
  if(environment.EVIMED_EXTENSION_ACCEPTANCE_INPUTS){
    const inputs=await readAcceptanceInputs(environment.EVIMED_EXTENSION_ACCEPTANCE_INPUTS);
    if(environment.COWORK_TEST_IMAGE&&environment.COWORK_TEST_IMAGE!==inputs.images.coworkImageId)throw new Error('Prepared and configured images disagree.');
    return inputs.descriptor;
  }
  return createAssessmentDescriptor({imageId:environment.COWORK_TEST_IMAGE,integrity:environment.COWORK_TEST_INTEGRITY,closureExpectedSHA:environment.COWORK_TEST_CLOSURE_SHA256});
}
