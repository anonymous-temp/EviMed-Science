import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import YAML from "yaml";

/**
 * A method pack in the Agent Skills open format (evidence-flywheel plan §7, F17c, 2026-10-05): one folder per approved learned
 * method holding a `SKILL.md` and a `PROVENANCE.md`, zipped. What a researcher trained in EviMed leaves with them, in the shape
 * the same skill is written in everywhere else, carrying who made it.
 *
 * The format relied on is the open specification at https://agentskills.io/specification, read on 2026-10-05:
 *
 * - a skill is a directory holding at least `SKILL.md`: YAML front matter, then Markdown;
 * - `name` (required): 1-64 characters, lowercase letters, digits and hyphens only, no leading or trailing hyphen, no two hyphens
 *   in a row, and equal to the parent directory's name;
 * - `description` (required): 1-1024 characters, non-empty, what the skill does and when to use it;
 * - `license`, `compatibility` (1-500), `metadata` (string to string) and `allowed-tools` are optional and none is written here;
 * - the body has no format restriction (the spec recommends under 500 lines); `scripts/`, `references/` and `assets/` are optional
 *   and none is written here.
 *
 * Hidden knowledge:
 *
 * - **Text only, and nothing is run.** The folder holds the two Markdown files and no `scripts/`, no assets, no tool definition,
 *   whatever the method carries in the platform (a learned method may own script files; they are never read here). A fenced block
 *   whose language is a script's (`bash`, `python`, `r`, …) or that starts with a shebang stays in the text exactly as written, and
 *   a line after it says scripts are not shared between users: the reader is told what the block is, and the author's words are not
 *   silently edited. The language list is a closed vocabulary — a format check, not a reading of prose.
 * - **The name is made, not trusted.** A method's own name becomes a spec-valid slug (ASCII only, deduplicated); one that has no
 *   letters or digits to keep gets `method-` and eight hex characters of its text's digest.
 * - **The snapshot hash names this pack.** It is the SHA-256 of the folder names and the digests of their `SKILL.md` files, so two
 *   exports of the same methods carry the same hash and a changed method changes it.
 *
 * @module capsuleMethodPack
 */

export const AGENT_SKILLS_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const AGENT_SKILLS_NAME_MAX = 64;
export const AGENT_SKILLS_DESCRIPTION_MAX = 1024;
/** What a fenced block's first word may be for the block to be a script to execute. Closed. */
const SCRIPT_LANGUAGES = new Set(["bash", "sh", "shell", "zsh", "fish", "powershell", "pwsh", "ps1", "bat", "cmd", "batch",
  "python", "python3", "py", "node", "javascript", "js", "mjs", "typescript", "ts", "r", "perl", "ruby", "rb", "php", "lua", "sql", "stata", "sas", "matlab"]);
export const SCRIPTS_NOT_SHARED_LINE = "> 脚本不在用户之间分享 (scripts are not shared between users)：上面的代码块只作为文字保留，没有被运行，也没有被审核。";

const sha256 = (/** @type {string | Uint8Array} */ value) => createHash("sha256").update(value).digest("hex");

/** @param {string} value @returns {string} a valid Agent Skills name, or "" when nothing of it survives */
export function agentSkillName(value) {
  const slug = String(value ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, AGENT_SKILLS_NAME_MAX).replace(/-+$/g, "");
}

/**
 * A method's Markdown with the line after each script block that says what it is. The block itself is untouched.
 * @param {string} body @returns {{ text: string, scripts: number }}
 */
