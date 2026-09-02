#!/usr/bin/env node
/**
 * The kernel settings we depend on being a particular value, checked against
 * what the image actually composed - at test time, not at run time.
 *
 * Hidden knowledge: the dangerous upstream change is not the one that errors.
 * A deleted package fails the loader and something says so
 * (`verify-composition-references.mjs` owns that). A moved *default* fails
 * nothing: our composition text is byte-identical, the container boots, the run
 * works, and one guarantee is quietly gone. DSH 0.1.2-alpha.4 enabled
 * `web_fetch` by default "for Python SDK, Headless, ACP and custom Profiles" --
 * we are a custom profile, and our security invariant is that the runtime
 * reaches the internet only through the control plane's gateway, which resolves
 * DOIs, refuses private and link-local addresses before it fetches, and records
 * what it fetched. A second, unrecorded egress path defeats all three, and a run
 * that used it looks exactly like a run that did not.
 *
 * The build already refuses when the image's `--dump-config` differs from the
 * committed baseline (the `diff -u` in deploy/runtime-dsh/Dockerfile). That
 * catches "something moved" but not "which of the things that moved were load
 * bearing" -- and its remedy, re-recording the baseline, is exactly how a
 * security-relevant flip gets laundered into an accepted new baseline. This
 * checker is the half the diff cannot do: it names the settings we depend on,
 * says why for each, and goes red when the recorded reality stops matching them.
 * A re-recorded baseline with `web-fetch-http` enabled fails here.
 *
 * What "the current effective configuration" means, and why the default is what
 * it is:
 *
 *   deploy/runtime-dsh/dump-config.baseline.json is the *host* composition the
 *   built image resolved, after `@evimed/dsh-socket`'s own patch was applied --
 *   the `# == ..., patched by @evimed/dsh-socket` markers in it are that patch
 *   landing. The Dockerfile refuses to build an image whose dump differs from
 *   it, so the committed file is not a wish: it is the effective configuration
 *   of the image we ship, held there by the build. Checking invariants against
 *   it is checking the real thing.
 *
 *   A checkout has no second configuration to diff against, because it has no
 *   container. `--dump <file>` supplies one -- build a candidate image, dump it,
 *   and this becomes "what would change if we moved to alpha.5, and which of
 *   those changes are ours". Without `--dump` there is no drift comparison and
 *   the report says so on its own line rather than printing "0 differences",
 *   which would read as "nothing drifted".
 *
 * Three classes of difference:
 *   pinned            a value we hold ourselves. Must still be ours, or the run fails.
 *   upstream-default  a value we do not hold. Reported as a notice, old to new.
 *   unknown           a row or key the baseline has never seen. Reported. Never
 *                     dropped: the next flip will arrive under a name nobody
 *                     here has written down yet, and "we had no opinion" must
 *                     still print.
 *
 * The invariant list is derived from the composition wherever the composition
 * states it, because a second copy of a rule drifts from the first:
 *   - every host-scope override in packages/socket/cordis.patch.yml (an `id:`
 *     with no `name:`) becomes an invariant, and its WHY is the comment block
 *     the patch already carries above that row;
 *   - the preset's "Deliberately absent, each for a reason:" block becomes one
 *     absence invariant per named tool, with the reason the preset already gives.
 * What is left is DECLARED_INVARIANTS below -- upstream defaults we depend on
 * but do not set, which by definition appear in no file of ours. Each names a
 * row that must exist in the source it claims, so a stale entry fails loudly
 * instead of matching nothing and passing.
 *
 * Usage:
 *   node scripts/ops/check-kernel-defaults.mjs [--json] [--dump <file>]
 *
 * @module check-kernel-defaults
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Repo-relative, so every message names a path a person can open. */
export const SOURCES = {
  baseline: "deploy/runtime-dsh/dump-config.baseline.json",
  patch: "packages/socket/cordis.patch.yml",
  preset: "packages/socket/presets/evimed-universal/agent.cordis.yml",
  pins: "deps-version.json",
};

/**
 * Which kernel produced the committed baseline, and over which bytes that claim
 * was made.
 *
 * The marker lives here rather than inside the baseline because the Dockerfile
 * byte-diffs that file against the dump the image generates: a provenance line
 * added to it would differ from the image's own output and fail every build.
 * So the claim sits beside the checker, and the digest is what stops it going
 * stale in silence -- re-recording the baseline changes its bytes, which forces
 * whoever re-recorded it to come here and say which version produced it. A
 * baseline from another version, compared without anyone noticing, is worse
 * than no baseline at all: it certifies invariants against a kernel we do not
 * ship.
 */
export const BASELINE_PROVENANCE = {
  dshVersion: "0.1.2-alpha.3",
  sha256: "6510a0bfd604c7817814549919ead62c4eafbcf465f79e7fdd35d958272fda5c",
  recordedBy: "deploy/runtime-dsh/Dockerfile - `dsh --profile evimed-runtime --dump-config` on the seeded profile",
};

/**
 * Floors, not exact counts. An exact count is a third copy of the composition
 * and goes red on every legitimate row added; a floor catches the only thing a
 * count can catch, which is an extractor that stopped matching -- and an
 * extractor that matches nothing reports nothing wrong, which is what a passing
 * run looks like.
 */
