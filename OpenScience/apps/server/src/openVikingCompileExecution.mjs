import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "@evimed/domain";
import { PINNED } from "./pinnedVersions.mjs";
import { OPENVIKING_ENGINE_USER } from "./openVikingEngine.mjs";
import { OPENVIKING_SKILLS_ROOT, projectResourcesRoot } from "./openVikingLayout.mjs";
import { knowledgeGenerationRoots } from "./knowledgeGeneration.mjs";
import { OpenVikingCompileAuthority } from "./openVikingCompileAuthority.mjs";

export const COMPILE_SCOPE_PROOF = JSON.parse(fs.readFileSync(new URL("../../../packages/contracts/openviking/compile-scope-proof.json", import.meta.url), "utf8"));
export const compileProofDigest = value => createHash("sha256").update(canonicalJson(value)).digest("hex");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const SHA = /^[a-f0-9]{64}$/;
const CONFIG_PATH = "/run/openviking-secrets/ov.conf";
const CONFIG_DIGEST_PATH = `${CONFIG_PATH}.sha256`;
const EXPECTED_CODE_DIGEST = compileProofDigest(COMPILE_SCOPE_PROOF.files.map(file => ({ path: file.installedPath, sha256: file.sha256 })));
const QUALIFICATION_DIGEST = compileProofDigest({ proof: COMPILE_SCOPE_PROOF, codeDigest: EXPECTED_CODE_DIGEST });

export function safeCompileConfiguration(value) {
  const bot = value?.bot;
  if (!bot || Array.isArray(bot) || typeof bot !== "object" || Object.keys(bot).some(key => !/^[a-z][a-z0-9_]*$/.test(key))) return false;
  return canonicalJson(bot.sandbox ?? null) === canonicalJson({ backend: "direct", backends: { direct: { allow_exec: false, allow_compile_exec: false } } });
}

/** The ordinary init writes a root-owned digest beside the engine-owned
 * secret. Historical reads need no secret access or engine availability.
 * Live admission independently compares this installation receipt with the
 * actual configuration observed inside the engine. `filePath` is an internal
 * filesystem-test seam; no request or environment setting supplies it. */
export async function readMountedCompileConfigurationDigest(filePath = CONFIG_DIGEST_PATH) {
  let file;
  try {
    for (let name = filePath; ; name = path.dirname(name)) {
      if ((await fs.promises.lstat(name)).isSymbolicLink()) return null;
      if (name === path.dirname(name)) break;
    }
    file = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = await file.stat();
    if (!before.isFile() || before.size > 128) return null;
    const buffer = Buffer.alloc(129); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await file.stat(), current = await fs.promises.lstat(filePath);
    const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
    if (size !== before.size || size > 128 || current.isSymbolicLink()
      || canonicalJson(stamp(before)) !== canonicalJson(stamp(after)) || canonicalJson(stamp(after)) !== canonicalJson(stamp(current))) return null;
    const text = buffer.subarray(0, size).toString("utf8");
    return /^[a-f0-9]{64}\n$/.test(text) ? text.trim() : null;
  } catch { return null; }
  finally { await file?.close().catch(() => {}); }
}

class RejectedObservation extends Error {
  constructor(scope, code) { super(code); this.scope = scope; this.code = code; }
}
const rejected = (scope = "environment", code = "execution_unverified") => { throw new RejectedObservation(scope, code); };

function currentBinding(binding, skill) {
  return binding?.version === 1 && binding.mode === "openviking-resource-pipeline-direct-noexec" && binding.targetContextType === "resource"
    && binding.backend === "direct" && binding.allowCompileExec === false && binding.engineVersion === PINNED.openviking.version
    && binding.imageDigest === PINNED.openviking.imageDigest && COMPILE_SCOPE_PROOF.imageDigest === PINNED.openviking.imageDigest
    && binding.upstreamCommit === COMPILE_SCOPE_PROOF.upstreamCommit && binding.qualificationDigest === QUALIFICATION_DIGEST
    && binding.skillUri === `${OPENVIKING_SKILLS_ROOT}/${skill}` && binding.skillSha256 === PINNED.openviking.skills[skill]?.installedSha256
    && SHA.test(binding.skillRevision) && SHA.test(binding.configDigest);
}

