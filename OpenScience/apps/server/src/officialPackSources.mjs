/**
 * The platform's official starter packs, as they are written down: one folder per pack under `capsules/official/`, one text file per
 * method, read once at start.
 *
 * Hidden knowledge:
 *
 * - **The source is a readable folder, and nothing else is the pack.** `capsules/official/<pack>/pack.json` names the pack (its title, the
 *   sentence its card says and its place on the shelf) and every `<method>.md` beside it is one method: a short frontmatter (`scope`,
 *   `whenToUse`), a heading that names it and a body. The people who review the texts read these files, not a database row, and
 *   `officialPacks.mjs` publishes exactly what they read. A pack's version is a hash of what these files say, so a changed word is a new
 *   version and an unchanged folder is the same one however often the server starts.
 * - **A method is short on purpose.** The body is bounded (`OFFICIAL_METHOD_LIMITS`) and written as a condition and what to do under it,
 *   never a checklist the model must walk on every task: a procedure that turns into mandatory work is the harm "Agent Skills Can Be
 *   Harmful" measured, and a focused method beats a bundle (SkillsBench). A method that carries a place to fill says to leave it empty or
 *   to ask when the person did not give what goes there (2026-10-24: remembered formats made the model invent facts in about 70% of partial
 *   replies).
 * - **Scope is the run's, not the text's.** `scope` is `conversation` or the ids of capabilities (`runScopeOf`), the same closed vocabulary a
 *   learned method declares (`provenance.scope`): the mount offers the method to runs of those scopes only.
 * - **What a method may not say is checked in code, once, at publication** (`capsuleScan.mjs`'s closed sets: the platform's own tool and
 *   path names, a link that acts by itself) and again by a test over the shipped folder, so a text that reached the repository with such a
 *   name never reaches an account.
 *
 * @module officialPackSources
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the folders are, relative to this file: `<root>/capsules/official` (the image copies `capsules/` beside `apps/`). */
export const OFFICIAL_PACKS_DIR = fileURLToPath(new URL("../../../capsules/official/", import.meta.url));

/** The bounds of one method's text, in characters: a method is read on the run's own initiative, and read short. */
export const OFFICIAL_METHOD_LIMITS = Object.freeze({ title: 80, whenToUse: 300, body: 1_600, scopes: 4 });
/** The bounds of a pack's card. */
export const OFFICIAL_PACK_LIMITS = Object.freeze({ title: 40, summary: 200, methods: 6 });

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SCOPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The file name of the mounted method, as the run sees it: one name for one method in one pack, whatever its text says. @param {string} packId @param {string} methodId */
export const officialMethodName = (packId, methodId) => `official-${packId}-${methodId}`;
/** The method's identity across versions, as the mount, the receipts and the counters name it. @param {string} packId @param {string} methodId */
export const officialMethodId = (packId, methodId) => `official:${packId}:${methodId}`;
/** @param {unknown} id @returns {{ packId: string, methodId: string } | null} */
export function parseOfficialMethodId(id) {
  const match = /^official:([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)$/.exec(String(id ?? ""));
  return match ? { packId: match[1], methodId: match[2] } : null;
}

/** @param {unknown} value @returns {string} */
const sha256 = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");

/**
 * The text a capsule entry stores for a method: the heading, when it applies, and the body. What the shelf names a received method by is the
 * heading this opens with (`methodHeading` in `capsuleService.mjs`), and what a preview shows of it.
 * @param {{ title: string, whenToUse: string, body: string }} method
 */
export function officialMethodContent(method) {
  return `# ${method.title}\n\n适用：${method.whenToUse}\n\n${method.body}`;
}

/**
 * One method file: `---` frontmatter (`scope`, `whenToUse`), a `# ` heading, the body.
 * @param {string} text @param {string} packId @param {string} methodId
 * @returns {{ method: any } | { issue: string }}
 */
export function parseOfficialMethod(text, packId, methodId) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(String(text ?? ""));
  if (!match) return { issue: "no_frontmatter" };
  /** @type {Record<string, string>} */
  const front = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const pair = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.+)$/.exec(line);
    if (!pair) return { issue: "frontmatter_line_invalid" };
    front[pair[1]] = pair[2].trim();
  }
  if (Object.keys(front).some((key) => !["scope", "whenToUse"].includes(key))) return { issue: "frontmatter_key_unknown" };
  const rest = match[2].replace(/^\s+/, "");
  const heading = /^# (.+)\r?\n/.exec(rest);
  if (!heading) return { issue: "no_heading" };
  const title = heading[1].trim();
  const body = rest.slice(heading[0].length).trim();
  const scope = String(front.scope ?? "").split(/[,，]/).map((entry) => entry.trim()).filter(Boolean);
  const whenToUse = String(front.whenToUse ?? "").trim();
  if (!title || [...title].length > OFFICIAL_METHOD_LIMITS.title) return { issue: "title_invalid" };
  if (!whenToUse || [...whenToUse].length > OFFICIAL_METHOD_LIMITS.whenToUse) return { issue: "when_to_use_invalid" };
  if (!body || [...body].length > OFFICIAL_METHOD_LIMITS.body) return { issue: "body_invalid" };
  if (!scope.length || scope.length > OFFICIAL_METHOD_LIMITS.scopes || new Set(scope).size !== scope.length
    || scope.some((entry) => entry !== "conversation" && !SCOPE_ID.test(entry))) return { issue: "scope_invalid" };
  return { method: buildOfficialMethod(packId, methodId, { scope, title, whenToUse, body }) };
}

