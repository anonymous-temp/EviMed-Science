import { createHash } from "node:crypto";
import {
  MAX_MOUNTED_CAPSULE_METHODS, MAX_MOUNTED_CAPSULE_METHOD_BYTES, runtimeCapsuleMethodsDir, selectCapsuleMethods,
} from "./capsuleMethods.mjs";
import { MAX_MOUNTED_LEARNED_METHODS, selectLearnedMethods } from "./learnedMethodMount.mjs";

/** The same owner/project snapshot defines the evaluation baseline and the
 * promotion-time comparison. Hash the selected mount, including capsule text
 * and method files, with the original frozen-arm representation.
 *
 * `excludeMethodIds` keeps the method under evaluation out of its own control
 * arm. Since 2026-09-20 a distilled method is effective from the night it is
 * learned, so without this the baseline — built from the library as it stands —
 * would mount the very method the candidate arm is there to add, and every
 * comparison would be a thing measured against itself.
 *
 * `maxPromptBytes` is the launch's byte budget (`OPEN_SCIENCE_MOUNTED_METHOD_PROMPT_BYTES`),
 * spent as a launch spends it: a capsule entry whole, a learned method as its
 * card (`materializeCapsuleMethods`).
 * @param {{learning: any, capsules: any, userId: string, projectId: string, excludeMethodIds?: readonly string[],
 *   maxPromptBytes?: number}} input
 */
export async function freezeLearningBaseline({
  learning, capsules, userId, projectId, excludeMethodIds = [], maxPromptBytes = MAX_MOUNTED_CAPSULE_METHOD_BYTES,
}) {
  const withheld = new Set(excludeMethodIds.map(String));
  // The whole library, as a launch mounts it (`selectLearnedMethods`): every
  // method is the account's since 2026-09-27, and this read the project's and
  // the account-wide ones as two lists, then answered the mount's one-argument
  // call by reading a scope it was never given.
  const approved = structuredClone((await learning.approvedMethods(userId))
    .filter((/** @type {any} */ document) => !withheld.has(String(document.id))));
  const approvedMethods = async () => approved;
  const capsuleMethods = capsules ? structuredClone(await selectCapsuleMethods(capsules, { userId, projectId, maxBytes: maxPromptBytes })) : [];
  // The same budget order a launch spends (`materializeCapsuleMethods`): the
  // account's own entries, then its learned methods, then received packs.
  const ownMethods = capsuleMethods.filter((method) => method.received !== true);
  const ownBytes = ownMethods.reduce((sum, method) => sum + method.bytes, 0);
  const limits = {
    maxCount: Math.min(MAX_MOUNTED_LEARNED_METHODS, MAX_MOUNTED_CAPSULE_METHODS - ownMethods.length),
    maxBytes: maxPromptBytes - ownBytes,
    cardDirectory: runtimeCapsuleMethodsDir,
  };
  // An evaluation cell is research, and mounts research methods.
  const learnedMethods = await selectLearnedMethods({ approvedMethods }, { userId, projectId, ...limits, family: "research" });
  // Hashed without `received` and `promptBytes`, which say where a method
  // sits in the budget rather than what is mounted, so a grant issued before
  // either field existed still names the same baseline.
  const hashed = capsuleMethods.map(({ received: _received, ...method }) => method);
  const hashedLearned = learnedMethods.map(({ promptBytes: _promptBytes, ...method }) => method);
  const baselineDigest = `sha256:${createHash("sha256").update(JSON.stringify({ capsuleMethods: hashed, learnedMethods: hashedLearned })).digest("hex")}`;
  return { approved, approvedMethods, capsuleMethods, learnedMethods, limits, maxPromptBytes, baselineDigest };
}
