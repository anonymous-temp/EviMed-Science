import { knowledgeDigest } from "../../src/knowledgeGeneration.mjs";

/** Explicit three-mode authority double. A completed-read can only use a
 * binding previously observed by live mode; request.execution is never a
 * source of authority. No engine, controller, provider or learning call. */
export function createKnowledgeCompileQualificationStub({ bindingFor = request => ({ version: 1, mode: "openviking-resource-pipeline-direct-noexec", targetContextType: "resource",
  backend: "direct", allowCompileExec: false, engineVersion: "0.5.1.1", imageDigest: `sha256:${"a".repeat(64)}`, upstreamCommit: "b".repeat(40),
  skillUri: `viking://agent/skills/${request.skill}`, skillSha256: "c".repeat(64), configDigest: "d".repeat(64), qualificationDigest: "e".repeat(64) }) } = {}) {
  const observed = new Map(), calls = [];
  let offline = false, environmentEpoch = 1, skillEpoch = 1;
  const qualify = async (policy, request, { mode = "live", authorityRef = null, transactionClient = null } = {}) => {
    calls.push({ mode, transactionClient: Boolean(transactionClient), tree: request.tree });
    if (transactionClient && mode !== "completed-read") throw new Error("Live qualification inside a transaction is forbidden.");
    const key = `${policy.ownerId}:${policy.controlProjectId}:${request.skill}`;
    if (mode === "live") {
      if (offline) return null;
      const binding = bindingFor(request);
      observed.set(key, { binding, environmentEpoch, skillEpoch });
      return binding;
    }
    const saved = observed.get(key);
    if (!saved || saved.environmentEpoch !== environmentEpoch || saved.skillEpoch !== skillEpoch
      || knowledgeDigest(saved.binding) !== knowledgeDigest(request.execution)) return null;
    const reference = { environmentEpoch, skillEpoch, bindingDigest: knowledgeDigest(saved.binding) };
    if (mode === "authority-reference") return reference;
    if (mode === "completed-read") return knowledgeDigest(authorityRef) === knowledgeDigest(reference) ? saved.binding : null;
    throw new Error("Unknown qualification mode.");
  };
  return { qualify, calls, setOffline: value => { offline = value; }, revokeEnvironment: () => { environmentEpoch += 1; }, revokeSkill: () => { skillEpoch += 1; } };
}
