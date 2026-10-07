import { createHash } from "node:crypto";

export const MODULE_EVOLUTION_SURFACES = Object.freeze({
  frontier: ["screenInstructions", "editInstructions", "selectionThreshold"],
  autopilot: ["plannerInstructions"],
  geo: ["supplements"],
});

/** Only bounded, declared data may enter a serving policy. @param {string} moduleId @param {any} policy */
export function validateModuleEvolutionPolicy(moduleId, policy) {
  const fields = MODULE_EVOLUTION_SURFACES[moduleId];
  if (!fields || !policy || typeof policy !== "object" || Array.isArray(policy)
    || Object.keys(policy).some((key) => !fields.includes(key))) return false;
  return Object.entries(policy).every(([key, value]) => {
    if (key === "selectionThreshold") return Number.isFinite(value) && value >= 0 && value <= 100;
    if (key === "supplements") return Array.isArray(value) && value.length <= 6 && value.every((item) =>
      item && Object.keys(item).every((field) => ["capabilityId", "text"].includes(field))
      && ["geo-insight", "geo-strategy", "geo-content", "geo-proposal"].includes(item.capabilityId)
      && typeof item.text === "string" && item.text.length > 0 && item.text.length <= 2000);
    return typeof value === "string" && value.trim().length > 0 && value.length <= 24000;
  });
}

/** The reader hydrates a product-ledger revision, never a module or a file path.
 * @param {{readPolicy?: (moduleId: string) => Promise<any>}} [dependencies] */
export function createModuleEvolutionPolicies({ readPolicy = async () => null } = {}) {
  return {
    /** @param {string} moduleId @param {Record<string, any>} defaults */
    async resolve(moduleId, defaults) {
      const fallback = { revisionId: `default:${createHash("sha256").update(JSON.stringify(defaults)).digest("hex")}`, policy: structuredClone(defaults) };
      try {
        const revision = await readPolicy(moduleId);
        if (!revision || typeof revision.revisionId !== "string" || !revision.revisionId
          || !validateModuleEvolutionPolicy(moduleId, revision.policy)) return fallback;
        return { revisionId: revision.revisionId, policy: { ...structuredClone(defaults), ...structuredClone(revision.policy) } };
      } catch { return fallback; }
    },
  };
}