function validObservation(observation) {
  return COMPILE_SCOPE_PROOF.imageDigest === PINNED.openviking.imageDigest
    && observation?.version === 1 && SHA.test(observation.instance) && SHA.test(observation.processDigest)
    && SHA.test(observation.configDigest) && observation.codeDigest === EXPECTED_CODE_DIGEST
    && observation.imageDigest === PINNED.openviking.imageDigest && observation.configPath === CONFIG_PATH
    && observation.backend === "direct" && observation.allowExec === false && observation.allowCompileExec === false;
}

/** The hosted engine's bounded observer and upstream read-only APIs qualify
 * the exact resource-compile path. No task is submitted here. The receipt
 * describes startup-config evidence, not a read of Bot's in-memory object.
 * Remove the lifecycle adapter when upstream exposes authenticated effective
 * Compile configuration with its loaded code and configuration identities. */
export class OpenVikingCompileExecution {
  constructor({ client, controller, documents = null, ensureOwner = null, readConfigurationDigest = readMountedCompileConfigurationDigest }) {
    this.client = client;
    this.controller = controller;
    this.documents = documents;
    this.authority = documents ? new OpenVikingCompileAuthority({ documents, ensureOwner,
      scopeDigest: compileProofDigest({ endpoint: client.baseUrl, account: client.account, configPath: CONFIG_PATH }),
      isCurrentBinding: currentBinding, readConfigurationDigest }) : null;
    this.lastStatus = { qualified: false, code: "not_observed", basis: null };
  }

  status() { return { ...this.lastStatus }; }

  async forRequest(policy, request, { mode = "live", authorityRef = null, transactionClient = null } = {}) {
    try {
      if (!this.#validRequest(policy, request) || !this.authority) return null;
      if (mode === "authority-reference") return await this.authority.reference(request.skill, request.execution, transactionClient);
      if (mode === "completed-read") {
        const result = await this.authority.completed(request.skill, request.execution, authorityRef, transactionClient);
        this.lastStatus = { qualified: Boolean(result), code: result ? "qualified_history" : "history_unverified", basis: "historical" };
        return result;
      }
      if (mode !== "live" || this.documents?.database?.transactionScope?.()) return null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await this.authority.snapshot();
        let observation;
        try { observation = { state: "qualified", skill: request.skill, binding: await this.#observe(request) }; }
        catch (error) {
          if (error instanceof RejectedObservation) observation = { state: "rejected", scope: error.scope, code: error.code, skill: request.skill };
          else throw error;
        }
        if (!await this.authority.record(before, observation)) continue;
        const qualified = observation.state === "qualified";
        this.lastStatus = { qualified, code: qualified ? "qualified" : observation.code, basis: "live" };
        return qualified ? observation.binding : null;
      }
      this.lastStatus = { qualified: false, code: "authority_changed", basis: "live" };
      return null;
    } catch {
      // The configuration API can return credentials even in its errors.
      // Never retain its body, error message or exception in product state.
      this.lastStatus = { qualified: false, code: "observation_unavailable", basis: mode === "completed-read" ? "historical" : "live" };
      return null;
    }
  }

  #validRequest(policy, request) {
    const expected = PINNED.openviking.skills[request?.skill];
    if (!expected || !this.client.configured || this.client.baseUrl !== "http://evimed-openviking:1933"
      || typeof policy?.ownerId !== "string" || !policy.ownerId || typeof policy.controlProjectId !== "string" || !policy.controlProjectId
      || !Array.isArray(request.from) || request.from.length !== 1
      || !["wiki", "kg"].includes(request.tree) || request.skill !== (request.tree === "wiki" ? "llm-wiki" : "knowledge-graph")) return false;
    const resources = { roots: () => ({ project: projectResourcesRoot(policy.ownerId, policy.controlProjectId) }) };
    const matches = [0, 1].some(attempt => {
      const roots = knowledgeGenerationRoots(resources, policy.ownerId, policy.controlProjectId, request.generationId, attempt);
      return request.from[0] === roots.sources && request.to === roots[request.tree];
    });
    return matches;
  }

  async #controllerObservation() {
    try { return await this.controller.observeOpenVikingCompile(); }
    catch (error) {
      if (error?.code === "openviking_compile_unverified") rejected("environment", "controller_rejected");
      throw error;
    }
  }

