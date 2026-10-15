/**
 * The method pack's index: each skill's name and the first sentence of its description — and nothing of its body.
 *
 * Hidden knowledge: the pack (51 skills, `runtime/skills/geo-private`) is proprietary, the web image used to carry none
 * of it, and so the skills page's 「循证 GEO」 group read a folder that was not there and was never drawn, while the
 * runtime image mounted all 51 into every session. What a person is shown of a skill is its name and what it is for, and
 * that is all this file holds: the web image copies this one file and no skill, `shared/` or reference with it. The names
 * and sentences are what the skills page already printed where the folder was present; a skill's text, scripts and rules
 * stay on the build machine and in the runtime image.
 *
 * The index is written beside the pack (`runtime/skills/geo-private/geo-pack-index.json`, git-ignored like the rest of
 * that root) by `vendor-geo-skills.mjs`, which is the only place the pack is unpacked, and by `--index` for a pack an
 * earlier version of that script vendored. A tree with no pack gets an index of no skills, so the web image's one COPY
 * of it never fails and the group is simply not drawn.
 *
 * @module scripts/build/geo-pack-index
 */

import fs from "node:fs/promises";
import path from "node:path";

/** The index's file name inside the private root. */
export const GEO_PACK_INDEX_FILE = "geo-pack-index.json";

/**
 * @typedef {object} GeoPackIndex
 * @property {number} schemaVersion
 * @property {string} package the pack's name, from its stamp
 * @property {string | null} version the vendored version, from its stamp
 * @property {{ name: string, title: string, use: string }[]} skills sorted by folder name
 */

/**
 * The index of the pack vendored under a private root.
 * @param {string} root the private root (`runtime/skills/geo-private`)
 * @returns {Promise<GeoPackIndex>}
 */
export async function buildGeoPackIndex(root) {
  // Read lazily: the unpacking half of the vendoring script needs the standard library only.
  const { firstSentence, splitSkillText } = await import("../../apps/server/src/platformSkillCatalogue.mjs");
  const stamp = JSON.parse(await fs.readFile(path.join(root, "VENDORED.json"), "utf8").catch(() => "null"));
  /** @type {import("node:fs").Dirent[]} */
  let folders = [];
  try { folders = (await fs.readdir(path.join(root, "skills"), { withFileTypes: true })).filter((entry) => entry.isDirectory()); } catch { /* no pack here */ }
  /** @type {GeoPackIndex["skills"]} */
  const skills = [];
  for (const entry of folders.sort((left, right) => left.name.localeCompare(right.name))) {
    try {
      const { meta } = splitSkillText(await fs.readFile(path.join(root, "skills", entry.name, "SKILL.md"), "utf8"));
      skills.push({ name: entry.name, title: String(meta.name ?? entry.name), use: firstSentence(meta.description) });
    } catch { /* a folder without a readable skill file is not a skill */ }
  }
  return { schemaVersion: 1, package: String(stamp?.package ?? "geo-skills"), version: typeof stamp?.version === "string" ? stamp.version : null, skills };
}

/** @param {GeoPackIndex} index */
const render = (index) => `${JSON.stringify(index, null, 2)}\n`;

/**
 * Writes the index beside the pack, only when it differs from what is there.
 * @param {string} root
 * @returns {Promise<{ status: "written" | "unchanged", skills: number, file: string }>}
 */
export async function writeGeoPackIndex(root) {
  const file = path.join(root, GEO_PACK_INDEX_FILE);
  const index = await buildGeoPackIndex(root);
  const text = render(index);
  const current = await fs.readFile(file, "utf8").catch(() => null);
  if (current === text) return { status: "unchanged", skills: index.skills.length, file };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(file, text);
  return { status: "written", skills: index.skills.length, file };
}

/**
 * Whether the index beside the pack is the one its skills make.
 * @param {string} root
 * @returns {Promise<boolean>}
 */
export async function geoPackIndexIsCurrent(root) {
  const current = await fs.readFile(path.join(root, GEO_PACK_INDEX_FILE), "utf8").catch(() => null);
  return current === render(await buildGeoPackIndex(root));
}
