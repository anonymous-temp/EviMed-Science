/** Keep the base's private GEO pack when a clean public checkout carries only its README. */
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fail = () => { throw new Error("Private GEO source is an incomplete or partial bundle."); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function filesUnder(root, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const rel = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, rel));
    else if (entry.isFile()) files.push({ path: rel, data: await readFile(path.join(root, rel)) });
    else fail();
  }
  return files;
}

export async function refreshGeoPack(source, target) {
  const installed = await lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (installed && !installed.isDirectory()) fail();
  const entries = await readdir(source, { withFileTypes: true });
  if (entries.length === 1 && entries[0].name === "README.md" && entries[0].isFile()) {
    if (!installed) throw new Error("The verified base has no installed private GEO pack.");
    return "preserved";
  }
  const skills = entries.find(entry => entry.name === "skills");
  const receipt = entries.find(entry => entry.name === "VENDORED.json");
  if (!skills?.isDirectory() || !receipt?.isFile()) fail();
  const stamp = JSON.parse(await readFile(path.join(source, "VENDORED.json"), "utf8"));
  const files = (await filesUnder(source)).filter(file => /^(skills|shared)\//.test(file.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const digest = hash(files.map(file => `${file.path}\0${hash(file.data)}\n`).join(""));
  if (!files.some(file => /^skills\/[^/]+\/SKILL\.md$/.test(file.path))
    || stamp.package !== "geo-skills" || stamp.files !== files.length || stamp.tree !== digest) fail();
  // Validate the complete receipt before replacing anything, including stale files.
  const staging = await mkdtemp(path.join(path.dirname(target), ".evimed-geo-pack-"));
  const previous = `${staging}.previous`;
  let moved = false;
  try {
    await cp(source, staging, { recursive: true, force: true });
    if (installed) { await rename(target, previous); moved = true; }
    try { await rename(staging, target); }
    catch (error) { if (moved) await rename(previous, target); moved = false; throw error; }
    await rm(previous, { recursive: true, force: true }); moved = false;
    return "replaced";
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (!moved) await rm(previous, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , source, target] = process.argv;
  if (!source || !target) throw new Error("Usage: refresh-geo-pack.mjs SOURCE TARGET");
  await refreshGeoPack(source, target);
}