export const EXTRACTION_FLOORS = {
  baselineRows: 100, // today: 148
  presetRows: 16, // today: 24, counting group children
  derivedFromPatch: 4, // today: 4 host-scope overrides
  // Not a floor. A floor is what let a defeated parse pass: nine named tools
  // with a floor of six meant three could vanish and the run stayed green.
  // Changing this number is how a reviewer says "the composition's ban list
  // changed on purpose", which is exactly the moment worth stopping at.
  derivedFromAbsentListExactly: 9,
};

/**
 * Upstream defaults we depend on but do not set ourselves, plus the two
 * addresses our generated profile patch writes to.
 *
 * Reviewed by hand because there is nowhere to derive them from: a default we
 * do not override appears in no file of ours, and an address we write to is a
 * string in a generator. Every entry names a row, and a row that is not in the
 * source it claims is reported as `row-missing` -- an invariant that matches
 * nothing is an invariant that passes forever.
 *
 * Deliberately NOT here: `web.fetchProvider`. The patch leaves it alone on
 * purpose -- it is a free-form string naming a registered provider, so `none`
 * would not be a configured refusal but a name that happens to match nothing,
 * and it would stop protecting anything the day someone registers a provider by
 * that name. The refusal that does hold is `web-fetch-http: disabled`, derived
 * from the patch. Also not here: `session-telemetry-otel.mode`. The patch
 * disables the whole plugin rather than choosing a mode, precisely so that
 * upstream moving the mode default (DISABLED to FEEDBACK_ONLY, in 0.1.2) cannot
 * reach us; pinning the mode here would encode the belief that file rejects.
 */