/**
 * A method as the publication, the copies and the mount all read it. The text's own limits are the caller's: the folder's methods are held to the
 * short ones (`parseOfficialMethod`), a person's general method that was promoted to the pack of everyone's (`officialPromotion.mjs`) to its own.
 * @param {string} packId @param {string} methodId @param {{ scope: string[], title: string, whenToUse: string, body: string }} fields
 */
export function buildOfficialMethod(packId, methodId, { scope, title, whenToUse, body }) {
  const sha = sha256({ scope, title, whenToUse, body });
  return {
    id: methodId, packId, key: officialMethodId(packId, methodId), name: officialMethodName(packId, methodId), scope, title, description: title, whenToUse, body,
    content: officialMethodContent({ title, whenToUse, body }), sha, version: sha.slice(0, 12),
  };
}

/**
 * The folder's packs and what was wrong with the parts that were refused: a pack with no usable method is left out whole, a method that
 * does not parse is left out and named. Never throws for a text's fault; a folder that cannot be read at all is the one failure.
 * @param {string} [directory]
 * @returns {Promise<{ packs: { id: string, title: string, summary: string, order: number, methods: any[], contentHash: string }[], issues: { pack: string, method?: string, issue: string }[] }>}
 */
export async function readOfficialPackSources(directory = OFFICIAL_PACKS_DIR) {
  /** @type {{ pack: string, method?: string, issue: string }[]} */
  const issues = [];
  const packs = [];
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
    if (/** @type {any} */ (error)?.code === "ENOENT") return { packs: [], issues: [{ pack: "", issue: "directory_missing" }] };
    throw error;
  }
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const packId = entry.name;
    if (!ID.test(packId)) { issues.push({ pack: packId, issue: "pack_id_invalid" }); continue; }
    let card;
    try { card = JSON.parse(await fs.readFile(path.join(directory, packId, "pack.json"), "utf8")); } catch { issues.push({ pack: packId, issue: "pack_json_unreadable" }); continue; }
    const title = String(card?.title ?? "").trim();
    const summary = String(card?.summary ?? "").trim();
    const order = Number.isFinite(Number(card?.order)) ? Number(card.order) : 100;
    if (!title || [...title].length > OFFICIAL_PACK_LIMITS.title || !summary || [...summary].length > OFFICIAL_PACK_LIMITS.summary) { issues.push({ pack: packId, issue: "pack_card_invalid" }); continue; }
    const methods = [];
    const files = (await fs.readdir(path.join(directory, packId))).filter((name) => name.endsWith(".md")).sort();
    for (const file of files) {
      const methodId = file.slice(0, -3);
      if (!ID.test(methodId)) { issues.push({ pack: packId, method: methodId, issue: "method_id_invalid" }); continue; }
      const parsed = parseOfficialMethod(await fs.readFile(path.join(directory, packId, file), "utf8"), packId, methodId);
      if ("issue" in parsed) { issues.push({ pack: packId, method: methodId, issue: parsed.issue }); continue; }
      methods.push(parsed.method);
    }
    if (methods.length > OFFICIAL_PACK_LIMITS.methods) { issues.push({ pack: packId, issue: "too_many_methods" }); continue; }
    if (!methods.length) { issues.push({ pack: packId, issue: "no_method" }); continue; }
    packs.push(officialPack({ id: packId, title, summary, order, methods }));
  }
  return { packs: packs.sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : 1)), issues };
}

/**
 * A pack as the publication reads it, with the hash that is its version: what the pack says and nothing about when or by whom it was read.
 * @param {{ id: string, title: string, summary: string, order: number, methods: any[] }} pack
 */
export function officialPack(pack) {
  const methods = [...pack.methods].sort((left, right) => (left.id < right.id ? -1 : 1));
  const contentHash = sha256({ id: pack.id, title: pack.title, summary: pack.summary, methods: methods.map((method) => ({ id: method.id, sha: method.sha })) });
  return { ...pack, methods, contentHash };
}
