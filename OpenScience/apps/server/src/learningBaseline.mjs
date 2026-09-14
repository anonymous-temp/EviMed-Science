import { createHash } from "node:crypto";
import { MAX_MOUNTED_CAPSULE_METHODS, MAX_MOUNTED_CAPSULE_METHOD_BYTES, selectCapsuleMethods } from "./capsuleMethods.mjs";
import { MAX_MOUNTED_LEARNED_METHODS, selectLearnedMethods } from "./learnedMethodMount.mjs";

/** The same owner/project snapshot defines the evaluation baseline and the
 * promotion-time comparison. Hash the selected mount, including capsule text
 * and method files, with the original frozen-arm representation.
 * @param {{learning: any, capsules: any, userId: string, projectId: string}} input
 */
export async function freezeLearningBaseline({ learning, capsules, userId, projectId }) {
  const approved = structuredClone([
    ...await learning.approvedMethods(userId, { projectId }),
    ...await learning.approvedMethods(userId, { projectId: null }),
  ]);
  const approvedMethods = async (_userId, scope) => approved.filter((document) => document.projectId === scope.projectId);
  const capsuleMethods = capsules ? structuredClone(await selectCapsuleMethods(capsules, { userId, projectId })) : [];
  const capsuleBytes = capsuleMethods.reduce((sum, method) => sum + method.bytes, 0);
  const limits = {
    maxCount: Math.min(MAX_MOUNTED_LEARNED_METHODS, MAX_MOUNTED_CAPSULE_METHODS - capsuleMethods.length),
    maxBytes: MAX_MOUNTED_CAPSULE_METHOD_BYTES - capsuleBytes,
  };
  const learnedMethods = await selectLearnedMethods({ approvedMethods }, { userId, projectId, ...limits });
  const baselineDigest = `sha256:${createHash("sha256").update(JSON.stringify({ capsuleMethods, learnedMethods })).digest("hex")}`;
  return { approved, approvedMethods, capsuleMethods, learnedMethods, limits, baselineDigest };
}
