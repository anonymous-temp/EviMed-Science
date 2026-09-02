#!/usr/bin/env node
/**
 * Every upstream name our composition mounts, checked against the pin — at test
 * time, not at container boot.
 *
 * Hidden knowledge: a composition row is a *string*. Nothing in this repository
 * type-checks `name: '@deepseek-ai/dsh-tool-subagent-report'`; the first thing
 * that reads it is the kernel's loader, inside a container, at the moment a
 * session is created. Upstream publishes a prerelease every day or two and
 * promises nothing, so the way we learn a package was deleted or renamed has
 * been: the image builds, the container boots, and a run dies. DSH 0.1.2-alpha.4
 * replaced the one-way `report` subagent tool with `send_message` and stopped
 * publishing `@deepseek-ai/dsh-tool-subagent-report` — its `alpha` dist-tag is
 * still stuck at alpha.3 — while our preset still mounts it at line 198. That is
 * the incident this file exists for, and `--pin 0.1.2-alpha.4` reproduces it
 * against the real registry without moving the pin.
 *
 * What "resolves" means here, in tiers, strongest first:
 *   installed  the exact pinned artifact is on disk in this workspace, and its
 *              package.json version equals the pin. Only the five packages
 *              harness-port actually imports are in this tier.
 *   registry   the pinned version is published. The nineteen `config-row`
 *              packages are mounted by name inside the runtime image and are
 *              never installed here, so the registry is the only ground truth
 *              this checkout can reach for them.
 *   workspace  an `@evimed/*` row resolves through its own package's `exports`
 *              map to a file that exists. `plugins/guidance` is a subpath, and a
 *              renamed plugin file dangles exactly like a deleted npm package.
 *   host row   a `cordis.patch.yml` override names an id in the *host*
 *              composition. A patch id that matches nothing only warns on
 *              stderr and is dropped — which is how `web-fetch-http: disabled`
 *              would stop applying without a single error. Those ids are
 *              resolved against `deploy/runtime-dsh/dump-config.baseline.json`,
 *              the recorded `--dump-config` of the built image: a row that did
 *              not exist could not appear in a dump of what actually mounted.
 *
 * There is no fourth tier and no "assume fine". A reference the checker could
 * not verify is reported as `unverified` and fails the run, because a registry
 * that timed out is not evidence that a package exists.
 *
 * Deliberately not a hand-written list of packages: a list is a second copy of
 * the composition, and a second copy drifts. Every reference below is extracted
 * from the file that actually declares it, and the extraction is itself checked
 * — see `checkExtractionIntegrity`. An extractor that silently stopped matching
 * reports zero problems, and zero problems is what a passing run looks like.
 *
 * Usage:
 *   node scripts/ops/verify-composition-references.mjs [--json] [--pin <version>]
 *
 *   --pin   dry-run a candidate upstream version without touching
 *           deps-version.json: "what would fail if we moved to alpha.5".
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Loader built-ins the composition mounts, each confirmed by hand at the pin.
 *
 * `cordis:group` is the only one today. The set exists because a `cordis:`
 * name resolves through nothing a script can query, and the tier used to pass
 * every such name unexamined — so an upstream rename would have read as
 * "resolved". Adding a built-in here is the review; the guard's job is to
 * refuse to pretend one it has never seen is fine.
 */
const REVIEWED_KERNEL_BUILTINS = new Set(["cordis:group"]);


/** Files that declare a reference. Repo-relative so every message names a path a person can open. */
export const SOURCE_FILES = {
  preset: "packages/socket/presets/evimed-universal/agent.cordis.yml",
  patch: "packages/socket/cordis.patch.yml",
  seamManifest: "packages/harness-port/seam-manifest.json",
  hostBaseline: "deploy/runtime-dsh/dump-config.baseline.json",
  pins: "deps-version.json",
};

/**
 * Floors, not exact counts. An exact count is a third copy of the composition
 * and goes red on every legitimate row added; a floor only catches the thing a
 * count can catch, which is an extractor that stopped matching. The numbers are
 * roughly two thirds of today's, named here so the next reader can see the
 * margin rather than guess at it.
 */