  async #observe(request) {
    const expected = PINNED.openviking.skills[request.skill];
    const before = await this.#controllerObservation();
    if (!validObservation(before)) return rejected();
    const configuration = (await this.client.request({ path: "/api/v1/admin/configuration", query: { source: "file" }, maxResponseBytes: 2 * 1024 * 1024 }))?.result;
    if (configuration?.file_path !== CONFIG_PATH || configuration.restart_required !== false
      || typeof configuration.content !== "string" || Buffer.byteLength(configuration.content) > 1024 * 1024
      || configuration.revision !== before.configDigest || sha256(configuration.content) !== before.configDigest) return rejected("environment", "configuration_changed");
    // Upstream normalizes camel/Pascal keys before validation. Reject aliases
    // at the parent as well as inside sandbox: a later `Sandbox` would otherwise
    // replace the literal `sandbox` whose flags were just checked.
    if (!safeCompileConfiguration(JSON.parse(configuration.content))) return rejected("environment", "unsafe_configuration");
    const installedDigest = await this.authority.readConfigurationDigest();
    if (!installedDigest) throw new Error("configuration_install_receipt_unavailable");
    if (installedDigest !== before.configDigest) return rejected("environment", "configuration_install_receipt_changed");
    const skillUri = `${OPENVIKING_SKILLS_ROOT}/${request.skill}`;
    let skill;
    try {
      skill = (await this.client.request({ path: `/api/v1/skills/${request.skill}`, openVikingUser: OPENVIKING_ENGINE_USER,
        query: { target_uri: OPENVIKING_SKILLS_ROOT, include_content: false, include_files: true, include_integrity: true, level: 2 },
        maxResponseBytes: 2 * 1024 * 1024 }))?.result;
    } catch (error) {
      if (error?.code === "memory_index_not_found") return rejected("skill", "skill_missing");
      throw error;
    }
    // Inline skill installation also writes these two hidden summaries. The
    // pinned renderer rejects dot-prefixed path segments, so they are not
    // readable attachments; the compile's initial instruction is SKILL.md.
    // Anything else is outside the reviewed package.
    const files = skill?.files;
    const allowed = new Set(["SKILL.md", ".abstract.md", ".overview.md"]);
    if (skill?.uri !== skillUri || !SHA.test(skill.revision) || !Array.isArray(files)
      || files.length < 1 || files.length > allowed.size) return rejected("skill", "skill_changed");
    const main = files.find(file => file.path === "SKILL.md");
    if (new Set(files.map(file => file.path)).size !== files.length
      || files.some(file => !allowed.has(file.path) || file.uri !== `${skillUri}/${file.path}`
        || file.is_dir !== false || !SHA.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0
        || (file.path !== "SKILL.md" && file.kind !== "summary"))
      || main?.sha256 !== expected.installedSha256
      || skill.content_sha256 !== expected.installedSha256) return rejected("skill", "skill_changed");
    const revisionInput = files.map(file => ({ path: file.path, is_dir: file.is_dir, size: file.size, sha256: file.sha256 }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (compileProofDigest(revisionInput) !== skill.revision) return rejected("skill", "skill_changed");
    const after = await this.#controllerObservation();
    if (!validObservation(after)) return rejected();
    if (compileProofDigest(before) !== compileProofDigest(after)) throw new Error("observation_changed");
    const binding = {
      version: 1, mode: "openviking-resource-pipeline-direct-noexec", targetContextType: "resource",
      engineVersion: PINNED.openviking.version, imageDigest: PINNED.openviking.imageDigest,
      upstreamCommit: COMPILE_SCOPE_PROOF.upstreamCommit, backend: "direct", allowCompileExec: false,
      skillUri, skillSha256: expected.installedSha256, skillRevision: skill.revision, configDigest: before.configDigest,
      evidenceKind: COMPILE_SCOPE_PROOF.evidenceKind, botInMemoryRead: false,
      qualificationDigest: QUALIFICATION_DIGEST,
    };
    // Instance/process observation is deliberately absent: the same qualified
    // bytes after an ordinary restart do not invalidate an existing generation.
    return binding;
  }
}
