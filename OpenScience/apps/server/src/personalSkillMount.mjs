import { createHash } from "node:crypto";
import { personalSkillName } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/** @param {string} value */
const sha = value => createHash("sha256").update(value).digest("hex");

/** Select exact private revisions for one authenticated project; optional failures do not replace the research preset.
 * The controller receives opaque identities only, then independently snapshots and mounts read-only bytes.
 * @param {{service:any,user:any,project:any,maxSkills?:number,maxInstructionBytes?:number}} options */
export async function selectPersonalSkillMounts({ service, user, project, maxSkills = 64, maxInstructionBytes = 1024 * 1024 }) {
  if (!service || !user?.id || !project?.id || project.userId !== user.id) throw new HttpError(404, "project_not_found", "Project not found.");
  await service.requireProject(user, project);
  const selected = await service.projectSelections(user, project);
  if (!Array.isArray(selected.payload.skills) || selected.payload.skills.length > maxSkills) throw new HttpError(400, "extension_contract_invalid", "Invalid project skill inventory.");
  const skills = [], findings = [], seen = new Set(); let bytes = 0;
  for (const wanted of selected.payload.skills) {
    if (seen.has(wanted.skillId)) throw new HttpError(400, "extension_contract_invalid", "Duplicate project skill.");
    seen.add(wanted.skillId);
    try {
      const revision = await service.atRevision(user, wanted.skillId, wanted.revision);
      const payload = revision.payload;
      if (payload.digest !== wanted.digest || payload.nativeName !== personalSkillName(user.id, wanted.skillId, sha)
        || payload.prepared !== true || typeof payload.invocation?.userInvocable !== "boolean" || typeof payload.invocation?.modelInvocable !== "boolean") {
        throw new HttpError(409, "extension_contract_invalid", "The selected skill revision changed.");
      }
      const size = Buffer.byteLength(payload.instructions, "utf8");
      if (bytes + size > maxInstructionBytes) throw new HttpError(413, "extension_contract_invalid", "The project skill budget is full.");
      // This validates the canonical manifest and every resource byte without exposing any absolute path to the kernel wire.
      await service.artifacts.preparedRoot(user, payload);
      skills.push({ skillId: wanted.skillId, revision: wanted.revision, digest: payload.digest, nativeName: payload.nativeName,
        invocation: payload.invocation, title: payload.title, ownerHash: sha(user.id), contentId: payload.digest.slice(7) });
      bytes += size;
    } catch (error) {
      // An unavailable personal method is omitted explicitly; built-in capabilities and the last serving generation remain usable.
      findings.push({ skillId: wanted.skillId, revision: wanted.revision, code: ["product_document_not_found", "extension_contract_invalid", "path_forbidden", "product_state_unavailable"].includes(error?.code)
        ? error.code : "extension_contract_invalid" });
    }
  }
  // Selection changes during asynchronous validation are not silently published under the earlier digest.
  const current = await service.projectSelections(user, project);
  if (current.revision !== selected.revision) throw new HttpError(409, "product_revision_conflict", "Project skills changed before preparation finished.");
  return { selectionRevision: selected.revision, skills, findings, instructionBytes: bytes };
}
