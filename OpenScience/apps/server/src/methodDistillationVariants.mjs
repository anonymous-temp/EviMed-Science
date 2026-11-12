// Shared skill text has no dependency on the services that consume it.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** The capability's switchable sections (`capabilities/method-distillation/variants/<name>.md`): beside SKILL.md, which stays byte-identical. */
const SKILL_VARIANT_DIR = fileURLToPath(new URL("../../../capabilities/method-distillation/variants/", import.meta.url));
export const DISTILLATION_SKILL_VARIANTS = Object.freeze(["camp", "two-stage", "concise"]);
/** @type {Map<string, Promise<string>>} */
const variantTexts = new Map();

/**
 * The text of the switched-on sections of the method-distillation skill, in the order named; empty when none is, so a step with every switch
 * off is sent exactly what it was.
 * @param {readonly string[]} names @returns {Promise<string>}
 */
export async function distillationSkillVariants(names) {
  const texts = [];
  for (const name of names) {
    if (!DISTILLATION_SKILL_VARIANTS.includes(name)) throw new TypeError(`Unknown method-distillation skill variant ${name}.`);
    if (!variantTexts.has(name)) variantTexts.set(name, readFile(`${SKILL_VARIANT_DIR}${name}.md`, "utf8"));
    texts.push(String(await /** @type {Promise<string>} */ (variantTexts.get(name))).trim());
  }
  return texts.join("\n\n");
}

