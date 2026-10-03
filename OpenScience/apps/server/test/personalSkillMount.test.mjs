import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { personalSkillName } from "@evimed/domain";
import { selectPersonalSkillMounts } from "../src/personalSkillMount.mjs";

const user = { id: "alice" }, project = { id: "one", userId: "alice" };
const sha = value => createHash("sha256").update(value).digest("hex");
function fixture() {
  const payload = { nativeName: personalSkillName(user.id, "skill1", sha), digest: `sha256:${"a".repeat(64)}`, prepared: true,
    title: "My review", instructions: "Check sources.", invocation: { userInvocable: false, modelInvocable: true } };
  const selection = { revision: 1, payload: { skills: [{ skillId: "skill1", revision: 2, digest: payload.digest }] } };
  const reads = [];
  const service = { requireProject: async () => {}, projectSelections: async () => structuredClone(selection),
    atRevision: async () => ({ revision: 2, payload }), artifacts: { preparedRoot: async (owner, value) => { reads.push({ owner, value }); return "/private/path/never-in-wire"; } } };
  return { service, payload, selection, reads };
}
test("mount selection pins native identity/revision/policy and exposes no filesystem locator", async () => {
  const { service, payload, reads } = fixture();
  const selected = await selectPersonalSkillMounts({ service, user, project });
  assert.equal(selected.skills[0].revision, 2); assert.deepEqual(selected.skills[0].invocation, payload.invocation);
  assert.equal(reads[0].owner, user); assert.equal(selected.skills[0].contentId, "a".repeat(64));
  assert(!JSON.stringify(selected).includes("/private/path"));
  await assert.rejects(selectPersonalSkillMounts({ service, user: { id: "bob" }, project }), { status: 404 });
});
test("optional missing/tampered or over-budget skill is omitted with a bounded finding", async () => {
  const { service, payload } = fixture(); payload.nativeName = "clinical-evidence-synthesis";
  let selected = await selectPersonalSkillMounts({ service, user, project }); assert.equal(selected.skills.length, 0); assert.equal(selected.findings[0].code, "extension_contract_invalid");
  payload.nativeName = personalSkillName(user.id, "skill1", sha);
  selected = await selectPersonalSkillMounts({ service, user, project, maxInstructionBytes: 1 }); assert.equal(selected.skills.length, 0);
  service.artifacts.preparedRoot = async () => { throw Object.assign(Error("secret diagnostic /private/path"), { code: "path_forbidden" }); };
  selected = await selectPersonalSkillMounts({ service, user, project }); assert.deepEqual(selected.findings, [{ skillId: "skill1", revision: 2, code: "path_forbidden" }]);
});
test("revocation/selection changes during hydration are rechecked before publication", async () => {
  const { service, selection } = fixture(); let calls = 0;
  service.projectSelections = async () => ({ ...selection, revision: ++calls });
  await assert.rejects(selectPersonalSkillMounts({ service, user, project }), { code: "product_revision_conflict" });
});
