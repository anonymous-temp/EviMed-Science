// A release never unmounts what the project still has installed.
//
// 2026-10-04, live: after a release an installed extension disappeared from a
// project that also had personal skills. A personal generation's reference
// embeds the runtime image, so a release changes it for every project while the
// skills in it stay what they were; the start compared that reference with the
// one the extension's composite generation was stamped with, read the difference
// as "a fresh personal change", and dropped the composite. The comparison is now
// of the skills themselves (`samePersonalPackages`), and a republish of the
// installed skills for the new image is mounted even while a stale run sits in
// the ledger (`personalGenerationForStart`).
import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeManager } from "../src/runtimeManager.mjs";
import {
  personalGenerationCompatible, personalGenerationForStart, personalPackageIdentity, samePersonalPackages,
} from "../src/personalSkillGenerationService.mjs";

const digest = (letter) => `sha256:${letter.repeat(64)}`;
const OLD_IMAGE = { baseRuntimeImageDigest: digest("a"), adapterRevision: digest("b"), permissionProfileRevision: digest("c") };
const NEW_IMAGE = { ...OLD_IMAGE, baseRuntimeImageDigest: digest("d") };
const pin = (skillId, revision = 1, letter = "e") => ({ skillId, revision, digest: digest(letter), nativeName: skillId });

/** A stored generation of the given skills, published for an image. */
const generation = (hash, identity, pins) => ({ reference: { ownerHash: "o", projectHash: "p", generationHash: hash }, pins, identity, selectionRevision: 3, findings: [] });

test("a personal generation's package identity is its skills, and nothing about the image", () => {
  const before = generation("h1", OLD_IMAGE, [pin("review"), pin("draft", 2, "f")]);
  const after = generation("h2", NEW_IMAGE, [pin("draft", 2, "f"), pin("review")]);
  assert.deepEqual(personalPackageIdentity(before), personalPackageIdentity(after), "order and image do not matter");
  assert.equal(samePersonalPackages(before, after), true);
  assert.equal(samePersonalPackages(before, generation("h3", NEW_IMAGE, [pin("review")])), false, "a skill removed");
  assert.equal(samePersonalPackages(before, generation("h4", NEW_IMAGE, [pin("review"), pin("draft", 3, "f")])), false, "a skill's revision changed");
  assert.equal(samePersonalPackages(before, generation("h5", NEW_IMAGE, [pin("review"), pin("draft", 2, "9")])), false, "a skill's bytes changed");
  assert.equal(samePersonalPackages(null, { reference: null, pins: [] }), true, "no personal skills is the same on both sides");
  assert.equal(samePersonalPackages(undefined, generation("h6", NEW_IMAGE, [pin("review")])), false);
});

test("a stored generation is compatible only with the image it was published for", () => {
  const stored = generation("h1", OLD_IMAGE, [pin("review")]);
  assert.equal(personalGenerationCompatible(OLD_IMAGE, stored), true);
  assert.equal(personalGenerationCompatible(NEW_IMAGE, stored), false);
  assert.equal(personalGenerationCompatible(null, stored), false);
  assert.equal(personalGenerationCompatible(OLD_IMAGE, { ...stored, reference: null }), false);
});

/** The personal state document a project holds after a release: desired for the new image, installed for the old. */
function stateAfterRelease({ desiredPins = [pin("review")], installedPins = [pin("review")] } = {}) {
  const installed = generation("old", OLD_IMAGE, installedPins);
  return { payload: { desired: generation("new", NEW_IMAGE, desiredPins), effective: installed, lastGood: installed } };
}

test("after a release the skills republished for the new image are mounted, busy ledger or not", async () => {
  const state = stateAfterRelease();
  for (const busy of [false, true]) {
    const chosen = await personalGenerationForStart({ state, identity: NEW_IMAGE, busy: async () => busy });
    assert.equal(chosen.reference.generationHash, "new", `busy=${busy}`);
  }
});

test("a changed selection is still not mounted under work in flight, and is mounted when the ledger is idle", async () => {
  const state = stateAfterRelease({ desiredPins: [pin("review"), pin("draft")] });
  assert.equal(await personalGenerationForStart({ state, identity: NEW_IMAGE, busy: async () => true }), null);
  assert.equal((await personalGenerationForStart({ state, identity: NEW_IMAGE, busy: async () => false })).reference.generationHash, "new");
  // Removed skills are a change too.
  const removed = stateAfterRelease({ desiredPins: [] });
  assert.equal(await personalGenerationForStart({ state: removed, identity: NEW_IMAGE, busy: async () => true }), null);
});

