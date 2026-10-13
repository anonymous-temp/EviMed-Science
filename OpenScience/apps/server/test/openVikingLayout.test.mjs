// Where things are in the engine. One definition, read by the compose test, the configuration renderer, the control
// plane's self-check and the modules built on the client; what is asserted here is the part no other test holds: the
// viking:// roots, and that no account's identity reaches a path or a provider.
import assert from "node:assert/strict";
import test from "node:test";
import { memoryUri, openVikingPeerId as clientPeerId, openVikingUserId as clientUserId, userMemoryRoot } from "../src/openVikingClient.mjs";
import {
  OPENVIKING_MEMORY_TYPES, OPENVIKING_SKILLS_ROOT, OPENVIKING_SKILL_NAMES, libraryResourcesUri, nativeMemoryRoot, openVikingKnowledgeModelKey,
  openVikingPeerId, openVikingUserId, projectGraphUri, projectResourcesRoot, projectSourcesUri, projectWikiUri, resourcesRoot, skillUri, userRootUri,
} from "../src/openVikingLayout.mjs";

const USER = "wang.zeyuan@hospital.example";
const PROJECT = "prj_kidney";

test("an account and a project are an opaque hash in every path, and the same hash everywhere", () => {
  // The engine's user id reaches the model provider: an extraction prompt lists the user's existing memory URIs. It
  // must never be an account name or an e-mail address.
  assert.match(openVikingUserId(USER), /^u-[0-9a-f]{24}$/);
  assert.match(openVikingPeerId(PROJECT), /^p-[0-9a-f]{24}$/);
  assert.equal(clientUserId(USER), openVikingUserId(USER), "the client and the layout hash differently");
  assert.equal(clientPeerId(PROJECT), openVikingPeerId(PROJECT));
  for (const uri of [userRootUri(USER), nativeMemoryRoot(USER), resourcesRoot(USER), libraryResourcesUri(USER), projectResourcesRoot(USER, PROJECT),
    projectSourcesUri(USER, PROJECT), projectWikiUri(USER, PROJECT), projectGraphUri(USER, PROJECT), userMemoryRoot(USER)]) {
    assert.ok(!uri.includes("wang") && !uri.includes("hospital") && !uri.includes("kidney"), `${uri} carries an identity`);
    assert.ok(uri.startsWith(`viking://user/${openVikingUserId(USER)}`), `${uri} is outside the user's own root`);
  }
  // The values production already holds: a changed hash would address another directory than the stored one.
  assert.equal(openVikingUserId("usr_contract_fixture_v050"), "u-68dc43da763fbe7a5b3d6564");
});

test("the layout is the one the two labs ran on: sources, wiki and graph under a project, a library beside them", () => {
  const user = openVikingUserId(USER);
  const project = openVikingPeerId(PROJECT);
  assert.equal(resourcesRoot(USER), `viking://user/${user}/resources`);
  assert.equal(libraryResourcesUri(USER), `viking://user/${user}/resources/library`);
  assert.equal(projectResourcesRoot(USER, PROJECT), `viking://user/${user}/resources/p/${project}`);
  assert.equal(projectSourcesUri(USER, PROJECT), `viking://user/${user}/resources/p/${project}/sources`);
  assert.equal(projectWikiUri(USER, PROJECT), `viking://user/${user}/resources/p/${project}/wiki`);
  assert.equal(projectGraphUri(USER, PROJECT), `viking://user/${user}/resources/p/${project}/kg`);
  assert.equal(nativeMemoryRoot(USER), `viking://user/${user}/memories`);
  assert.equal(OPENVIKING_SKILLS_ROOT, "viking://agent/skills");
  assert.deepEqual(OPENVIKING_SKILL_NAMES.map(skillUri), ["viking://agent/skills/llm-wiki", "viking://agent/skills/knowledge-graph"]);
  // Two projects of one account, and one project of two accounts, never share a subtree.
  assert.notEqual(projectResourcesRoot(USER, PROJECT), projectResourcesRoot(USER, "prj_heart"));
  assert.notEqual(projectResourcesRoot(USER, PROJECT), projectResourcesRoot("another.account", PROJECT));
});

test("the derived recall index and native memory share a root and can never share a file", () => {
  // Native memory writes `memories/<type>/…`; the copies of PostgreSQL's records live under `memories/evimed/…`.
  assert.equal(userMemoryRoot(USER), `${nativeMemoryRoot(USER)}/evimed`);
  assert.ok(!OPENVIKING_MEMORY_TYPES.includes("evimed"), "a memory type named evimed would write into the derived index");
  assert.ok(memoryUri(USER, { scope: "user", scopeId: "", kind: "preference", recordId: "rec1" }).startsWith(`${userMemoryRoot(USER)}/`));
  assert.equal(OPENVIKING_MEMORY_TYPES.length, 8);
  assert.equal(new Set(OPENVIKING_MEMORY_TYPES).size, 8);
});

test("the Compile agent's bearer is derived from the service key, differs from it, and is the same wherever it is computed", () => {
  const key = "service-key-of-a-fixture-0123456789abcdef";
  const derived = openVikingKnowledgeModelKey(key);
  assert.match(derived, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(derived, key);
  assert.equal(openVikingKnowledgeModelKey(key), derived);
  assert.notEqual(openVikingKnowledgeModelKey(`${key}x`), derived);
  assert.ok(!derived.includes(key));
});
