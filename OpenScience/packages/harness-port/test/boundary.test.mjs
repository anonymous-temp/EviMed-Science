// The one rule this package exists to make enforceable: `@deepseek-ai/*` is
// imported here and nowhere else, so a rename upstream is one file.
//
// It was documented in AGENTS.md and checked nowhere outside this package's own
// neighbour — `packages/socket/test/socket.test.mjs` walks `socket/plugins` and
// `socket/src`, which is two directories out of a repository. `apps/server`,
// `apps/desktop` and every other package could import a harness package with
// nothing to say so. A documented rule with no enforcement is not a boundary;
// it is a note about one someone hoped for.
//
// A grep rather than an ESLint rule, deliberately. ESLint sees import
// statements, and the rule explicitly covers the JSDoc `import('...')` type
// form, which is a comment — invisible to the linter that would have to be
// configured once per package. This is zero-dependency, covers both forms, and
// runs everywhere `test:packages` runs.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Where a harness import would actually matter. Scripts under `scripts/` are
 *  build and ops tooling that legitimately resolves the real packages. */
const SCANNED_ROOTS = ["apps", "packages"];

/** The port itself is the exception the rule names. */
const EXEMPT = [path.join("packages", "harness-port")];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", "src-tauri", "target"]);
const SCANNED_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".mts", ".ts", ".tsx"]);

/**
 * Both forms the rule names. A bare string mentioning a harness package is not
 * a violation and must not be treated as one: `agent.cordis.yml` names plugins
 * for the kernel to load, `package.json` declares a peer range, and the
 * contract tests resolve the real package to check the pin — all of which are
 * data about the harness rather than a compiled-in dependency on its shapes.
 */
const VIOLATIONS = [
  { pattern: /from\s+['"]@deepseek-ai\//, why: "imports a harness package directly" },
  { pattern: /import\(\s*['"]@deepseek-ai\//, why: "names a harness package in a dynamic or JSDoc import" },
  { pattern: /require\(\s*['"]@deepseek-ai\//, why: "requires a harness package directly" },
];

/** @param {string} dir @returns {Promise<string[]>} repo-relative file paths */
async function walk(dir) {
  /** @type {string[]} */
  const found = [];
  let entries;
  try {
    entries = await readdir(path.join(repoRoot, dir), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (EXEMPT.some((exempt) => rel === exempt || rel.startsWith(`${exempt}${path.sep}`))) continue;
      found.push(...await walk(rel));
      continue;
    }
    if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) found.push(rel);
  }
  return found;
}

test("no file outside packages/harness-port imports a harness package", async () => {
  const files = (await Promise.all(SCANNED_ROOTS.map((root) => walk(root)))).flat();
  // A scan that silently found nothing would pass forever. The floor is set
  // well under the real count so a reorganization does not fail the build, but
  // well over zero so a broken walk does.
  assert.ok(files.length > 200, `the boundary scan only reached ${files.length} files; the walk is broken`);

  /** @type {string[]} */
  const offences = [];
  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    if (!source.includes("@deepseek-ai/")) continue;
    for (const { pattern, why } of VIOLATIONS) {
      if (pattern.test(source)) offences.push(`${file} ${why}`);
    }
  }
  assert.deepEqual(offences, [], `the harness boundary is breached:\n${offences.join("\n")}`);
});

test("the scan reaches the places a breach would actually happen", async () => {
  // Named explicitly: the previous check lived in `socket`'s own suite and
  // covered `socket/plugins` and `socket/src`. Everything below was outside it.
  const files = (await Promise.all(SCANNED_ROOTS.map((root) => walk(root)))).flat();
  for (const expected of [
    path.join("apps", "server", "src", "runtimeManager.mjs"),
    path.join("apps", "server", "src", "dshRuntimeAdapter.mjs"),
    path.join("packages", "socket", "plugins", "run-policy.mjs"),
    path.join("packages", "domain", "src", "states.mjs"),
  ]) {
    assert.ok(files.includes(expected), `${expected} is not covered by the boundary scan`);
  }
  assert.ok(
    !files.some((file) => file.startsWith(path.join("packages", "harness-port"))),
    "the port is the exception and must not be scanned against its own rule",
  );
});

// A source file that reads as binary is a source file nobody greps.
//
// `coverageJudge.mjs` built a composite key with a NUL separator — a good
// choice — but spelled it as a raw byte in the file rather than as `\u0000`.
// The value was identical and every test passed. What changed was that `grep
// -I`, ugrep and ripgrep all classify the file as binary and skip it, so 453
// lines sitting on the delivery path returned no matches for any search: not
// "no results", but never looked at. It went unnoticed for as long as it did
// precisely because the tool you would use to notice it was the tool it hid
// from.
//
// This lives beside the harness-boundary walk because it is the same kind of
// rule — one about the repository as a whole that no single module can hold.
test("no source file reads as binary, because a file that does is a file nobody searches", async () => {
  const offenders = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!SCANNED_EXTENSIONS.has(path.extname(entry.name))) continue;
      // Read as bytes: decoding first would turn the thing being looked for
      // into an ordinary character and hide it again.
      const bytes = await readFile(full);
      const relative = path.relative(repoRoot, full);
      examined.add(relative);
      if (bytes.includes(0)) offenders.push(relative);
    }
  };
  /** @type {Set<string>} */
  const examined = new Set();
  for (const root of SCANNED_ROOTS) await walk(path.join(repoRoot, root));
  // The walk must prove it walked, and the proof has to be a file actually
  // opened. Two weaker versions of this line were written first: one counted
  // the loop over roots rather than the reads, so deleting the `walk()` call
  // left it green; the next asserted a round-number floor, which is a guess
  // dressed as a check. Naming the file that motivated the rule proves the
  // sweep reached it — and that this file, which every binary-skipping search
  // tool used to drop, is now readable as text.
  assert.ok(
    examined.has(path.join("apps", "server", "src", "coverageJudge.mjs")),
    `the sweep examined ${examined.size} files but not the one that motivated this rule`,
  );
  assert.deepEqual(offenders, [], "write the byte as an escape; the value is the same and the file stays searchable");
});
