import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { OPENVIKING_PROJECT_ID } from "../src/internalProjects.mjs";
import { OpenVikingCompileAuthority } from "../src/openVikingCompileAuthority.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const bindingFor = skill => ({ version: 1, engineVersion: "pinned", imageDigest: `sha256:${hash("image")}`,
  configDigest: hash("config"), qualificationDigest: hash("proof"), upstreamCommit: "a".repeat(40),
  skillUri: `viking://agent/skills/${skill}`, skillSha256: hash(skill), skillRevision: hash(`${skill} package`) });

function fixture() {
  let row = null, configuration = hash("config"), currentProof = hash("proof"), reads = 0;
  const documents = { get: async () => structuredClone(row), put: async (ownerId, kind, id, payload, options) => {
    assert.equal(ownerId, PLATFORM_PUBLISHER_USER_ID); assert.equal(kind, "knowledge");
    assert.equal(options.projectId, OPENVIKING_PROJECT_ID);
    if ((row?.revision ?? 0) !== options.expectedRevision) throw Object.assign(new Error("conflict"), { code: "product_revision_conflict" });
    row = { id, projectId: options.projectId, revision: options.expectedRevision + 1, payload: structuredClone(payload) };
    return structuredClone(row);
  } };
  const dependencies = { documents, ensureOwner: async () => ({ userId: PLATFORM_PUBLISHER_USER_ID, projectId: OPENVIKING_PROJECT_ID }),
    scopeDigest: hash("fixed engine endpoint and account"), isCurrentBinding: (binding, skill) => binding?.skillSha256 === hash(skill)
      && binding.qualificationDigest === currentProof && binding.imageDigest === bindingFor(skill).imageDigest,
    readConfigurationDigest: async () => { reads++; return configuration; } };
  const authority = new OpenVikingCompileAuthority(dependencies);
  return { authority, dependencies, row: () => row, reads: () => reads,
    configuration: value => { configuration = value; }, proof: value => { currentProof = value; } };
}

async function qualify(authority, skill = "llm-wiki") {
  const binding = bindingFor(skill), before = await authority.snapshot();
  assert.ok(await authority.record(before, { state: "qualified", skill, binding }));
  return { binding, reference: await authority.reference(skill, binding) };
}

test("independent durable authority preserves historical mirrors after service restart without engine access", async () => {
  const f = fixture(), { binding, reference } = await qualify(f.authority);
  const restarted = new OpenVikingCompileAuthority(f.dependencies);
  assert.deepEqual(await restarted.completed("llm-wiki", binding, reference), binding);
  assert.equal(f.reads(), 1);
  const before = await restarted.snapshot();
  assert.equal(await restarted.record(before, { state: "unavailable", code: "engine_timeout" }), null);
  assert.deepEqual(await restarted.completed("llm-wiki", binding, reference), binding);
  assert.equal(f.row().revision, before.revision);
});

test("request execution alone, forged authority references and changed local deployment bytes are not proof", async () => {
  const f = fixture(), binding = bindingFor("llm-wiki");
  assert.equal(await f.authority.completed("llm-wiki", binding, { environmentEpoch: 1, skillEpoch: 1, bindingDigest: hash("forged") }), null);
  const { reference } = await qualify(f.authority);
  assert.equal(await f.authority.completed("llm-wiki", binding, null), null);
  assert.equal(await f.authority.completed("llm-wiki", binding, { ...reference, skillEpoch: reference.skillEpoch + 1 }), null);
  f.configuration(hash("changed config"));
  assert.equal(await f.authority.completed("llm-wiki", binding, reference), null);
  f.configuration(hash("config")); f.proof(hash("new pin or code proof"));
  assert.equal(await f.authority.completed("llm-wiki", binding, reference), null);
});

test("a known environment rejection invalidates both skills and every project's historical reference", async () => {
  const f = fixture(), wiki = await qualify(f.authority), kg = await qualify(f.authority, "knowledge-graph");
  await f.authority.record(await f.authority.snapshot(), { state: "rejected", scope: "environment", code: "unsafe_configuration" });
  const otherProjectReader = new OpenVikingCompileAuthority(f.dependencies);
  for (const [skill, saved] of [["llm-wiki", wiki], ["knowledge-graph", kg]]) {
    assert.equal(await otherProjectReader.completed(skill, saved.binding, saved.reference), null);
  }
  const requalified = await qualify(f.authority);
  assert.ok(requalified.reference.environmentEpoch > wiki.reference.environmentEpoch);
  assert.equal(await otherProjectReader.completed("llm-wiki", wiki.binding, wiki.reference), null, "a later positive does not resurrect a revoked generation reference");
  assert.deepEqual(await otherProjectReader.completed("llm-wiki", requalified.binding, requalified.reference), requalified.binding);
});

test("skill-only revocation leaves the other qualified skill and unchanged observations preserve epochs", async () => {
  const f = fixture(), wiki = await qualify(f.authority), kg = await qualify(f.authority, "knowledge-graph");
  const unchanged = await qualify(f.authority);
  assert.deepEqual(unchanged.reference, wiki.reference);
  await f.authority.record(await f.authority.snapshot(), { state: "rejected", scope: "skill", skill: "llm-wiki", code: "skill_changed" });
  assert.equal(await f.authority.completed("llm-wiki", wiki.binding, wiki.reference), null);
  assert.deepEqual(await f.authority.completed("knowledge-graph", kg.binding, kg.reference), kg.binding);
});

test("a stale positive observation cannot overwrite a newer revocation", async () => {
  const f = fixture(), wiki = await qualify(f.authority), stale = await f.authority.snapshot();
  await f.authority.record(stale, { state: "rejected", scope: "environment", code: "unsafe_configuration" });
  assert.equal(await f.authority.record(stale, { state: "qualified", skill: "llm-wiki", binding: wiki.binding }), null);
  assert.equal(await f.authority.completed("llm-wiki", wiki.binding, wiki.reference), null);
});