export const EXTRACTION_FLOORS = {
  preset: { rows: 16, upstreamReferences: 10 }, // today: 24 rows, 15 upstream
  patch: { rows: 4, hostRowOverrides: 3 }, // today: 6 rows, 4 overrides
  seamManifest: { packages: 16 }, // today: 24
  hostBaseline: { rows: 40 }, // today: 100+ ids in the dumped host composition
};

/** Roles in seam-manifest.json that mean "harness-port imports this, so it is installed here". */
const INSTALLED_ROLES = new Set(["peer", "dependency", "re-exported", "types-only"]);
/** The role that means "named in a composition, installed only inside the runtime image". */
const COMPOSITION_ROLE = "config-row";

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Rows out of a cordis YAML file, with line numbers.
 *
 * Text, not a YAML parse, and the reason is not laziness: these files carry
 * `!!js` tags that no general parser will load without being handed an
 * evaluator, and what a reference needs is the *line* — a report that says
 * "@deepseek-ai/dsh-tool-subagent-report is gone" without naming
 * agent.cordis.yml:198 makes the reader grep for it. The scan is column-exact
 * rather than a loose regex: a row opened by `- id:` at indent I owns the keys
 * at column I+2 and nothing deeper, so a `name:` inside a nested `config:`
 * block (column I+4 or more) can never be misread as the row's plugin name.
 *
 * @param {string} text
 * @returns {{ line: number, nameLine: number, indent: number, id?: string, name?: string, insert: boolean }[]}
 */
export function extractCordisRows(text) {
  const lines = text.split("\n");
  /** @type {{ line: number, nameLine: number, indent: number, id?: string, name?: string, insert: boolean }[]} */
  const rows = [];
  /** @type {{ keyColumn: number, row: { line: number, nameLine: number, indent: number, id?: string, name?: string, insert: boolean } } | null} */
  let open = null;
  /** @type {number | null} */
  let insertIndent = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    const insertOpener = /^\s*-\s*insert:\s*$/.exec(raw);
    if (insertOpener) {
      insertIndent = indent;
      open = null;
      continue;
    }

    // A row written in YAML flow form — `- { id: x, name: '@scope/pkg' }` —
    // is the same row to the loader and was invisible to the block scan
    // below: an adversarial check mounted a package that has never existed at
    // any version in flow form and this printed "every reference resolves" at
    // exit 0. Handled before the block opener, since a flow row is complete on
    // its own line and must not leave `open` pointing at it.
    const flowRow = /^\s*-\s*\{(.+)\}\s*,?\s*$/.exec(raw);
    if (flowRow) {
      if (insertIndent !== null && indent <= insertIndent) insertIndent = null;
      const row = { line: index + 1, nameLine: index + 1, indent, insert: insertIndent !== null && indent > insertIndent };
      for (const field of flowRow[1].split(",")) {
        const pair = /^\s*(id|name)\s*:\s*(.+?)\s*$/.exec(field);
        if (pair) row[pair[1] === "id" ? "id" : "name"] = unquote(pair[2]);
      }
      // Only rows the scan understood are pushed. A flow row whose braces hold
      // something this split cannot read would otherwise become a row with no
      // name, which the per-row `name:` check reports as a broken extractor —
      // which is the correct outcome, so it is pushed either way.
      open = null;
      rows.push(row);
      continue;
    }

    const itemKey = /^\s*-\s{1,}(id|name):\s*(.+?)\s*$/.exec(raw);
    if (itemKey) {
      if (insertIndent !== null && indent <= insertIndent) insertIndent = null;
      const row = { line: index + 1, nameLine: 0, indent, insert: insertIndent !== null && indent > insertIndent };
      // "- " is two characters, so a list item opened at column I keeps its
      // sibling keys at column I+2.
      open = { keyColumn: indent + 2, row };
      row[itemKey[1] === "id" ? "id" : "name"] = unquote(itemKey[2]);
      if (itemKey[1] === "name") row.nameLine = index + 1;
      rows.push(row);
      continue;
    }

    const plainKey = /^\s*(id|name):\s*(.+?)\s*$/.exec(raw);
    if (plainKey && open && indent === open.keyColumn) {
      const key = plainKey[1] === "id" ? "id" : "name";
      // A row carries one id and one name. A second means the column test let
      // something through, and that is a broken extractor, not a broken row.
      if (open.row[key] !== undefined) {
        throw new Error(`line ${index + 1}: a second \`${key}:\` for the row opened at line ${open.row.line}; the row scan is wrong`);
      }
      open.row[key] = unquote(plainKey[2]);
      // The reference is the string on the `name:` line, so that is the line a
      // report must name; anchoring to the row's opening `- id:` sends the
      // reader one line above what they have to change.
      if (key === "name") open.row.nameLine = index + 1;
    }
  }
  return rows;
}