export function markScriptBlocks(body) {
  const lines = String(body ?? "").split("\n");
  /** @type {string[]} */
  const out = [];
  let scripts = 0;
  let fence = null;
  let script = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    out.push(line);
    if (fence === null) {
      const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
      if (open) {
        fence = open[1];
        const language = open[2].toLowerCase().replace(/^\{?\.?/, "").replace(/\}$/, "");
        const shebang = /^#!/.test(lines[index + 1] ?? "");
        script = SCRIPT_LANGUAGES.has(language) || shebang;
      }
    } else if (line.trim().startsWith(fence[0].repeat(fence.length)) && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) {
      fence = null;
      if (script) { out.push("", SCRIPTS_NOT_SHARED_LINE); scripts += 1; }
      script = false;
    }
  }
  // A block the text never closed is still a block: say so after the end.
  if (fence !== null && script) { out.push("", SCRIPTS_NOT_SHARED_LINE); scripts += 1; }
  return { text: out.join("\n"), scripts };
}

/**
 * One method's `SKILL.md`. `name` is the folder's name and the front matter's field together: the spec requires them equal.
 * @param {{ name: string, description: string, whenToUse?: string, body: string }} method @param {string} name
 * @returns {{ skill: string, scripts: number }}
 */
function skillText(method, name) {
  const description = String(method.description ?? "").replace(/\s+/g, " ").trim();
  const firstLine = String(method.body ?? "").split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  const described = (description || firstLine || "A research method shared from EviMed.").slice(0, AGENT_SKILLS_DESCRIPTION_MAX).trim();
  const front = YAML.stringify({ name, description: described }, { lineWidth: 0 });
  const marked = markScriptBlocks(String(method.body ?? "").trim());
  const when = String(method.whenToUse ?? "").replace(/\s+/g, " ").trim();
  const title = String(method.name ?? "").replace(/\s+/g, " ").trim() || name;
  return { skill: `---\n${front}---\n\n# ${title}\n\n${when ? `适用 (when to use)：${when}\n\n` : ""}${marked.text}\n`, scripts: marked.scripts };
}

/**
 * The pack: a zip of one folder per method, and what it says about itself.
 * @param {{ methods: readonly { name: string, description: string, whenToUse?: string, body: string }[], authorName: string, exportedAt?: Date }} input
 * @returns {{ zip: Uint8Array, count: number, scripts: number, snapshotHash: string, folders: string[] }}
 */
export function buildAgentSkillsPack({ methods, authorName, exportedAt = new Date() }) {
  /** @type {Record<string, Uint8Array>} */
  const files = {};
  /** @type {string[]} */
  const folders = [];
  /** @type {{ folder: string, digest: string }[]} */
  const digests = [];
  let scripts = 0;
  const author = String(authorName ?? "").replace(/\s+/g, " ").trim() || "(unnamed)";
  const date = exportedAt.toISOString();
  const drafts = methods.map((method) => {
    const slug = agentSkillName(method.name) || `method-${sha256(String(method.body ?? "")).slice(0, 8)}`;
    return { method, slug };
  });
  const taken = new Set();
  const rendered = drafts.map(({ method, slug }) => {
    let name = slug;
    for (let n = 2; taken.has(name); n += 1) name = `${slug.slice(0, AGENT_SKILLS_NAME_MAX - String(n).length - 1).replace(/-+$/g, "")}-${n}`;
    taken.add(name);
    const text = skillText(method, name);
    scripts += text.scripts;
    return { name, text: text.skill };
  });
  for (const { name, text } of rendered) { digests.push({ folder: name, digest: sha256(text) }); }
  const snapshotHash = sha256(JSON.stringify(digests.sort((left, right) => (left.folder < right.folder ? -1 : left.folder > right.folder ? 1 : 0))));
  for (const { name, text } of rendered) {
    files[`${name}/SKILL.md`] = strToU8(text);
    files[`${name}/PROVENANCE.md`] = strToU8([
      "# Provenance", "",
      `- Author (作者): ${author}`,
      "- Shared from: EviMed",
      `- Snapshot: sha256:${snapshotHash}`,
      `- Exported (日期): ${date}`,
      "- Contents: text only. No scripts, attachments or tool definitions are shared between users.", "",
    ].join("\n"));
    folders.push(name);
  }
  return { zip: zipSync(files, { level: 6, mtime: exportedAt }), count: rendered.length, scripts, snapshotHash, folders };
}
