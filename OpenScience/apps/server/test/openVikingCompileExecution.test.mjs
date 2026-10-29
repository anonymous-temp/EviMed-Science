import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { OpenVikingCompileExecution, compileProofDigest, COMPILE_SCOPE_PROOF } from "../src/openVikingCompileExecution.mjs";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { OPENVIKING_PROJECT_ID } from "../src/internalProjects.mjs";
import { PINNED } from "../src/pinnedVersions.mjs";
import { projectResourcesRoot } from "../src/openVikingLayout.mjs";
import { knowledgeGenerationRoots } from "../src/knowledgeGeneration.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const content = JSON.stringify({ bot: { sandbox: { backend: "direct", backends: { direct: { allow_exec: false, allow_compile_exec: false } } } } });
const skillName = "llm-wiki", skillUri = `viking://agent/skills/${skillName}`;
const policy = { ownerId: "owner", controlProjectId: "project" };
function fixture() {
  const calls = [];
  const observation = { version: 1, instance: "a".repeat(64), configDigest: digest(content),
    imageDigest: PINNED.openviking.imageDigest, codeDigest: compileProofDigest(COMPILE_SCOPE_PROOF.files.map(file => ({ path: file.installedPath, sha256: file.sha256 }))), processDigest: digest("process"),
    configPath: "/run/openviking-secrets/ov.conf", backend: "direct", allowExec: false, allowCompileExec: false };
  const configuration = { content, revision: digest(content), file_path: observation.configPath, restart_required: false };
  const skill = { uri: skillUri, content_sha256: PINNED.openviking.skills[skillName].installedSha256,
    revision: "", files: [{ path: "SKILL.md", uri: `${skillUri}/SKILL.md`, size: 200, is_dir: false, sha256: PINNED.openviking.skills[skillName].installedSha256 },
      { path: ".abstract.md", uri: `${skillUri}/.abstract.md`, size: 8, kind: "summary", is_dir: false, sha256: digest("abstract") },
      { path: ".overview.md", uri: `${skillUri}/.overview.md`, size: 8, kind: "summary", is_dir: false, sha256: digest("overview") }] };
  skill.revision = compileProofDigest(skill.files.map(file => ({ path: file.path, is_dir: file.is_dir, size: file.size, sha256: file.sha256 }))
    .sort((a, b) => a.path < b.path ? -1 : 1));
  const client = { configured: true, account: "evimed", baseUrl: "http://evimed-openviking:1933", async request(input) {
    calls.push(input);
    return { result: input.path.includes("configuration") ? configuration : skill };
  } };
  const controller = { async observeOpenVikingCompile() { return structuredClone(observation); } };
  let authorityRow = null;
  const documents = { get: async () => structuredClone(authorityRow), put: async (_owner, _kind, _id, payload, options) => {
    if ((authorityRow?.revision ?? 0) !== options.expectedRevision) throw Object.assign(new Error("conflict"), { code: "product_revision_conflict" });
    authorityRow = { projectId: options.projectId, revision: options.expectedRevision + 1, payload: structuredClone(payload) };
    return structuredClone(authorityRow);
  } };
  const dependencies = { client, controller, documents, ensureOwner: async () => ({ userId: PLATFORM_PUBLISHER_USER_ID, projectId: OPENVIKING_PROJECT_ID }),
    readConfigurationDigest: async () => digest(configuration.content) };
  const service = new OpenVikingCompileExecution(dependencies);
  const generationId = `kg_${"f".repeat(32)}`;
  const roots = knowledgeGenerationRoots({ roots: () => ({ project: projectResourcesRoot(policy.ownerId, policy.controlProjectId) }) }, policy.ownerId, policy.controlProjectId, generationId);
  const request = { skill: skillName, tree: "wiki", generationId, from: [roots.sources], to: roots.wiki };
  return { calls, observation, configuration, skill, client, controller, service, request, dependencies };
}

test("qualifies the installed resource skill through read-only APIs and a stable binding", async () => {
  const f = fixture();
  const first = await f.service.forRequest(policy, f.request);
  assert.equal(first?.mode, "openviking-resource-pipeline-direct-noexec");
  assert.equal(first?.skillSha256, f.skill.content_sha256);
  assert.equal(first?.botInMemoryRead, false);
  assert.equal(first?.evidenceKind, "pinned-lifecycle-startup-config");
  f.observation.instance = "b".repeat(64);
  f.observation.processDigest = digest("restarted same code and config");
  assert.deepEqual(await f.service.forRequest(policy, f.request), first);
  assert.ok(f.calls.every(call => (call.method ?? "GET") === "GET"));
  assert.ok(!JSON.stringify(first).includes(content));
});