/** @param {string} value */
function unquote(value) {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  const quoted = /^(['"])(.*)\1$/.exec(withoutComment);
  return quoted ? quoted[2] : withoutComment;
}

/**
 * Top-level plugin ids in the recorded `--dump-config` of the built image.
 * Text again, and for the same reason as above: the dump is cordis YAML with
 * `!!js` in it. Only column-0 rows count — a nested `- id:` inside a group's
 * `config:` is not a row a host-scope patch can address by id.
 * @param {string} text
 */
export function extractHostRowIds(text) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const line of text.split("\n")) {
    const match = /^-\s{1,}id:\s*(.+?)\s*$/.exec(line);
    if (match) ids.add(unquote(match[1]));
  }
  return ids;
}

/**
 * Line of a JSON object key, for the seam manifest.
 * The *value* comes from JSON.parse — the text scan is only asked where the key
 * sits, so a quoting trick cannot invent a package, only fail to locate one,
 * and failing to locate one is reported as extraction drift.
 * @param {string} text @param {string} key
 */
export function findJsonKeyLine(text, key) {
  const needle = `"${key}"`;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(needle)) return index + 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Reference collection
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Reference
 * @property {string} file repo-relative
 * @property {number} line
 * @property {string} specifier the string the composition actually wrote
 * @property {"upstream-package"|"workspace-subpath"|"kernel-builtin"|"host-row-id"} kind
 * @property {string} [role] seam-manifest role, when the reference came from there
 */

/**
 * @param {{ presetText: string, patchText: string, seamManifestText: string, hostBaselineText: string }} inputs
 */
export function collectReferences(inputs) {
  /** @type {Reference[]} */
  const references = [];

  const presetRows = extractCordisRows(inputs.presetText);
  for (const row of presetRows) {
    if (!row.name) continue;
    references.push({ file: SOURCE_FILES.preset, line: row.nameLine, specifier: row.name, kind: classify(row.name) });
  }

  const patchRows = extractCordisRows(inputs.patchText);
  let hostRowOverrides = 0;
  for (const row of patchRows) {
    if (row.name) {
      references.push({ file: SOURCE_FILES.patch, line: row.nameLine, specifier: row.name, kind: classify(row.name) });
      continue;
    }
    // No name means this row overrides a row the host composition already
    // mounted, addressed by id. There is no `remove`, so this is also how
    // `web-fetch-http` and the telemetry rows are turned off.
    if (row.id) {
      hostRowOverrides += 1;
      references.push({ file: SOURCE_FILES.patch, line: row.line, specifier: row.id, kind: "host-row-id" });
    }
  }

  const seamManifest = JSON.parse(inputs.seamManifestText);
  const seamPackages = seamManifest?.packages ?? {};
  for (const [name, role] of Object.entries(seamPackages)) {
    references.push({
      file: SOURCE_FILES.seamManifest,
      line: findJsonKeyLine(inputs.seamManifestText, name),
      specifier: name,
      kind: classify(name),
      role: String(role),
    });
  }

  const hostRowIds = extractHostRowIds(inputs.hostBaselineText);

  return {
    references,
    presetIdOnlyRows: presetRows.filter((row) => row.id && !row.name),
    counts: {
      preset: {
        rows: presetRows.length,
        named: presetRows.filter((row) => row.name).length,
        upstreamReferences: presetRows.filter((row) => row.name && classify(row.name) === "upstream-package").length,
      },
      patch: { rows: patchRows.length, hostRowOverrides },
      seamManifest: { packages: Object.keys(seamPackages).length },
      hostBaseline: { rows: hostRowIds.size },
    },
    hostRowIds,
  };
}

