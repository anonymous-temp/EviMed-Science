import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { canonicalJson, canonicalPersonalSkillResourcePath } from "@evimed/domain";
import { SKILL_DISPLAY, SKILL_DISPLAY_GEO_GROUP, SKILL_DISPLAY_GROUPS } from "@evimed/domain/skill-display";
import { SKILL_PACKAGES } from "@evimed/domain/skill-packages";
import { HttpError } from "./security.mjs";

/**
 * The skills the platform ships, as a researcher is offered them: a static
 * catalogue the control plane answers from its own packages, with no runtime,
 * no session and no model behind it.
 *
 * Hidden knowledge: the runtime image's skill roots are listed twice in this
 * product. A live runtime reports what a session loaded (`evimedSkills/list`,
 * `nativeSkillCatalogue.mjs`), which needs a running kernel and an open
 * session, so on the skills page it was most often one line that said it was
 * unavailable. The same skills are also a fact of the release: the package
 * table (`@evimed/domain/skill-packages`) names every one, and the control
 * plane's image carries most of their folders. This answers from those, and
 * only these. A skill the table names but whose folder this image does not
 * carry (the community pack) is still listed — its words come from the display
 * table — and its full text and copy are simply not offered, said plainly
 * instead of failing.
 *
 * The 「循证传播」 method pack is the one root the table cannot name: it is
 * proprietary and reaches an image only through a gitignored folder. Where
 * that folder is present it is listed under its own group, read from the
 * folder; where it is not, there is no such group. Its skills carry no Chinese
 * words of their own, so they are shown by the pack's names and the first
 * sentence of its descriptions, and they can be read but never copied (the
 * pack is the owner's, not a template).
 *
 * A skill's id here is `<origin>:<name>` (`curated:survival-analysis`), the shape every other product id has, so it is one
 * path segment without an encoded slash a proxy might fold.
 *
 * Reading is bounded and refuses links: the folders are the control plane's
 * own image, but a copy ends up in a researcher's account, so what is read is
 * held to the limits the native import path already enforces.
 *
 * @module platformSkillCatalogue
 */

/** The origins the runtime image mounts as skill roots a model can see, and each root's folder under the repository. */
const ROOTS = Object.freeze({
  core: "runtime/skills/core",
  curated: "runtime/skills/curated-scientific",
  office: "runtime/skills/office",
  community: "runtime/skills/community",
  evimed: "runtime/skills/evimed",
});
const GEO_ROOT = "runtime/skills/geo-private/skills";

/** The limits a copy is held to, as the native snapshot's: files, bytes per file, bytes in all, entries visited. */
const LIMITS = Object.freeze({ files: 128, fileBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, entries: 512, instructions: 262144 });
/** The first sentence of a pack description a row shows, at most this many characters. */
const USE_MAX = 80;
/** A listing is read from disk at most this often. */
const LISTING_TTL_MS = 60_000;

/** @param {Buffer | string} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The front matter of a skill file and the text after it. @param {string} text */
export function splitSkillText(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text };
  let meta = {};
  try { const parsed = parseYaml(match[1]); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed; } catch { /* a skill whose front matter is not YAML has no meta */ }
  return { meta: /** @type {Record<string, any>} */ (meta), body: match[2].replace(/^\s+/, "") };
}

/** The first sentence of a description, whole words, bounded. @param {unknown} description */
function firstSentence(description) {
  const flat = String(description ?? "").replace(/\s+/g, " ").trim();
  const end = flat.search(/[.。]\s|[.。]$/);
  const sentence = end > 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > USE_MAX ? `${sentence.slice(0, USE_MAX - 1)}…` : sentence;
}

/**
 * Every file of one skill folder, as the native import path takes them: path,
 * size, digest, bytes. Links, odd names and anything past a limit refuse the
 * whole read, so a copy is the folder or nothing.
 * @param {string} directory @returns {Promise<{ path: string, size: number, digest: string, bytesBase64: string }[]>}
 */
export async function readSkillFolder(directory) {
  const unavailable = () => new HttpError(503, "skill_platform_unreadable", "The skill's files are unavailable.");
  const prefixes = new Map(), identities = new Set();
  /** @type {{ path: string, size: number, digest: string, bytesBase64: string }[]} */
  const entries = [];
  let visited = 0, total = 0;
  /** @param {string} current @param {string} relative */
  const visit = async (current, relative) => {
    for (const name of (await fs.readdir(current)).sort()) {
      if (++visited > LIMITS.entries) throw unavailable();
      const raw = relative ? `${relative}/${name}` : name;
      const canonical = canonicalPersonalSkillResourcePath(raw, prefixes);
      if (canonical.path !== raw || identities.has(canonical.key)) throw unavailable();
      identities.add(canonical.key);
      const target = path.join(current, name), info = await fs.lstat(target);
      if (info.isSymbolicLink()) throw unavailable();
      if (info.isDirectory()) { await visit(target, raw); continue; }
      if (!info.isFile() || info.size > LIMITS.fileBytes || entries.length >= LIMITS.files + 1
        || (raw !== "SKILL.md" && canonical.key.split("/").at(-1) === "skill.md")) throw unavailable();
      total += info.size;
      if (total > LIMITS.totalBytes) throw unavailable();
      const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = await file.readFile();
        entries.push({ path: raw, size: bytes.length, digest: `sha256:${sha256(bytes)}`, bytesBase64: bytes.toString("base64") });
      } finally { await file.close(); }
    }
  };
  await visit(directory, "");
  if (entries.filter((entry) => entry.path === "SKILL.md").length !== 1) throw unavailable();
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * @param {{ rootDir: string, packages?: ReadonlyMap<string, any>, display?: typeof SKILL_DISPLAY, now?: () => number }} options
 */