for (const [name, change] of [
  ["changed startup file", f => { f.configuration.restart_required = true; }],
  ["configuration mismatch", f => { f.configuration.revision = digest("other"); }],
  ["executable compile", f => { f.observation.allowCompileExec = true; }],
  ["different backend", f => { f.observation.backend = "subprocess"; }],
  ["unqualified image", f => { f.observation.imageDigest = `sha256:${"0".repeat(64)}`; }],
  ["modified skill", f => { f.skill.files[0].sha256 = digest("changed"); }],
  ["extra skill file", f => { f.skill.files.push({ path: "scripts/read.py", is_dir: false, sha256: digest("private read") }); }],
  ["unrecognized hidden skill file", f => { f.skill.files[1].path = ".private.md"; }],
  ["duplicate manifest path", f => { f.skill.files[1].path = "SKILL.md"; }],
  ["manifest URI mismatch", f => { f.skill.files[1].uri = "viking://user/private/.abstract.md"; }],
  ["manifest revision mismatch", f => { f.skill.revision = digest("wrong revision"); }],
  ["another engine endpoint", f => { f.client.baseUrl = "http://another-engine:1933"; }],
  ["unscoped target", f => { f.request.to = "viking://user/memories"; }],
  ["foreign project root", f => { f.request.to = f.request.to.replace(projectResourcesRoot(policy.ownerId, policy.controlProjectId), projectResourcesRoot(policy.ownerId, "foreign")); }],
  ["configuration parent alias", f => { const value = JSON.parse(f.configuration.content); value.bot.Sandbox = { backend: "direct", backends: { direct: { allow_exec: true, allow_compile_exec: true } } }; f.configuration.content = JSON.stringify(value); f.configuration.revision = digest(f.configuration.content); f.observation.configDigest = f.configuration.revision; }],
]) test(`leaves source access available without qualifying ${name}`, async () => {
  const f = fixture(); change(f);
  assert.equal(await f.service.forRequest(policy, f.request), null);
});

test("rejects a changed process between the configuration and skill observations", async () => {
  const f = fixture(); let call = 0;
  f.controller.observeOpenVikingCompile = async () => ({ ...f.observation, processDigest: digest(String(++call)) });
  assert.equal(await f.service.forRequest(policy, f.request), null);
});

test("does not expose upstream errors containing configuration credentials", async () => {
  const f = fixture();
  f.client.request = async () => { throw new Error("fake-secret-from-config"); };
  assert.equal(await f.service.forRequest(policy, f.request), null);
  assert.ok(!JSON.stringify(f.service.status()).includes("fake-secret-from-config"));
});

test("completed reads use independent persisted authority offline and can never authorize a new submission", async () => {
  const f = fixture(), execution = await f.service.forRequest(policy, f.request);
  assert.ok(execution);
  const request = { ...f.request, execution };
  const authorityRef = await f.service.forRequest(policy, request, { mode: "authority-reference" });
  assert.ok(authorityRef);
  f.controller.observeOpenVikingCompile = async () => { throw new Error("controller offline"); };
  f.client.request = async () => { throw new Error("engine offline"); };
  const restarted = new OpenVikingCompileExecution(f.dependencies);
  assert.deepEqual(await restarted.forRequest(policy, request, { mode: "completed-read", authorityRef }), execution);
  assert.equal(restarted.status().basis, "historical");
  assert.equal(await restarted.forRequest(policy, request), null);
  assert.deepEqual(await restarted.forRequest(policy, request, { mode: "completed-read", authorityRef }), execution);
  assert.equal(await restarted.forRequest(policy, request, { mode: "completed-read" }), null);
  f.configuration.content += " ";
  assert.equal(await restarted.forRequest(policy, request, { mode: "completed-read", authorityRef }), null);
});

test("observed unsafe configuration revokes previously qualified historical output across service instances", async () => {
  const f = fixture(), execution = await f.service.forRequest(policy, f.request), request = { ...f.request, execution };
  const authorityRef = await f.service.forRequest(policy, request, { mode: "authority-reference" });
  f.observation.allowCompileExec = true;
  assert.equal(await f.service.forRequest(policy, request), null);
  f.controller.observeOpenVikingCompile = async () => { throw new Error("offline after rejection"); };
  const restarted = new OpenVikingCompileExecution(f.dependencies);
  assert.equal(await restarted.forRequest(policy, request, { mode: "completed-read", authorityRef }), null);
});

test("a temporarily unreadable installation receipt cannot permanently revoke intact historical authority", async () => {
  const f = fixture(), execution = await f.service.forRequest(policy, f.request), request = { ...f.request, execution };
  const authorityRef = await f.service.forRequest(policy, request, { mode: "authority-reference" });
  const initial = await f.service.authority.snapshot();
  f.service.authority.readConfigurationDigest = async () => null;
  assert.equal(await f.service.forRequest(policy, request), null);
  assert.equal((await f.service.authority.snapshot()).revision, initial.revision);
  assert.equal(await f.service.forRequest(policy, request, { mode: "completed-read", authorityRef }), null);
  f.service.authority.readConfigurationDigest = f.dependencies.readConfigurationDigest;
  assert.deepEqual(await f.service.forRequest(policy, request, { mode: "completed-read", authorityRef }), execution);
  f.service.authority.readConfigurationDigest = async () => digest("actually changed installation");
  assert.equal(await f.service.forRequest(policy, request), null);
  f.service.authority.readConfigurationDigest = f.dependencies.readConfigurationDigest;
  assert.equal(await f.service.forRequest(policy, request, { mode: "completed-read", authorityRef }), null,
    "a proved mismatch remains revoked even after access is restored");
});
