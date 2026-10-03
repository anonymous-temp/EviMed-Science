import { canonicalExtensionCoordinate, validateSkillWriteRequest } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/** Public account archives carry authored data and desired configuration, never qualification or runtime authority. */
export const EXTENSION_CUSTOMER_KINDS = Object.freeze(["skill", "extension-installation", "extension-defaults"]);
export const EXTENSION_DERIVED_KINDS = Object.freeze(["extension-generation", "extension-proof", "extension-resource"]);

/** @param {any} row */
export function exportExtensionAccountRow(row) {
  const bad = () => { throw new HttpError(503, "account_export_unsupported_state", "Stored extension data needs a supported customer export shape."); };
  const payload = row.payload;
  if (row.kind === "skill") {
    try { validateSkillWriteRequest({ expectedRevision: row.revision, title: payload.title, description: payload.description, instructions: payload.instructions }); }
    catch { return bad(); }
    if (!Array.isArray(payload.resources) || payload.resources.length > 128 || typeof payload.invocation?.userInvocable !== "boolean" || typeof payload.invocation?.modelInvocable !== "boolean") return bad();
    return { ...row, payload: { schemaVersion: 1, title: payload.title, description: payload.description, instructions: payload.instructions,
      invocation: { userInvocable: payload.invocation.userInvocable, modelInvocable: payload.invocation.modelInvocable },
      metadata: payload.metadata ?? {}, whenToUse: payload.whenToUse ?? null,
      resources: payload.resources.map(resource => {
        if (!resource || typeof resource.path !== "string" || !/^resource:[a-f0-9]{64}$/.test(resource.id)
          || !/^sha256:[a-f0-9]{64}$/.test(resource.digest) || !Number.isSafeInteger(resource.size) || resource.size < 0) return bad();
        return { id: resource.id, path: resource.path, digest: resource.digest, size: resource.size };
      }),
      // Import must use native validation and a new owner namespace; archived runtime availability is never accepted.
      prepared: false,
    } };
  }
  if (row.kind === "extension-installation") {
    try { canonicalExtensionCoordinate(payload.coordinate); } catch { return bad(); }
    return { ...row, payload: { schemaVersion: 1, catalogueId: payload.catalogueId, coordinate: payload.coordinate } };
  }
  if (row.kind === "extension-defaults") {
    if (row.id === "skills:defaults" || /^skills:project:[A-Za-z0-9:._-]+$/.test(row.id)) {
      if (!Array.isArray(payload.skills) || payload.skills.length > 64) return bad();
      return { ...row, payload: { skills: payload.skills.map(skill => {
        if (typeof skill.skillId !== "string" || !Number.isSafeInteger(skill.revision) || skill.revision < 1) return bad();
        return { skillId: skill.skillId, revision: skill.revision };
      }) } };
    }
    if (/^extensions:project:[A-Za-z0-9:._-]+$/.test(row.id)) {
      if (!Array.isArray(payload.selections) || payload.selections.length > 128) return bad();
      return { ...row, payload: { schemaVersion: 1, selections: payload.selections.map(selection => {
        try { canonicalExtensionCoordinate(selection.coordinate); } catch { return bad(); }
        if (typeof selection.installationId !== "string" || typeof selection.enabled !== "boolean" || !selection.settings || typeof selection.settings !== "object" || Array.isArray(selection.settings)) return bad();
        return { installationId: selection.installationId, coordinate: selection.coordinate, enabled: selection.enabled, settings: selection.settings,
          connectionRefs: [], reconnectRequired: Array.isArray(selection.connectionRefs) && selection.connectionRefs.length > 0 };
      }) } };
    }
    return bad();
  }
  return row;
}

/** Every referenced historical resource leaves with the user's authored data; authority and orphan uploads do not.
 * Byte retrieval reuses the private artifact boundary and remains authenticated to this snapshot's owner.
 * @param {{artifacts:any,user:any,rows:any[],maxBytes?:number,maxResources?:number}} options */
export async function exportPersonalSkillResources({ artifacts, user, rows, maxBytes = 32 * 1024 * 1024, maxResources = 512 }) {
  const resources = new Map(); let total = 0;
  for (const row of rows) {
    if (row.kind !== "skill") continue;
    const exported = exportExtensionAccountRow(row);
    for (const resource of exported.payload.resources) {
      if (resources.has(resource.id)) {
        const prior = resources.get(resource.id);
        if (prior.digest !== resource.digest || prior.size !== resource.size) throw new HttpError(503, "account_export_unsupported_state", "Stored skill resource identities disagree.");
        continue;
      }
      if (!artifacts) throw new HttpError(503, "account_export_unsupported_state", "Skill resource export is unavailable.");
      if (resources.size >= maxResources || total + resource.size > maxBytes) throw new HttpError(413, "account_export_too_large", "Personal skill resources exceed the export limit.");
      const bytes = await artifacts.resourceBytes(user, resource);
      if (bytes.length !== resource.size) throw new HttpError(503, "account_export_unsupported_state", "Stored skill resource changed.");
      resources.set(resource.id, { id: resource.id, digest: resource.digest, size: resource.size, base64: bytes.toString("base64") });
      total += bytes.length;
    }
  }
  return { resources: [...resources.values()], bytes: total };
}
