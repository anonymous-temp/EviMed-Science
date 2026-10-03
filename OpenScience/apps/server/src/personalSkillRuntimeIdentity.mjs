import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { HttpError } from "./security.mjs";

/** Deployment-owned bytes identify the adapter and permission policy. Caller
 * metadata can never supply these identities or imply a qualification proof.
 * @param {any} runtime */
export async function personalSkillRuntimeIdentity(runtime) {
  const image = await runtime.inspectRuntimeImage();
  if (!/^sha256:[a-f0-9]{64}$/.test(image?.imageId ?? "")) {
    throw new HttpError(503, "runtime_image_unavailable", "The personal skill runtime image is unavailable.");
  }
  const closure = async names => {
    const hash = createHash("sha256");
    for (const name of names) {
      const bytes = await fs.readFile(new URL(name, import.meta.url));
      hash.update(name).update("\0").update(String(bytes.length)).update("\0").update(bytes);
    }
    return `sha256:${hash.digest("hex")}`;
  };
  return {
    baseRuntimeImageDigest: image.imageId,
    adapterRevision: await closure(["./personalSkillGenerationService.mjs", "./personalSkillGenerationWorker.mjs", "./personalSkillMount.mjs", "./runtimeControllerClient.mjs"]),
    permissionProfileRevision: await closure(["./dshProfilePatch.mjs", "./runtimeManager.mjs"]),
  };
}