export const DECLARED_INVARIANTS = [
  {
    scope: "host",
    row: "tool-web",
    key: "disabled",
    assert: "equals",
    value: "true",
    why:
      "Upstream's own web-app patch disables the web tool; we do not pin it, we depend on it. 0.1.2-alpha.4 turned web_fetch on by default for custom profiles - the same silent flip, one row over - and this runtime may reach the internet only through the control plane's gateway.",
  },
  {
    scope: "host",
    row: "tool-web",
    key: "config.fetch",
    assert: "equals",
    value: "false",
    why:
      "The second half of the same upstream default: even mounted, the web tool must not offer fetch. Two independent conditions, because a composition is one edit away from gaining a tool.",
  },
  {
    scope: "host",
    row: "skill-filesystem",
    key: "disabled",
    assert: "equals",
    value: "true",
    why:
      "The host-scope skill loader carries no `includeDefaultRoots: false`, so enabling it would discover `.dsh/skills` under the process working directory - which in a runtime container is /workspace, the user's own upload directory. An uploaded SKILL.md would become an instruction.",
  },
  {
    scope: "host",
    row: "agent-instructions",
    key: "disabled",
    assert: "equals",
    value: "true",
    why:
      "It injects AGENTS.md from the workspace and from every directory a run touches. The workspace is user upload space, so an uploaded file would become an instruction.",
  },
  {
    scope: "host",
    row: "session-query-sqlite",
    key: "config.path",
    assert: "equals",
    value: ":memory:",
    // Not an upstream default we leave alone: `dshProfilePatch.mjs` writes this
    // value into every generated profile, and the reason is stated there. It
    // was filed here as "a default we do not set", which is the kind of wrong
    // description that survives review because the assertion still passes.
    // What this entry actually guards is that the generated patch has not
    // stopped saying it — so the reason is referenced, not restated, because a
    // retyped reason drifts from the first the moment one is edited.
    why:
      "Set by us, not inherited: see the comment above `- id: session-query-sqlite` in apps/server/src/dshProfilePatch.mjs. "
      + "This entry checks the value survives into the effective composition.",
  },
  {
    scope: "host",
    row: "sandbox-policy",
    key: "config.mode",
    assert: "contains",
    value: "DSH_PERMISSION_MODE",
    why:
      "runtimeManager passes DSH_PERMISSION_MODE=workspace-write into every container. A lever only levers while the row still reads that name: renamed upstream, the container keeps starting, on whatever this row defaults to, and nothing says a word.",
  },
  {
    scope: "host",
    row: "approval",
    key: "config.policy",
    assert: "present",
    why:
      "The generated profile patch writes the unattended policy here. An earlier version of it addressed a `permission-presets` row with a `presets` list, which does not exist - DSH only warns about an unmatched target on stderr - and an unattended runtime sat on the stock policy that asks and then waits.",
  },
  {
    scope: "host",
    row: "permission",
    key: "config.presets",
    assert: "present",
    why:
      "The same patch replaces the preset table wholesale to add the confined-and-unattended pair. dsh-permission-presets refuses to load when the composed sandbox/approval pair matches no preset, so this address disappearing is a container that will not start.",
  },
  {
    scope: "agent",
    row: "skill-filesystem",
    key: "config.includeDefaultRoots",
    assert: "equals",
    value: "false",
    why:
      "Default root discovery treats `.dsh/skills` in the workspace as a skill root, and the workspace is where users upload files - an uploaded SKILL.md would become an instruction.",
  },
  {
    scope: "agent",
    row: "tool-fs-search",
    key: "config.sampleOverCapGlobResults",
    assert: "equals",
    value: "false",
    why:
      "Required with no default: the plugin refuses to mount without it. This row is in agent scope, so that refusal arrives when a session is created, not when the host composition boots.",
  },
  {
    scope: "agent",
    row: "tool-subagent-report",
    key: "config.reportDelivery",
    assert: "equals",
    value: "quiet",
    why: "Report delivery is a deployment policy, not a per-call choice: a model that can pick `next-step` can interrupt its own synthesis at will.",
  },
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Text, not a YAML library, and not for convenience: these documents carry
 * `!!js` tags that no general parser will load without being handed an
 * evaluator, and this script stays on node builtins. What is parsed is the
 * small dialect the kernel's dumper emits - a sequence of row mappings,
 * two-space indentation, folded and literal block scalars, nested sequences.
 * Anything outside it throws with a line number rather than being skipped,
 * because a row this cannot read is a row whose value nobody checked.
 *
 * @typedef {Map<string, any> | any[] | string | null} Node
 */

/** @param {string} line */
const indentOf = (line) => line.length - line.trimStart().length;
/** @param {string} line */
const isBlank = (line) => line.trim() === "";
/** @param {string} line */
const isComment = (line) => line.trimStart().startsWith("#");

/** @param {string[]} lines @param {number} from */
function nextContent(lines, from) {
  for (let index = from; index < lines.length; index += 1) {
    if (!isBlank(lines[index]) && !isComment(lines[index])) return index;
  }
  return lines.length;
}

/** @param {string} text */
const normalizeSpace = (text) => text.replace(/\s+/g, " ").trim();

/**
 * A scalar as written. The `!!js` tag is kept rather than stripped: an
 * expression and a literal that happen to read the same are not the same
 * setting, and comparing them equal would hide a row that stopped reading the
 * environment.
 * @param {string} text
 */
export function scalarValue(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("!!js")) return `!!js ${normalizeSpace(trimmed.slice(4))}`;
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

const BLOCK_HEADER = /^(!!js\s+)?[>|][-+]?$/;

/**
 * Consume a block scalar: every following line indented deeper than its key,
 * blanks included. Whitespace is normalized on the way out - the dumper re-wraps
 * a folded scalar when the row it sits in changes indentation level, and a
 * re-wrap of unchanged text is not a change worth reporting as one.
 * @param {string[]} lines @param {number} start @param {number} keyIndent @param {boolean} js
 */
function readBlockScalar(lines, start, keyIndent, js) {
  const parts = [];
  let index = start;
  for (; index < lines.length; index += 1) {
    if (isBlank(lines[index])) {
      parts.push("");
      continue;
    }
    if (indentOf(lines[index]) <= keyIndent) break;
    parts.push(lines[index].trim());
  }
  const text = normalizeSpace(parts.join(" "));
  return { value: js ? `!!js ${text}` : text, next: index };
}

/**
 * @param {string[]} lines @param {number} start @param {number} indent
 * @returns {{ value: Node, next: number }}
 */
function parseMapping(lines, start, indent) {
  /** @type {Map<string, Node>} */
  const map = new Map();
  let index = start;
  for (;;) {
    index = nextContent(lines, index);
    if (index >= lines.length) break;
    const line = lines[index];
    const columns = indentOf(line);
    if (columns < indent) break;
    if (columns > indent) throw new Error(`line ${index + 1}: indent ${columns} where ${indent} was expected; the row scan is wrong`);
    const text = line.slice(columns);
    if (text.startsWith("- ") || text === "-") break;
    const match = /^([A-Za-z0-9_$.-]+):(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) throw new Error(`line ${index + 1}: not a mapping key (${text.slice(0, 60)})`);
    const key = match[1];
    const rest = (match[2] ?? "").trim();
    if (rest === "") {
      const child = parseChildBlock(lines, index + 1, columns);
      map.set(key, child.value);
      index = child.next;
      continue;
    }
    if (BLOCK_HEADER.test(rest)) {
      const block = readBlockScalar(lines, index + 1, columns, rest.startsWith("!!js"));
      map.set(key, block.value);
      index = block.next;
      continue;
    }
    map.set(key, scalarValue(rest));
    index += 1;
  }
  return { value: map, next: index };
}

/**
 * @param {string[]} lines @param {number} start @param {number} indent
 * @returns {{ value: Node, next: number }}
 */
function parseSequence(lines, start, indent) {
  /** @type {Node[]} */
  const items = [];
  let index = start;
  for (;;) {
    index = nextContent(lines, index);
    if (index >= lines.length) break;
    const columns = indentOf(lines[index]);
    if (columns !== indent) break;
    const text = lines[index].slice(columns);
    if (!text.startsWith("- ") && text !== "-") break;
    const rest = text.slice(1).trim();
    if (rest === "") {
      const child = parseChildBlock(lines, index + 1, columns);
      items.push(child.value);
      index = child.next;
      continue;
    }
    // "- " is two characters, so a list item opened at column I keeps its
    // sibling keys at column I+2 - the same column rule the composition
    // reference checker relies on.
    if (/^[A-Za-z0-9_$.-]+:(\s|$)/.test(rest)) {
      const head = /** @type {Map<string, Node>} */ (parseMapping([" ".repeat(indent + 2) + rest], 0, indent + 2).value);
      const tail = parseMapping(lines, index + 1, indent + 2);
      items.push(new Map([...head, .../** @type {Map<string, Node>} */ (tail.value)]));
      index = tail.next;
      continue;
    }
    items.push(scalarValue(rest));
    index += 1;
  }
  return { value: items, next: index };
}

/**
 * The block under a `key:` with nothing after the colon. A sequence may sit at
 * the key's own column or deeper; a mapping is always deeper.
 * @param {string[]} lines @param {number} start @param {number} keyIndent
 * @returns {{ value: Node, next: number }}
 */
function parseChildBlock(lines, start, keyIndent) {
  const index = nextContent(lines, start);
  if (index >= lines.length) return { value: null, next: start };
  const columns = indentOf(lines[index]);
  const text = lines[index].slice(columns);
  const isItem = text.startsWith("- ") || text === "-";
  if (columns > keyIndent) return isItem ? parseSequence(lines, index, columns) : parseMapping(lines, index, columns);
  if (columns === keyIndent && isItem) return parseSequence(lines, index, columns);
  return { value: null, next: start };
}

/** @param {Node} node @param {string} prefix @param {Map<string, string>} out */
function flatten(node, prefix, out) {
  if (node instanceof Map) {
    for (const [key, value] of node) flatten(value, prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((value, position) => flatten(value, `${prefix}[${position}]`, out));
    return out;
  }
  out.set(prefix, node === null ? "" : String(node));
  return out;
}

/**
 * The comment block sitting directly above a line. In these files the WHY is
 * already written - the patch says in four lines why telemetry is off - so a
 * checker that retyped the reason would be a second copy of it, drifting from
 * the first the moment someone edits one.
 * @param {string[]} lines @param {number} rowIndex
 */
export function commentAbove(lines, rowIndex) {
  const collected = [];
  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    if (!isComment(lines[index])) break;
    collected.unshift(lines[index].trim().replace(/^#\s?/, ""));
  }
  return normalizeSpace(collected.join(" "));
}

/**
 * @typedef {object} Row
 * @property {string} id
 * @property {string} [name]
 * @property {number} line 1-indexed; 0 for a row nested inside another row's config
 * @property {boolean} inserted the row is added by a patch rather than overriding one
 * @property {string} why the comment block above it, verbatim
 * @property {Map<string, string>} keys flattened: `disabled`, `config.x`, `config.x[0].y`
 */

/**
 * Rows out of a cordis document, including the ones nested in a group's
 * `config:` - a group child is a mounted plugin exactly like a top-level row,
 * and the preset mounts eight of ours that way.
 * @param {string} text
 * @returns {{ rows: Row[], byId: Map<string, Row> }}
 */
export function parseCordisDocument(text) {
  const lines = text.split("\n");
  /** @type {number[]} */
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^-(\s|$)/.test(lines[index])) starts.push(index);
  }

  /** @type {Row[]} */
  const rows = [];
  for (let position = 0; position < starts.length; position += 1) {
    const from = starts[position];
    const to = position + 1 < starts.length ? starts[position + 1] : lines.length;
    // The leading "-" becomes a space so the item parses as a plain mapping
    // while every column stays exactly where it was; re-indenting would move
    // the line numbers this report has to name.
    const block = lines.slice(from, to);
    block[0] = ` ${block[0].slice(1)}`;
    const parsed = /** @type {Map<string, Node>} */ (parseMapping(block, 0, 2).value);
    const why = commentAbove(lines, from);

    const insert = parsed.get("insert");
    if (Array.isArray(insert)) {
      for (const child of insert) collectRow(child, rows, from + 1, why, true);
      continue;
    }
    collectRow(parsed, rows, from + 1, why, false);
  }

  /** @type {Map<string, Row>} */
  const byId = new Map();
  for (const row of rows) {
    // Two rows may legitimately share a plugin name - `tool-subagent` is
    // mounted twice - but never an id: an id is the address a patch writes to.
    if (byId.has(row.id)) throw new Error(`two rows share the id \`${row.id}\`; an id is the address a patch writes to`);
    byId.set(row.id, row);
  }
  return { rows, byId };
}

/** @param {Node} node @param {Row[]} rows @param {number} line @param {string} why @param {boolean} inserted */
function collectRow(node, rows, line, why, inserted) {
  if (!(node instanceof Map)) return;
  const id = node.get("id");
  if (typeof id !== "string" || !id) return;
  const name = node.get("name");
  rows.push({
    id,
    ...(typeof name === "string" ? { name } : {}),
    line,
    inserted,
    why,
    keys: flatten(node, "", new Map()),
  });
  const config = node.get("config");
  if (Array.isArray(config)) for (const child of config) collectRow(child, rows, 0, "", inserted);
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Invariant
 * @property {"host"|"agent"} scope
 * @property {string} row
 * @property {string} [key]
 * @property {"equals"|"contains"|"present"|"absent"} assert
 * @property {string} [value]
 * @property {string} why
 * @property {string} source repo-relative file:line, or "declared"
 * @property {"patch"|"absent-list"|"declared"} origin
 */

/**
 * Every host-scope override the bundle's patch makes, turned into an invariant,
 * with the reason the patch already gives above the row.
 *
 * A patch row with a `name:` inserts a plugin of ours; a patch row with only an
 * `id:` reaches into the host composition the image resolved. Only the second
 * kind is a claim about upstream, and only the second kind can silently stop
 * applying - an id that matches nothing warns on stderr and is dropped.
 * @param {string} patchText
 * @returns {Invariant[]}
 */
export function deriveFromPatch(patchText) {
  const { rows } = parseCordisDocument(patchText);
  /** @type {Invariant[]} */
  const invariants = [];
  for (const row of rows) {
    if (row.inserted || row.name) continue;
    for (const [key, value] of row.keys) {
      if (key === "id") continue;
      invariants.push({
        scope: "host",
        row: row.id,
        key,
        assert: "equals",
        value,
        why: row.why,
        source: `${SOURCES.patch}:${row.line}`,
        origin: "patch",
      });
    }
  }
  return invariants;
}

/**
 * The preset's "Deliberately absent, each for a reason:" block, turned into one
 * absence invariant per named tool.
 *
 * That block is the composition's own statement of what the model may not see,
 * and it is the primary defence against the alpha.4 flip: a fetch provider
 * sitting ready matters only if something can call it, and nothing can while
 * `tool-web` is not in this composition. Left as a comment it protects exactly
 * as much as whoever happens to read it.
 *
 * Matching is on substring rather than equality because the list names tools
 * (`str_replace_editor`) while a composition names rows and packages
 * (`@deepseek-ai/dsh-tool-str-replace-editor`); underscores fold to hyphens for
 * the same reason.
 * @param {string} presetText
 * @returns {Invariant[]}
 */
export function deriveFromAbsentList(presetText) {
  const lines = presetText.split("\n");
  const headerIndex = lines.findIndex((line) => /^#\s*Deliberately absent/i.test(line));
  if (headerIndex < 0) return [];

  /** @type {Invariant[]} */
  const invariants = [];
  /** @type {Invariant[]} */
  let currentEntry = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isComment(line)) break;
    // An entry sits in the name column (`#` then two or three spaces); a
    // continuation is indented past it. Two gaps on one line separate the name
    // from its reason, and a comma separates two names sharing one reason.
    const entry = /^#\s{2,3}(\S.*?)\s{2,}(\S.*)$/.exec(line);
    const continuation = /^#\s{4,}(\S.*)$/.exec(line);
    if (entry) {
      currentEntry = entry[1]
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .map((token) => ({
          scope: /** @type {const} */ ("agent"),
          row: token,
          assert: /** @type {const} */ ("absent"),
          why: entry[2].trim(),
          source: `${SOURCES.preset}:${index + 1}`,
          origin: /** @type {const} */ ("absent-list"),
        }));
      invariants.push(...currentEntry);
      continue;
    }
    if (continuation) {
      for (const item of currentEntry) item.why = `${item.why} ${continuation[1].trim()}`;
      continue;
    }
    // A blank comment line ends the list. Reading on would let a later,
    // unrelated comment block contribute rows to it, and a ban nobody wrote is
    // as wrong as a ban nobody enforced.
    if (/^#\s*$/.test(line)) break;
    // Anything else inside the block is a line this parser did not understand,
    // and it must be loud. The patterns are whitespace-sensitive — an entry is
    // `#` + 2-3 spaces, a continuation is `#` + 4 or more — so re-indenting one
    // line by a single space silently demoted an invariant to prose and the
    // count floor absorbed the loss. A parse that quietly drops a ban is worse
    // than no parse: it reports the remaining bans as the whole list.
    throw new Error(
      `${SOURCES.preset}:${index + 1}: this line is inside the deliberately-absent list but matches neither `
      + `an entry (\`#\` + 2-3 spaces + name + 2 spaces + reason) nor a continuation (\`#\` + 4+ spaces). `
      + `A ban that stops parsing disappears silently, so the parse fails instead: ${JSON.stringify(line)}`,
    );
  }
  return invariants;
}

/** @param {string} token */
const absenceKey = (token) => token.replace(/_/g, "-").toLowerCase();

/**
 * @param {{ patchText: string, presetText: string }} inputs
 * @returns {Invariant[]}
 */
export function deriveInvariants(inputs) {
  return [
    ...deriveFromPatch(inputs.patchText),
    ...deriveFromAbsentList(inputs.presetText),
    ...DECLARED_INVARIANTS.map((declared) => ({ ...declared, source: "declared", origin: /** @type {const} */ ("declared") })),
  ];
}

/**
 * @typedef {object} Problem
 * @property {string} kind
 * @property {string} detail
 * @property {string} [row]
 * @property {string} [key]
 * @property {string} [required]
 * @property {string} [found]
 * @property {string} [source]
 * @property {string} [why]
 */

/**
 * Evaluate one invariant against the configuration it claims to be about.
 * @param {Invariant} invariant
 * @param {{ rows: Row[], byId: Map<string, Row> }} document
 * @param {string} where human-readable name of that configuration
 * @returns {Problem | null}
 */
export function evaluateInvariant(invariant, document, where) {
  if (invariant.assert === "absent") {
    const needle = absenceKey(invariant.row);
    const hit = document.rows.find((row) => absenceKey(row.id).includes(needle) || absenceKey(row.name ?? "").includes(needle));
    if (!hit) return null;
    return {
      kind: "absent-row-present",
      row: invariant.row,
      found: `${hit.id} (${hit.name ?? "no name"})`,
      source: invariant.source,
      why: invariant.why,
      detail: `\`${invariant.row}\` is on the preset's deliberately-absent list and ${where} mounts \`${hit.id}\``,
    };
  }

  const row = document.byId.get(invariant.row);
  if (!row) {
    return {
      kind: "row-missing",
      row: invariant.row,
      key: invariant.key,
      source: invariant.source,
      why: invariant.why,
      detail:
        `no row \`${invariant.row}\` in ${where}. Whatever this invariant held is not held any more, and an override addressed at a row ` +
        "that is not there only warns on stderr and is dropped",
    };
  }

  const found = row.keys.get(String(invariant.key));
  if (invariant.assert === "present") {
    // The keys are flattened to leaves, so `config.presets` is present as
    // `config.presets.read-only.sandbox` and never under its own name. An
    // anchor is an address a patch writes to, and writing to a subtree is
    // writing to the address, so a prefix counts.
    const prefix = `${invariant.key}.`;
    const index = `${invariant.key}[`;
    if (found !== undefined || [...row.keys.keys()].some((candidate) => candidate.startsWith(prefix) || candidate.startsWith(index))) return null;
    return {
      kind: "anchor-missing",
      row: invariant.row,
      key: invariant.key,
      source: invariant.source,
      why: invariant.why,
      detail: `row \`${invariant.row}\` in ${where} has no \`${invariant.key}\`; the patch writes to that address and would be dropped with a warning`,
    };
  }
  if (found === undefined) {
    return {
      kind: "value-missing",
      row: invariant.row,
      key: invariant.key,
      required: invariant.value,
      found: "(key absent)",
      source: invariant.source,
      why: invariant.why,
      detail: `row \`${invariant.row}\` in ${where} no longer carries \`${invariant.key}\``,
    };
  }
  if (invariant.assert === "contains") {
    if (found.includes(String(invariant.value))) return null;
    return {
      kind: "value-drifted",
      row: invariant.row,
      key: invariant.key,
      required: `contains ${invariant.value}`,
      found,
      source: invariant.source,
      why: invariant.why,
      detail: `row \`${invariant.row}\`.\`${invariant.key}\` in ${where} no longer names ${invariant.value}`,
    };
  }
  if (found === invariant.value) return null;
  return {
    kind: "value-drifted",
    row: invariant.row,
    key: invariant.key,
    required: invariant.value,
    found,
    source: invariant.source,
    why: invariant.why,
    detail: `row \`${invariant.row}\`.\`${invariant.key}\` in ${where} is \`${found}\`, and we depend on \`${invariant.value}\``,
  };
}

// ---------------------------------------------------------------------------
// Difference classification
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Difference
 * @property {string} row
 * @property {string} key "" when the whole row appeared or disappeared
 * @property {string | null} before
 * @property {string | null} after
 * @property {"pinned"|"upstream-default"|"unknown"} klass
 */

/**
 * Every row and key that differs between two configurations, classified.
 *
 * The third class is the one that earns this function: a key the baseline has
 * never seen is a key nobody here has an opinion about, and the next default
 * flip will arrive under exactly such a name. It is reported rather than
 * dropped.
 *
 * @param {{ rows: Row[], byId: Map<string, Row> }} baseline
 * @param {{ rows: Row[], byId: Map<string, Row> }} current
 * @param {Invariant[]} invariants
 * @returns {Difference[]}
 */
export function diffConfigurations(baseline, current, invariants) {
  const host = invariants.filter((invariant) => invariant.scope === "host");
  const pinnedKeys = new Set(host.filter((invariant) => invariant.key).map((invariant) => `${invariant.row} ${invariant.key}`));
  const pinnedRows = new Set(host.map((invariant) => invariant.row));

  /** @type {Difference[]} */
  const differences = [];
  /** @param {string} row @param {string} key @param {string|null} before @param {string|null} after */
  const push = (row, key, before, after) => {
    const klass =
      pinnedKeys.has(`${row} ${key}`) || (key === "" && pinnedRows.has(row)) ? "pinned" : before === null ? "unknown" : "upstream-default";
    differences.push({ row, key, before, after, klass });
  };

  for (const row of baseline.rows) {
    const other = current.byId.get(row.id);
    if (!other) {
      push(row.id, "", `row present (${row.name ?? "no name"})`, null);
      continue;
    }
    for (const [key, value] of row.keys) {
      const found = other.keys.get(key);
      if (found === undefined) push(row.id, key, value, null);
      else if (found !== value) push(row.id, key, value, found);
    }
    for (const [key, value] of other.keys) {
      if (!row.keys.has(key)) push(row.id, key, null, value);
    }
  }
  for (const row of current.rows) {
    if (!baseline.byId.has(row.id)) push(row.id, "", null, `row added (${row.name ?? "no name"})`);
  }
  return differences;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {string} [options.dump] path to a fresh `dsh --dump-config`, absolute or repo-relative
 * @param {Partial<Record<keyof typeof SOURCES, string>>} [options.overrideFiles] absolute paths, for fixtures
 * @param {Invariant[]} [options.invariants] for fixtures; a real run derives its own
 */
export async function checkKernelDefaults(options = {}) {
  const root = options.root ?? repoRoot;

  /** @param {keyof typeof SOURCES} key */
  const read = async (key) => {
    const file = options.overrideFiles?.[key] ?? path.join(root, SOURCES[key]);
    try {
      return { file, text: await readFile(file, "utf8") };
    } catch (error) {
      // Never a skip and never a warning. A source this checker cannot read is
      // the one case where a green run would mean nothing at all: "the baseline
      // was not there" is indistinguishable from "nothing drifted" unless it is
      // said out loud.
      throw new Error(`cannot read ${key} (${file}): ${error?.message ?? error}`);
    }
  };

  const [baselineSource, patchSource, presetSource, pinsSource] = await Promise.all([
    read("baseline"),
    read("patch"),
    read("preset"),
    read("pins"),
  ]);

  /** @type {Problem[]} */
  const problems = [];

  const pins = JSON.parse(pinsSource.text);
  const pinnedVersion = pins?.dsh?.version;
  if (!pinnedVersion) throw new Error(`${SOURCES.pins} carries no dsh.version; there is nothing to check the baseline against`);

  // Provenance first, and as problems rather than a throw: an out-of-date
  // baseline still has invariants worth evaluating, and the report is more
  // useful saying "these two things are true at once" than stopping at the
  // first.
  if (BASELINE_PROVENANCE.dshVersion !== pinnedVersion) {
    problems.push({
      kind: "baseline-version-mismatch",
      required: pinnedVersion,
      found: BASELINE_PROVENANCE.dshVersion,
      source: SOURCES.pins,
      detail:
        `${SOURCES.pins} pins dsh ${pinnedVersion} and the committed baseline was recorded at ${BASELINE_PROVENANCE.dshVersion}. ` +
        `Rebuild the runtime image at the new pin, copy the dump it generates over ${SOURCES.baseline}, and update BASELINE_PROVENANCE in ` +
        "this script - a baseline from another version, compared quietly, certifies these invariants against a kernel we do not ship",
    });
  }
  const digest = createHash("sha256").update(baselineSource.text).digest("hex");
  if (digest !== BASELINE_PROVENANCE.sha256) {
    problems.push({
      kind: "baseline-bytes-unattested",
      required: BASELINE_PROVENANCE.sha256,
      found: digest,
      source: SOURCES.baseline,
      detail:
        `${SOURCES.baseline} is not the file BASELINE_PROVENANCE attests to. If the image was rebuilt, say which version produced this dump by ` +
        "updating BASELINE_PROVENANCE.dshVersion and .sha256 in this script; if it was hand-edited, that is the laundering path this check exists to close",
    });
  }

  const baseline = parseCordisDocument(baselineSource.text);
  const preset = parseCordisDocument(presetSource.text);

  /** @type {{ mode: "baseline"|"dump", file: string, document: typeof baseline }} */
  let current;
  if (options.dump) {
    const file = path.isAbsolute(options.dump) ? options.dump : path.join(root, options.dump);
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      throw new Error(`cannot read the --dump configuration (${file}): ${error?.message ?? error}`);
    }
    current = { mode: "dump", file, document: parseCordisDocument(text) };
  } else {
    current = { mode: "baseline", file: baselineSource.file, document: baseline };
  }

  const invariants = options.invariants ?? deriveInvariants({ patchText: patchSource.text, presetText: presetSource.text });

  // Extraction integrity. Every number here is a floor on a walk that has to
  // have happened; a walk that matched nothing produces zero findings, and zero
  // findings is what success looks like.
  const counts = {
    baselineRows: baseline.rows.length,
    presetRows: preset.rows.length,
    derivedFromPatch: invariants.filter((invariant) => invariant.origin === "patch").length,
    derivedFromAbsentList: invariants.filter((invariant) => invariant.origin === "absent-list").length,
    declared: invariants.filter((invariant) => invariant.origin === "declared").length,
  };
  for (const [field, floor] of Object.entries(EXTRACTION_FLOORS)) {
    // `…Exactly` names a count that must match, not a lower bound. The ban
    // list is the case: a floor below its real size means bans can vanish
    // one at a time and every run stays green.
    const exact = field.endsWith("Exactly");
    const countField = exact ? field.slice(0, -"Exactly".length) : field;
    const observed = counts[countField];
    if (exact ? observed === floor : observed >= floor) continue;
    problems.push({
      kind: "extraction-drift",
      detail: exact
        ? `${countField}: found ${observed}, expected exactly ${floor}. Either the composition's list changed — in which case `
          + "update the number deliberately — or the scan stopped matching, and a scan that reads less reports less wrong"
        : `${countField}: found ${observed}, floor is ${floor}. Either the composition shrank wholesale or the scan stopped matching, `
          + "and a scan that reads nothing reports nothing wrong",
    });
  }

  const documents = {
    host: {
      document: current.document,
      where: current.mode === "dump" ? displayPath(root, current.file) : `${SOURCES.baseline} (the image's own composition)`,
    },
    agent: { document: preset, where: SOURCES.preset },
  };
  for (const invariant of invariants) {
    const target = documents[invariant.scope];
    const problem = evaluateInvariant(invariant, target.document, target.where);
    if (problem) problems.push(problem);
  }

  return {
    ok: problems.length === 0,
    pinnedVersion,
    baseline: { file: displayPath(root, baselineSource.file), rows: baseline.rows.length, recordedAt: BASELINE_PROVENANCE.dshVersion },
    current: { mode: current.mode, file: displayPath(root, current.file), rows: current.document.rows.length },
    counts,
    invariants,
    differences: current.mode === "dump" ? diffConfigurations(baseline, current.document, invariants) : [],
    problems,
  };
}

/** @param {string} text @param {number} [limit] */
const clip = (text, limit = 150) => (text.length > limit ? `${text.slice(0, limit - 1)}...` : text);

/** Repo-relative when the file is in the repo, absolute when it is not; `../../../tmp/x` names nothing a reader can act on. */
function displayPath(root, file) {
  const relative = path.relative(root, file);
  return relative.startsWith("..") ? file : relative;
}

/** @param {Awaited<ReturnType<typeof checkKernelDefaults>>} report */
export function formatReport(report) {
  const lines = [];
  lines.push(`kernel defaults: dsh ${report.pinnedVersion}`);
  lines.push(`  baseline   ${report.baseline.file} - ${report.baseline.rows} rows, recorded at ${report.baseline.recordedAt}`);
  lines.push(
    report.current.mode === "dump"
      ? `  current    ${report.current.file} - ${report.current.rows} rows`
      : "  current    the committed baseline itself. No fresh --dump-config was supplied, so NO upstream drift was compared; build a candidate image and pass --dump <file>.",
  );
  lines.push(
    `  invariants ${report.invariants.length} checked: ${report.counts.derivedFromPatch} derived from ${SOURCES.patch}, ` +
      `${report.counts.derivedFromAbsentList} from the preset's deliberately-absent list, ${report.counts.declared} declared`,
  );

  /** @type {Map<string, Difference[]>} */
  const byClass = new Map();
  for (const difference of report.differences) byClass.set(difference.klass, [...(byClass.get(difference.klass) ?? []), difference]);
  for (const klass of ["upstream-default", "unknown", "pinned"]) {
    const group = byClass.get(klass) ?? [];
    if (!group.length) continue;
    lines.push("");
    lines.push(
      klass === "unknown"
        ? `notice - ${group.length} row/key the baseline has never seen (we hold no opinion on these; someone has to form one):`
        : klass === "pinned"
          ? `${group.length} difference(s) on a value we pin - the invariant results below decide these:`
          : `notice - ${group.length} upstream default moved (we do not pin these):`,
    );
    for (const difference of group) {
      const address = difference.key ? `${difference.row}.${difference.key}` : difference.row;
      lines.push(`  ${address}: ${clip(difference.before ?? "(absent)", 70)} -> ${clip(difference.after ?? "(gone)", 70)}`);
    }
  }

  if (report.problems.length === 0) {
    lines.push("");
    lines.push("  every setting we depend on still holds.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`${report.problems.length} problem${report.problems.length === 1 ? "" : "s"}:`);
  for (const problem of report.problems) {
    lines.push(`  [${problem.kind}] ${problem.detail}`);
    if (problem.required !== undefined) lines.push(`      required: ${clip(String(problem.required))}`);
    if (problem.found !== undefined) lines.push(`      found:    ${clip(String(problem.found))}`);
    if (problem.source) lines.push(`      declared: ${problem.source}`);
    if (problem.why) lines.push(`      why:      ${clip(problem.why, 220)}`);
  }
  return lines.join("\n");
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ json: boolean, dump?: string }} */
  const args = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") args.json = true;
    else if (token === "--dump") {
      args.dump = argv[index + 1];
      index += 1;
      if (!args.dump || args.dump.startsWith("--")) throw new Error("--dump needs a path to a `dsh --dump-config` output");
    } else if (token.startsWith("--dump=")) args.dump = token.slice("--dump=".length);
    else throw new Error(`unknown argument ${token}`);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const report = await checkKernelDefaults({ dump: args.dump });
  process.stdout.write(`${args.json ? JSON.stringify(report, replacer, 2) : formatReport(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

/** Maps do not survive JSON.stringify, and `--json` is what the test reads. */
function replacer(_key, value) {
  return value instanceof Map ? Object.fromEntries(value) : value;
}