/** @param {string} specifier @returns {Reference["kind"]} */
function classify(specifier) {
  if (specifier.startsWith("@deepseek-ai/")) return "upstream-package";
  if (specifier.startsWith("@evimed/")) return "workspace-subpath";
  if (specifier.includes(":")) return "kernel-builtin";
  return "host-row-id";
}

/**
 * The counts a broken extractor cannot fake, plus the one structural check that
 * is not a magic number: every upstream package a composition mounts must also
 * be listed in seam-manifest.json, which claims to enumerate the upstream
 * surface this platform touches. If extraction drifts into garbage, the garbage
 * is not in the manifest and this fires; if the two files genuinely disagree,
 * one of them is out of date, which is the thing worth knowing either way.
 *
 * @param {ReturnType<typeof collectReferences>} collected
 * @returns {Problem[]}
 */
export function checkExtractionIntegrity(collected) {
  /** @type {Problem[]} */
  const problems = [];
  for (const [source, floors] of Object.entries(EXTRACTION_FLOORS)) {
    for (const [field, floor] of Object.entries(floors)) {
      const observed = collected.counts[source]?.[field];
      if (observed === undefined) {
        problems.push({
          kind: "extraction-drift",
          file: SOURCE_FILES[source] ?? source,
          line: 0,
          specifier: `${source}.${field}`,
          detail: `the extractor reported no ${field} count at all for ${source}; the walk did not run`,
        });
        continue;
      }
      if (observed < floor) {
        problems.push({
          kind: "extraction-drift",
          file: SOURCE_FILES[source] ?? source,
          line: 0,
          specifier: `${source}.${field}`,
          detail: `found ${observed}, floor is ${floor}. Either rows were deleted wholesale or the extractor stopped matching; a checker that reads nothing reports nothing wrong`,
        });
      }
    }
  }

  // A preset row defines a plugin; unlike a patch row it cannot override
  // anything, so an id with no name is not a row the kernel can mount. This is
  // also the sharpest reading of extraction drift there is: when the scan lost
  // its `name:` line, every one of the 24 rows still had an id and none had a
  // name, and the walk went on reporting nothing wrong.
  for (const row of collected.presetIdOnlyRows ?? []) {
    problems.push({
      kind: "extraction-drift",
      file: SOURCE_FILES.preset,
      line: row.line,
      specifier: row.id ?? "(no id)",
      detail: "a preset row with an id and no name; either the row is unmountable or the row scan lost its `name:`",
    });
  }

  const manifestPackages = new Set(
    collected.references.filter((reference) => reference.file === SOURCE_FILES.seamManifest).map((reference) => reference.specifier),
  );
  for (const reference of collected.references) {
    if (reference.kind !== "upstream-package") continue;
    if (reference.file === SOURCE_FILES.seamManifest) continue;
    if (manifestPackages.has(reference.specifier)) continue;
    problems.push({
      kind: "manifest-omission",
      file: reference.file,
      line: reference.line,
      specifier: reference.specifier,
      detail: `mounted here but absent from ${SOURCE_FILES.seamManifest}, which is supposed to enumerate every upstream package this platform touches`,
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Problem
 * @property {string} kind
 * @property {string} file
 * @property {number} line
 * @property {string} specifier
 * @property {string} detail
 */

/** Every directory that can own a node_modules in this workspace, read off disk rather than listed. */
export async function workspaceDirectories(root = repoRoot) {
  /** @type {string[]} */
  const dirs = [root];
  for (const group of ["packages", "apps"]) {
    /** @type {import("node:fs").Dirent[]} */
    let entries = [];
    try {
      entries = await readdir(path.join(root, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(path.join(root, group, entry.name));
    }
  }
  return dirs;
}

/** @param {string} name */
async function readJsonIfPresent(name) {
  try {
    return JSON.parse(await readFile(name, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The installed tier: is this exact package on disk in this checkout, and at
 * what version. A plain filesystem probe rather than `require.resolve`, because
 * a package whose `exports` map omits `./package.json` throws there — and a
 * throw would read as "not installed".
 * @param {string} pkg @param {string[]} dirs
 */
export async function resolveInstalled(pkg, dirs) {
  for (const dir of dirs) {
    const manifestPath = path.join(dir, "node_modules", ...pkg.split("/"), "package.json");
    const manifest = await readJsonIfPresent(manifestPath);
    if (manifest?.version) return { manifestPath, version: String(manifest.version) };
  }
  return null;
}

/**
 * The registry tier. Ground truth for the nineteen packages that are mounted by
 * name inside the runtime image and never installed here.
 *
 * A 404 on the version document alone is not enough to say "deleted": a mirror
 * that never carried the package answers the same way. So a 404 is followed by
 * a read of the packument, which separates "this package exists and this
 * version is not one of its versions" — the alpha.4 case — from "no such
 * package". Anything other than 200 or 404 is an error, never an answer.
 *
 * @param {string} pkg @param {string} version
 * @param {{ registry: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
export async function resolveRegistry(pkg, version, options) {
  const { registry, fetchImpl = fetch, timeoutMs = 20000 } = options;
  const base = registry.replace(/\/+$/, "");
  const encoded = encodeURIComponent(pkg);

  /** @param {string} url @param {string} accept */
  const get = async (url, accept) => {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await fetchImpl(url, { headers: { accept }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("fetch failed");
  };

  let response;
  try {
    response = await get(`${base}/${encoded}/${encodeURIComponent(version)}`, "application/json");
  } catch (error) {
    return { status: "unverified", detail: `registry ${base} unreachable: ${error?.message ?? error}` };
  }

  if (response.status === 200) {
    let body;
    try {
      body = await response.json();
    } catch (error) {
      return { status: "unverified", detail: `registry returned unparseable JSON for ${pkg}@${version}: ${error?.message ?? error}` };
    }
    // Assert the answer, not the status code: a mirror that serves an index page
    // with a 200 would otherwise certify anything.
    if (body?.name === pkg && body?.version === version) return { status: "exists" };
    return {
      status: "unverified",
      detail: `registry answered 200 for ${pkg}@${version} with ${body?.name ?? "no name"}@${body?.version ?? "no version"}`,
    };
  }

  if (response.status !== 404) {
    return { status: "unverified", detail: `registry answered HTTP ${response.status} for ${pkg}@${version}` };
  }

  let packument;
  try {
    packument = await get(`${base}/${encoded}`, "application/vnd.npm.install-v1+json, application/json");
  } catch (error) {
    return { status: "unverified", detail: `${pkg}@${version} is 404 and the packument read failed: ${error?.message ?? error}` };
  }
  if (packument.status === 404) {
    return { status: "missing", detail: `no package \`${pkg}\` on ${base}; it was unpublished or renamed` };
  }
  if (packument.status !== 200) {
    return { status: "unverified", detail: `${pkg}@${version} is 404 and the packument answered HTTP ${packument.status}` };
  }
  let body;
  try {
    body = await packument.json();
  } catch (error) {
    return { status: "unverified", detail: `${pkg}@${version} is 404 and the packument was unparseable: ${error?.message ?? error}` };
  }
  const versions = Object.keys(body?.versions ?? {});
  const tags = body?.["dist-tags"] ?? {};
  const tagSummary = Object.entries(tags)
    .map(([tag, value]) => `${tag}=${value}`)
    .join(" ");
  return {
    status: "missing",
    detail: `\`${pkg}\` exists but has no ${version}; newest published ${versions.at(-1) ?? "none"}${tagSummary ? ` (${tagSummary})` : ""}`,
  };
}

/** Which pin a package name is governed by. Derived from the name, so a new subpackage needs no edit here. */
export function targetVersionFor(pkg, pins) {
  if (pkg === "@deepseek-ai/dsh" || pkg.startsWith("@deepseek-ai/dsh-")) return { version: pins.dsh, source: "deps-version.json dsh.version" };
  if (pkg === "@deepseek-ai/cordis" || pkg.startsWith("@deepseek-ai/cordis-")) return { version: pins.cordis, source: "deps-version.json dsh.cordis" };
  return null;
}

/**
 * Resolve one `@evimed/*` reference through the owning workspace package's
 * `exports` map, then confirm the file is on disk. Only the shapes these
 * manifests actually use — a string target and a single `*` pattern.
 * @param {string} specifier
 * @param {Map<string, { dir: string, exports: unknown }>} workspacePackages
 */
export async function resolveWorkspaceSubpath(specifier, workspacePackages) {
  const segments = specifier.split("/");
  const pkgName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  const entry = workspacePackages.get(pkgName);
  if (!entry) return { status: "missing", detail: `no workspace package named \`${pkgName}\`` };
  const subpath = specifier === pkgName ? "." : `./${segments.slice(specifier.startsWith("@") ? 2 : 1).join("/")}`;

  const map = entry.exports;
  /** @type {string | null} */
  let target = null;
  if (typeof map === "string") {
    target = subpath === "." ? map : null;
  } else if (map && typeof map === "object") {
    const direct = map[subpath];
    if (typeof direct === "string") target = direct;
    if (!target) {
      for (const [pattern, value] of Object.entries(map)) {
        if (typeof value !== "string" || !pattern.includes("*")) continue;
        const [prefix, suffix] = pattern.split("*");
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
        const middle = subpath.slice(prefix.length, subpath.length - (suffix.length || 0));
        target = value.replace("*", middle);
        break;
      }
    }
  }
  if (!target) return { status: "missing", detail: `\`${pkgName}\` exports no subpath \`${subpath}\`` };

  const file = path.join(entry.dir, target);
  try {
    const info = await stat(file);
    if (!info.isFile()) return { status: "missing", detail: `${path.relative(repoRoot, file)} is not a file` };
  } catch {
    return { status: "missing", detail: `\`${subpath}\` maps to ${path.relative(repoRoot, file)}, which does not exist` };
  }
  return { status: "exists", detail: path.relative(repoRoot, file) };
}

/** Workspace package name → { dir, exports }, read off disk. */
export async function loadWorkspacePackages(root = repoRoot) {
  /** @type {Map<string, { dir: string, exports: unknown }>} */
  const found = new Map();
  for (const dir of await workspaceDirectories(root)) {
    const manifest = await readJsonIfPresent(path.join(dir, "package.json"));
    if (manifest?.name) found.set(manifest.name, { dir, exports: manifest.exports });
  }
  return found;
}

/** @template T @param {T[]} items @param {number} limit @param {(item: T) => Promise<void>} run */
async function pool(items, limit, run) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await run(items[index]);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} [options.root]
 * @param {string} [options.pin] candidate upstream version, overriding deps-version.json
 * @param {string} [options.registry]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {Partial<Record<keyof typeof SOURCE_FILES, string>>} [options.overrideFiles] absolute paths, for fixtures
 */
export async function verifyCompositionReferences(options = {}) {
  const root = options.root ?? repoRoot;
  const registry = options.registry ?? process.env.NPM_CONFIG_REGISTRY ?? process.env.NPM_REGISTRY ?? "https://registry.npmjs.org";

  /** @param {keyof typeof SOURCE_FILES} key */
  const readSource = async (key) => {
    const file = options.overrideFiles?.[key] ?? path.join(root, SOURCE_FILES[key]);
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      // Never a skip. A source this checker cannot read is the one case where a
      // green run would mean nothing at all.
      throw new Error(`cannot read ${key} (${file}): ${error?.message ?? error}`);
    }
  };

  const [presetText, patchText, seamManifestText, hostBaselineText, pinsText] = await Promise.all([
    readSource("preset"),
    readSource("patch"),
    readSource("seamManifest"),
    readSource("hostBaseline"),
    readSource("pins"),
  ]);

  const depsVersion = JSON.parse(pinsText);
  const pins = {
    dsh: options.pin ?? depsVersion?.dsh?.version,
    cordis: depsVersion?.dsh?.cordis,
  };
  if (!pins.dsh || !pins.cordis) throw new Error(`${SOURCE_FILES.pins} carries no dsh.version / dsh.cordis; there is nothing to check against`);

  const collected = collectReferences({ presetText, patchText, seamManifestText, hostBaselineText });
  /** @type {Problem[]} */
  const problems = checkExtractionIntegrity(collected);
  /** @type {Problem[]} */
  const warnings = [];
  /** @type {{ reference: Reference, tier: string, detail?: string }[]} */
  const verified = [];

  const dirs = await workspaceDirectories(root);
  const workspacePackages = await loadWorkspacePackages(root);

  /** @param {Reference} reference */
  const checkOne = async (reference) => {
    if (reference.kind === "kernel-builtin") {
      // Loader built-ins are not packages, so no registry or filesystem can
      // answer for them — but "not resolvable" was being treated as "fine",
      // and `cordis:this-builtin-was-renamed-upstream` verified clean. A
      // renamed built-in is precisely the class this guard exists for.
      //
      // The allowlist below is not a copy of an upstream list; it is the set
      // WE have reviewed and mount. An unrecognised one is reported so a human
      // confirms it exists at the pin, which is the only check available.
      if (!REVIEWED_KERNEL_BUILTINS.has(reference.specifier)) {
        problems.push({
          kind: "unreviewed-kernel-builtin",
          file: reference.file,
          line: reference.line,
          specifier: reference.specifier,
          detail: `no registry or filesystem can answer for a loader built-in, so this one has to be confirmed by hand against the pin and added to REVIEWED_KERNEL_BUILTINS. Reviewed today: ${[...REVIEWED_KERNEL_BUILTINS].join(", ")}`,
        });
        return;
      }
      verified.push({ reference, tier: "kernel-builtin" });
      return;
    }

    if (reference.kind === "host-row-id") {
      if (collected.hostRowIds.has(reference.specifier)) {
        verified.push({ reference, tier: "host-row" });
        return;
      }
      problems.push({
        kind: "unresolved-host-row",
        file: reference.file,
        line: reference.line,
        specifier: reference.specifier,
        detail: `no row with this id in ${SOURCE_FILES.hostBaseline}. A patch id that matches nothing only warns on stderr and is dropped, so this override silently does not apply`,
      });
      return;
    }

    if (reference.kind === "workspace-subpath") {
      const result = await resolveWorkspaceSubpath(reference.specifier, workspacePackages);
      if (result.status === "exists") {
        verified.push({ reference, tier: "workspace", detail: result.detail });
        return;
      }
      problems.push({
        kind: "unresolved-workspace-subpath",
        file: reference.file,
        line: reference.line,
        specifier: reference.specifier,
        detail: result.detail,
      });
      return;
    }

    const target = targetVersionFor(reference.specifier, pins);
    const installed = await resolveInstalled(reference.specifier, dirs);

    if (!target) {
      // No pin governs this name. It has to be on disk, or we cannot say
      // anything about it — and "cannot say" is a failure, not a pass.
      if (installed) {
        verified.push({ reference, tier: "installed", detail: `${installed.version} (unpinned)` });
        return;
      }
      problems.push({
        kind: "unverified",
        file: reference.file,
        line: reference.line,
        specifier: reference.specifier,
        detail: `no pin in ${SOURCE_FILES.pins} governs this name and it is not installed in this workspace, so nothing here can confirm it exists`,
      });
      return;
    }

    if (installed && installed.version === target.version) {
      verified.push({ reference, tier: "installed", detail: `${installed.version} at ${path.relative(root, installed.manifestPath)}` });
      return;
    }

    if (reference.role && INSTALLED_ROLES.has(reference.role)) {
      // harness-port imports this one. Not being on disk is a different defect
      // from being unpublished, and it is the one that breaks `pnpm typecheck`.
      if (!installed) {
        problems.push({
          kind: "unresolved-package",
          file: reference.file,
          line: reference.line,
          specifier: reference.specifier,
          detail: `declared \`${reference.role}\` but no copy is installed in this workspace; run pnpm install`,
        });
        return;
      }
      // Installed at the wrong version: reported, not fatal. Other tests own
      // "every derived copy of the pin agrees"; this checker only answers
      // whether the reference resolves, and the registry tier below still does.
      warnings.push({
        kind: "installed-version-drift",
        file: reference.file,
        line: reference.line,
        specifier: reference.specifier,
        detail: `installed ${installed.version}, ${target.source} says ${target.version}`,
      });
    } else if (reference.role && reference.role !== COMPOSITION_ROLE) {
      problems.push({
        kind: "extraction-drift",
        file: reference.file,
        line: reference.line,
        specifier: reference.specifier,
        detail: `unknown seam-manifest role \`${reference.role}\`; this checker does not know whether that means installed here or only in the image`,
      });
      return;
    }

    const result = await resolveRegistry(reference.specifier, target.version, { registry, fetchImpl: options.fetchImpl });
    if (result.status === "exists") {
      verified.push({ reference, tier: "registry", detail: `${target.version} published` });
      return;
    }
    problems.push({
      kind: result.status === "missing" ? "unresolved-package" : "unverified",
      file: reference.file,
      line: reference.line,
      specifier: reference.specifier,
      detail: `${result.detail} (pin from ${target.source}${options.pin ? ", overridden by --pin" : ""})`,
    });
  };

  // Order the report by file then line, not by whichever request came back first.
  const ordered = [...collected.references];
  await pool(ordered, 8, checkOne);
  const byPosition = (a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1);
  problems.sort(byPosition);
  warnings.sort(byPosition);

  return {
    ok: problems.length === 0,
    pins,
    pinOverridden: Boolean(options.pin),
    registry,
    counts: collected.counts,
    checked: collected.references.length,
    verified,
    problems,
    warnings,
  };
}

/** @param {Awaited<ReturnType<typeof verifyCompositionReferences>>} report */
export function formatReport(report) {
  const tiers = new Map();
  for (const item of report.verified) tiers.set(item.tier, (tiers.get(item.tier) ?? 0) + 1);
  const lines = [];
  lines.push(
    `composition references: ${report.checked} checked against dsh ${report.pins.dsh}${report.pinOverridden ? " (--pin dry run)" : ""} / cordis ${report.pins.cordis}`,
  );
  lines.push(`  resolved: ${[...tiers].map(([tier, count]) => `${count} ${tier}`).join(", ") || "none"}`);
  lines.push(`  registry: ${report.registry}`);
  for (const warning of report.warnings) {
    lines.push(`  warn  ${warning.file}:${warning.line}  ${warning.specifier}`);
    lines.push(`        ${warning.detail}`);
  }
  if (report.problems.length === 0) {
    lines.push("  every reference resolves.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`${report.problems.length} reference${report.problems.length === 1 ? "" : "s"} did not resolve:`);
  for (const problem of report.problems) {
    lines.push(`  ${problem.file}:${problem.line}  ${problem.specifier}  [${problem.kind}]`);
    lines.push(`      ${problem.detail}`);
  }
  return lines.join("\n");
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ json: boolean, pin?: string }} */
  const args = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") args.json = true;
    else if (token === "--pin") {
      args.pin = argv[index + 1];
      index += 1;
      if (!args.pin || args.pin.startsWith("--")) throw new Error("--pin needs a version");
    } else if (token.startsWith("--pin=")) args.pin = token.slice("--pin=".length);
    else throw new Error(`unknown argument ${token}`);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const report = await verifyCompositionReferences({ pin: args.pin });
  process.stdout.write(`${args.json ? JSON.stringify(report, replacer, 2) : formatReport(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

/** Sets do not survive JSON.stringify, and `--json` is what the test reads. */
function replacer(_key, value) {
  return value instanceof Set ? [...value] : value;
}
