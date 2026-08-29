/**
 * Answers one question: is the DSH kernel we pin behind what upstream ships?
 *
 * Three sources are compared — the pin in the seam manifest, the npm registry,
 * and GitHub releases — because upstream uses them differently and only one is
 * actionable. Every version npm has ever carried is an `-rc.*`; alphas exist
 * only as GitHub tags with no assets (`0.1.2-alpha.1`, 2026-08-27, is the
 * first example). So "GitHub is ahead" means *read the notes and pre-check the
 * seams*, while "npm is ahead" means *bump now* — the Dockerfile installs from
 * npm by exact version and verifies what it got, and a Git build would be
 * neither pinned nor verifiable.
 *
 * Exit codes: 0 = pin matches npm latest (a GitHub-only prerelease may still
 * be noted); 1 = npm carries a newer version, bump is actionable; 2 = could
 * not determine (network).
 *
 * On bump day the order is written down in STATUS S170 and the pins are:
 * seam-manifest.json `dsh`, deploy/runtime-dsh/Dockerfile `DSH_VERSION`,
 * packages/harness-port/package.json (dsh-tools / dsh-storage-domain /
 * dsh-skill), and the golden frames — which are re-recorded from a live
 * session, never edited to match documentation.
 */

const MANIFEST_URL = new URL("../../packages/harness-port/seam-manifest.json", import.meta.url);
const NPM_PACKUMENT = "https://registry.npmjs.org/@deepseek-ai%2Fdsh";
const GITHUB_RELEASES = "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=10";

/** MAJOR.MINOR.PATCH with an optional -name.N prerelease; a release outranks
 *  its own prereleases, prereleases order by name then number.
 *  @param {string} value @returns {{ core: number[], pre: [string, number] | null }} */
function parseVersion(value) {
  const [core, pre] = String(value).split("-", 2);
  const parts = core.split(".").map((item) => Number(item) || 0);
  if (!pre) return { core: parts, pre: null };
  const [name, number] = pre.split(".");
  return { core: parts, pre: [name ?? "", Number(number) || 0] };
}

/** @param {string} left @param {string} right @returns {number} */
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (delta) return delta;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  if (a.pre[0] !== b.pre[0]) return a.pre[0] < b.pre[0] ? -1 : 1;
  return a.pre[1] - b.pre[1];
}

/** @param {string} url @param {Record<string, string>} [headers] */
async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { "user-agent": "evimed-check-dsh-upstream", ...headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

const { readFile } = await import("node:fs/promises");
const manifest = JSON.parse(await readFile(MANIFEST_URL, "utf8"));
const pinned = String(manifest.dsh ?? "");
if (!pinned) {
  console.error("seam-manifest.json carries no dsh pin — nothing to compare against.");
  process.exit(2);
}

let npmLatest = "";
let npmVersions = [];
let githubTag = "";
let githubDate = "";
try {
  const packument = await fetchJson(NPM_PACKUMENT);
  npmLatest = String(packument["dist-tags"]?.latest ?? "");
  npmVersions = Object.keys(packument.versions ?? {});
} catch (error) {
  console.error(`npm registry unreachable: ${error?.message ?? error}`);
  process.exit(2);
}
try {
  const releases = await fetchJson(GITHUB_RELEASES);
  const newest = Array.isArray(releases)
    ? releases.filter((release) => String(release?.tag_name ?? "").startsWith("dsh-v"))[0]
    : null;
  githubTag = String(newest?.tag_name ?? "").replace(/^dsh-v/, "");
  githubDate = String(newest?.published_at ?? "").slice(0, 10);
} catch {
  // GitHub is the advisory half; the npm verdict below stands without it.
  githubTag = "(unreachable)";
}

console.log(`pinned : ${pinned}`);
console.log(`npm    : ${npmLatest} (latest of ${npmVersions.length} published)`);
console.log(`github : ${githubTag}${githubDate ? ` (${githubDate})` : ""}`);

if (npmLatest && compareVersions(npmLatest, pinned) > 0) {
  console.log(`\nnpm carries ${npmLatest} > pinned ${pinned}: bump is actionable now.`);
  console.log("Pins: seam-manifest.json, Dockerfile DSH_VERSION, harness-port package.json; then re-record golden frames from a live session.");
  process.exit(1);
}
if (githubTag && githubTag !== "(unreachable)" && compareVersions(githubTag, pinned) > 0) {
  console.log(`\nGitHub tag ${githubTag} is ahead but not on npm — upstream has never published a non-rc there.`);
  console.log("Not installable yet. Read the release notes and pre-check the seams; bump when the rc lands on npm.");
}
process.exit(0);
