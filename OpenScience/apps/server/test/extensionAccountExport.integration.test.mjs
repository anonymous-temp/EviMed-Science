import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { parsePersonalSkill } from "@evimed/harness-port/personal-skills";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { SkillLibraryArtifacts } from "../src/skillLibraryArtifacts.mjs";
import { SkillLibraryService } from "../src/skillLibraryService.mjs";
import { withAccountExportSnapshot } from "../src/accountExport.mjs";
import { ProductDocuments } from "../src/productStore.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const user = { id: `skill_export_${randomUUID()}`, accountCreatedAt: "" };
let database, root, artifacts, service;
before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  const account = await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Export fixture','development') RETURNING created_at::text AS epoch", [user.id]); user.accountCreatedAt = account.rows[0].epoch;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-skill-export-")));
  artifacts = new SkillLibraryArtifacts({ root, parseSkill: parsePersonalSkill, resolveImport: async actor => {
    assert.equal(actor.id, user.id); return [{ type: "file", path: "SKILL.md", bytes: Buffer.from("---\nname: authored-review\ndescription: Review source table\nuser-invocable: false\n---\n\nPreserve quotations.\n") },
      { type: "file", path: "references/example.csv", bytes: Buffer.from("study,count\nfixture,4\n") }];
  } });
  service = new SkillLibraryService(database, { artifacts });
});
after(async () => { if (database) { await database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]); await database.close(); } if (root) await fs.rm(root, { recursive: true, force: true }); });

test("actual account snapshot carries historical personal bytes without importing runtime or proof authority", options, async () => {
  const authored = await service.import(user, { resourceId: "owned-fixture", title: "My review" });
  await service.update(user, authored.id, { expectedRevision: 1, title: "Revised", description: "Same table", instructions: "Also compare the source counts." });
  const documents = new ProductDocuments(database);
  await documents.put(user.id, "extension-proof", "private-derived-proof", { qualified: true, leaseToken: "must-not-export" }, { expectedRevision: 0 });
  await documents.put(user.id, "extension-generation", "private-derived-runtime", { profileRoot: "/private/runtime", token: "must-not-export" }, { expectedRevision: 0 });
  const state = await withAccountExportSnapshot(database, user, {}, async snapshot => JSON.parse(snapshot.data), { skillArtifacts: artifacts });
  const exported = state.documents.find(row => row.id === authored.id);
  assert.equal(exported.payload.prepared, false); assert.equal(exported.payload.invocation.userInvocable, false);
  assert.equal(state.revisions.filter(row => row.id === authored.id).length, 2);
  assert.equal(state.personalSkillResources.length, 1);
  assert.equal(Buffer.from(state.personalSkillResources[0].base64, "base64").toString(), "study,count\nfixture,4\n");
  assert(!JSON.stringify(state).includes("must-not-export")); assert(!JSON.stringify(state).includes("/private/runtime"));
});