export function createPlatformSkillCatalogue({ rootDir, packages = SKILL_PACKAGES, display = SKILL_DISPLAY, now = () => Date.now() }) {
  /** @type {{ at: number, rows: any[] } | null} */
  let cached = null;

  /** @param {string} directory */
  const present = (directory) => fs.access(path.join(directory, "SKILL.md")).then(() => true, () => false);

  /** The pack's skills, when its folder is here. @returns {Promise<any[]>} */
  async function geoRows() {
    const root = path.join(rootDir, GEO_ROOT);
    /** @type {import("node:fs").Dirent[]} */
    let folders = [];
    try { folders = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()); } catch { return []; }
    const found = [];
    for (const entry of folders.sort((left, right) => left.name.localeCompare(right.name))) {
      const directory = path.join(root, entry.name);
      try {
        const { meta } = splitSkillText(await fs.readFile(path.join(directory, "SKILL.md"), "utf8"));
        found.push({ id: `geo-private:${entry.name}`, name: entry.name, title: String(meta.name ?? entry.name), use: firstSentence(meta.description),
          group: SKILL_DISPLAY_GEO_GROUP, source: "platform", canCopy: false, directory });
      } catch { /* a folder without a readable skill file is not a skill */ }
    }
    return found;
  }

  /** Every skill, each with the folder it is read from when this image carries it (otherwise null). @returns {Promise<any[]>} */
  async function rows() {
    if (cached && now() - cached.at < LISTING_TTL_MS) return cached.rows;
    const listed = [];
    for (const record of packages.values()) {
      if (!Object.hasOwn(ROOTS, record.origin)) continue;
      const words = display[record.name];
      // A skill the table does not carry is a build that shipped it without its words: it is left out rather than shown as an identifier.
      if (!words) continue;
      const directory = path.join(rootDir, ROOTS[/** @type {keyof typeof ROOTS} */ (record.origin)], record.name);
      const readable = await present(directory);
      listed.push({ id: `${record.origin}:${record.name}`, name: record.name, title: words.title, use: words.use, group: words.group,
        source: record.origin === "community" ? "community" : "platform", canCopy: readable, directory: readable ? directory : null });
    }
    const order = new Map(Object.keys(display).map((name, index) => [name, index]));
    listed.sort((left, right) => SKILL_DISPLAY_GROUPS.indexOf(left.group) - SKILL_DISPLAY_GROUPS.indexOf(right.group)
      || (order.get(left.name) ?? 0) - (order.get(right.name) ?? 0));
    const all = [...listed, ...await geoRows()];
    cached = { at: now(), rows: all };
    return all;
  }

  /** @param {string} id */
  async function find(id) {
    const row = (await rows()).find((candidate) => candidate.id === id);
    if (!row) throw new HttpError(404, "skill_platform_not_found", "This skill is not part of the platform's skills.");
    return row;
  }

  /** What a browser is given of a row: never the folder it was read from. @param {any} row */
  const publicRow = ({ directory: _directory, ...row }) => row;

  return {
    /** Every skill a researcher is offered, in the groups' order (a group with no skill is simply not drawn). */
    async list() {
      return { groups: [...SKILL_DISPLAY_GROUPS], items: (await rows()).map(publicRow) };
    },
    /** One skill: its words and, where this image carries the folder, its full text. @param {string} id */
    async read(id) {
      const row = await find(id);
      let instructions = null;
      if (row.directory) {
        try {
          const { body } = splitSkillText(await fs.readFile(path.join(row.directory, "SKILL.md"), "utf8"));
          instructions = Buffer.byteLength(body) <= LIMITS.instructions ? body : null;
        } catch { instructions = null; }
      }
      return { ...publicRow(row), when: display[row.name]?.when ?? null, instructions };
    },
    /**
     * The folder of a copyable skill as the native importer takes it, with the
     * digest a copy remembers its origin by.
     * @param {string} id
     */
    async snapshot(id) {
      const row = await find(id);
      if (!row.canCopy || !row.directory) throw new HttpError(409, "skill_platform_not_copyable", "This skill cannot be copied.");
      const entries = await readSkillFolder(row.directory);
      const digest = `sha256:${sha256(canonicalJson(entries.map(({ bytesBase64: _bytes, ...entry }) => entry)))}`;
      return { name: row.name, title: row.title, digest, entries };
    },
    /** Forget the listing (a test that changes a folder). */
    reset() { cached = null; },
  };
}