test("what is installed for the image that runs, and still wanted, is mounted first and the ledger is never asked", async () => {
  const state = { payload: { desired: generation("same", NEW_IMAGE, [pin("review")]), effective: generation("effective", NEW_IMAGE, [pin("review")]), lastGood: null } };
  let asked = 0;
  const chosen = await personalGenerationForStart({ state, identity: NEW_IMAGE, busy: async () => { asked += 1; return true; } });
  assert.equal(chosen.reference.generationHash, "effective");
  assert.equal(asked, 0);
  // Installed but no longer wanted: not mounted.
  const unwanted = { payload: { desired: generation("next", NEW_IMAGE, [pin("draft")]), effective: generation("effective", NEW_IMAGE, [pin("review")]), lastGood: null } };
  assert.equal((await personalGenerationForStart({ state: unwanted, identity: NEW_IMAGE, busy: async () => false })).reference.generationHash, "next");
});

test("nothing installed yet starts on desired only when idle, and nothing compatible is no personal skills", async () => {
  const first = { payload: { desired: generation("first", NEW_IMAGE, [pin("review")]), effective: null, lastGood: null } };
  assert.equal(await personalGenerationForStart({ state: first, identity: NEW_IMAGE, busy: async () => true }), null);
  assert.equal((await personalGenerationForStart({ state: first, identity: NEW_IMAGE, busy: async () => false })).reference.generationHash, "first");
  assert.equal(await personalGenerationForStart({ state: stateAfterRelease(), identity: null, busy: async () => false }), null);
  assert.equal(await personalGenerationForStart({ state: null, identity: NEW_IMAGE, busy: async () => false }), null);
  const stale = stateAfterRelease();
  stale.payload.desired = generation("lagging", OLD_IMAGE, [pin("review")]);
  assert.equal(await personalGenerationForStart({ state: stale, identity: NEW_IMAGE, busy: async () => false }), null, "a desired generation for an image no longer running is not mounted");
});

// ——— The start itself ———

const project = { id: "paper1", userId: "alice", workspaceDir: "/srv/open-science/users/alice/projects/paper1/workspace" };

/** Start a project whose composite was stamped before a release and whose personal skills were prepared after it; return what the provider was asked to prepare. */
async function startWith({ stamped, prepared }) {
  const manager = new RuntimeManager({ runtimeProvider: "docker", runtimeMode: "kernel", dataDir: "/unused-test-data" });
  // A null personal reference keeps the composite's frozen personal bytes out of this test
  // (they are verified on disk by `verifyPersonalSkillGeneration`); the comparison is of the skills.
  const composite = { identity: OLD_IMAGE, bindings: { personalRevision: 3 }, projection: { plugins: [], personal: { reference: null, pins: stamped } } };
  manager.syncCapsuleMethods = async () => ({ count: 0 });
  manager.personalSkillGenerations = { prepareForRuntime: async () => (prepared === null ? null : generation("new", NEW_IMAGE, prepared)) };
  manager.extensionGenerationResolver = async () => composite;
  manager.prepareGeneration = async () => ({ joined: true });
  const boundary = new Error("Stop before container or kernel startup");
  let plan;
  manager.provider = { preflight: async () => {}, prepare: async (_project, input) => { plan = input; throw boundary; } };
  await assert.rejects(manager.startKernel(project), (error) => error === boundary);
  return { plan, composite };
}

test("a release does not unmount the extension of a project that also has personal skills", async () => {
  const { plan, composite } = await startWith({ stamped: [pin("review")], prepared: [pin("review")] });
  assert.equal(plan.extensionGeneration, composite, "the installed extension is still mounted");
});

test("a fresh personal change after the composite was stamped still wins over it", async () => {
  for (const prepared of [[pin("review"), pin("draft")], [pin("review", 2)], [], null]) {
    const { plan } = await startWith({ stamped: [pin("review")], prepared });
    assert.equal(plan.extensionGeneration, null, JSON.stringify(prepared));
  }
});
