// The package a skill carries and the update toward a newer version, over real PostgreSQL and the real native skill
// parser: a repository source is believed only for the bytes the control plane previewed, an edited copy keeps its edits
// through an update, and the revisions that were pinned stay what they were.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { parsePersonalSkill } from "@evimed/harness-port";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { SkillLibraryService } from "../src/skillLibraryService.mjs";
import { SkillLibraryArtifacts } from "../src/skillLibraryArtifacts.mjs";
import { SkillSupply } from "../src/skillSupplyService.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url); assert(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const owner = { id: `supply_${randomUUID()}` };
const adapters = { metaAnalysis: "http://m/x", mendelianRandomization: "http://m/x", bibliometricAnalysis: "http://m/x", researchTopicSelection: "http://m/x", peerReview: "http://m/x", drugSafetyAnalysis: "http://m/x" };
const config = { runtimeMode: "kernel", runtimeProvider: "docker", evimedDisabledTools: "", evimedAdapterUrls: adapters, specialistAgents: {}, publicSourceGatewayInternalUrl: "http://127.0.0.1:8787/internal/sources/v1/fetch", modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1", operatorUsers: [], publicSourceCredentials: {} };
/** @type {any} */ let database, root, artifacts, service;
/** @type {Record<string, any[]>} */ const uploads = {};
const skillFile = (/** @type {string} */ description, /** @type {string} */ body, extra = "") => ({ type: "file", path: "SKILL.md", bytes: Buffer.from(`---\nname: checker\ndescription: ${description}\n${extra}---\n\n${body}\n`) });
const file = (/** @type {string} */ filePath, /** @type {string} */ text) => ({ type: "file", path: filePath, bytes: Buffer.from(text) });

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Supply fixture','development')", [owner.id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'p1','Supply fixture',1048576)", [owner.id]);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-skill-supply-")));
  artifacts = new SkillLibraryArtifacts({ root, parseSkill: parsePersonalSkill, resolveImport: async (/** @type {any} */ user, /** @type {string} */ id) => {
    if (user.id !== owner.id || !uploads[id]) throw Object.assign(Error("missing"), { status: 404 }); return uploads[id];
  } });
  service = new SkillLibraryService(database, { artifacts, supply: new SkillSupply({ config }), projectAccess: async () => {} });
});
after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  if (database) { await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner.id]); await database.close(); }
});

test("a repository preview names its commit for those bytes only, the package is read back from PostgreSQL, and an update keeps the edit", options, async () => {
  uploads.v1 = [skillFile("Check sources", "Version one body.", "metadata:\n  version: \"1.0\"\n  requires:\n    python: [gseapy]\n"), file("scripts/check.py", "import numpy\nprint('v1')\n"), file("references/note.md", "note")];
  const commit = "d".repeat(40);
  const preview = await service.previewImport(owner, { resourceId: "v1" }, { source: { kind: "repository", repository: "owner/checker", commit, path: null } });
  assert.equal(preview.supply.package.source.commit, commit);
  assert.equal(preview.supply.state, "limited", "gseapy is declared and the image lacks it");
  const first = await service.import(owner, { resourceId: "v1", title: "Checker" });
  const stored = (await new SkillLibraryService(database, { artifacts, supply: new SkillSupply({ config }) }).get(owner, first.id)).payload;
  assert.equal(stored.package.source.repository, "owner/checker");
  assert.equal(stored.package.source.commit, commit);
  assert.equal(stored.package.version, "1.0");
  assert.deepEqual(stored.package.scripts.map((/** @type {any} */ item) => item.path), ["scripts/check.py"]);
  assert.ok(stored.baseline.parts.instructions);
  const supply = await service.supplyOf(owner, first.id);
  assert.equal(supply.availability.state, "limited");
  assert.equal(supply.availability.reason.detail, "gseapy");
  // The researcher edits; a project pins that revision.
  const edited = await service.update(owner, first.id, { expectedRevision: 1, title: "Checker", description: "Check sources", instructions: "My own instructions." });
  const project = { id: "p1", userId: owner.id };
  await service.saveProjectSelections(owner, project, { expectedRevision: 0, skills: [{ skillId: first.id, revision: 2 }] });
  // A newer upstream: another body, a changed script, and a new reference.
  uploads.v2 = [skillFile("Check sources", "Version two body.", "metadata:\n  version: \"1.0\"\n  requires:\n    python: [gseapy]\n"), file("scripts/check.py", "import numpy\nprint('v2')\n"), file("references/note.md", "note"), file("references/new.md", "new")];
  const plan = await service.updatePreview(owner, first.id, { resourceId: "v2" });
  const decision = (/** @type {string} */ name) => plan.entries.find((/** @type {any} */ entry) => entry.name === name).decision;
  assert.equal(decision("instructions"), "conflict", "both the researcher and the upstream changed the body");
  assert.equal(decision("scripts/check.py"), "take-upstream");
  assert.equal(decision("references/new.md"), "add");
  const done = await service.applyUpdate(owner, first.id, { resourceId: "v2", expectedRevision: 2, resolutions: {} });
  assert.equal(done.skill.revision, 3);
  assert.equal(done.skill.payload.instructions, "My own instructions.");
  assert.deepEqual(done.skill.payload.resources.map((/** @type {any} */ resource) => resource.path).sort(), ["references/new.md", "references/note.md", "scripts/check.py"]);
  assert.equal((await service.resource(owner, first.id, 3, done.skill.payload.resources.find((/** @type {any} */ resource) => resource.path === "references/new.md").id)).toString(), "new");
  assert.equal((await service.projectSelections(owner, project)).payload.skills[0].revision, 2, "the project keeps the revision it pinned");
  assert.equal((await service.atRevision(owner, first.id, 2)).payload.digest, edited.payload.digest, "the pinned revision's identity is unchanged");
  await artifacts.preparedRoot(owner, edited.payload);
  await artifacts.preparedRoot(owner, done.skill.payload);
  // Rolling back brings back the pinned revision's own content, package and baseline.
  const rolledBack = await service.restore(owner, first.id, { expectedRevision: 3, revision: 2 });
  assert.equal(rolledBack.payload.digest, edited.payload.digest);
  assert.deepEqual(rolledBack.payload.baseline, edited.payload.baseline);
  assert.deepEqual((await service.history(owner, first.id)).map((/** @type {any} */ row) => row.revision), [4, 3, 2, 1]);
});

test("the same bytes imported without a repository preview are an upload, and a retired skill keeps its history", options, async () => {
  uploads.plain = [skillFile("Plain", "Plain body.")];
  const imported = await service.import(owner, { resourceId: "plain", title: "Plain" });
  assert.equal(imported.payload.package.source.kind, "upload");
  assert.match(imported.payload.package.source.digest, /^sha256:[a-f0-9]{64}$/);
  await service.remove(owner, imported.id, { expectedRevision: 1 });
  const history = await service.history(owner, imported.id);
  assert.equal(history.at(-1).payload.package.digest, imported.payload.digest);
});
