#!/usr/bin/env node
/** Read-only source publication inventory. No source text, credentials, recovery writes or schema migrations.
 * Set OPEN_SCIENCE_DATABASE_URL; optionally pass --roots=/path/roots.json containing
 * [{ userId, projectId, root }] to inspect original bytes under explicitly supplied workspace roots. */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { readFile, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @param {any[]} rows @param {{ readDigest?: (row:any, rel:string)=>Promise<string|null> }} [options] */
export async function sourcePublicationInventory(rows, { readDigest = async () => null } = {}) {
  const issues = [];
  const families = new Map();
  const paths = new Map();
  for (const row of [...rows].sort((a, b) => `${a.user_id}:${a.project_id}:${a.id}`.localeCompare(`${b.user_id}:${b.project_id}:${b.id}`))) {
    const payload = row.payload ?? {};
    const base = { userId: row.user_id, projectId: row.project_id, sourceId: row.id, revision: row.revision, deleted: Boolean(row.deleted_at) };
    const sourcePaths = Array.isArray(payload.paths) ? payload.paths : [];
    const notes = sourcePaths.filter(rel => /^knowledge-base\/notes\//.test(rel));
    if (notes.length > 1 && (!payload.publication?.bindings || payload.publication?.legacyAmbiguous)) issues.push({ ...base, code: "ambiguous_merged_notes", paths: [...notes].sort() });
    if (!notes.length && sourcePaths.length > 1 && !payload.logicalPath
      && (!payload.publication?.bindings || payload.publication?.legacyAmbiguous)) {
      issues.push({ ...base, code: "ambiguous_source_aliases", paths: [...sourcePaths].sort() });
    }
    const bindings = payload.publication?.bindings ?? { [payload.familyId ?? payload.logicalPath ?? row.id]: { current: payload.publication?.current !== false } };
    for (const [familyId, binding] of Object.entries(bindings)) {
      const familyKey = `${row.user_id}\0${row.project_id}\0${familyId}`;
      const family = families.get(familyKey) ?? [];
      family.push({ ...row, bindingCurrent: binding.current, bindingFamilyId: familyId }); families.set(familyKey, family);
    }
    for (const rel of sourcePaths) {
      const key = `${row.user_id}\0${row.project_id}\0${rel}`;
      const owners = paths.get(key) ?? [];
      owners.push(row); paths.set(key, owners);
      const actual = await readDigest(row, rel);
      if (actual != null && actual !== payload.fingerprint?.sha256) issues.push({ ...base, code: "file_hash_mismatch", path: rel,
        expectedSha256: payload.fingerprint?.sha256 ?? null, actualSha256: actual });
    }
  }
  for (const family of families.values()) {
    const live = family.filter(row => !row.deleted_at && row.bindingCurrent !== false);
    if (live.length > 1) issues.push({ userId: live[0].user_id, projectId: live[0].project_id, code: "conflicting_live_family",
      familyId: live[0].bindingFamilyId ?? null, sourceIds: live.map(row => row.id).sort() });
  }
  for (const owners of paths.values()) {
    if (new Set(owners.map(row => row.payload.fingerprint?.sha256)).size > 1 && owners.some(row => !row.deleted_at)) {
      issues.push({ userId: owners[0].user_id, projectId: owners[0].project_id, code: "shared_path_hash_conflict",
        sourceIds: owners.map(row => row.id).sort(), includesDeleted: owners.some(row => Boolean(row.deleted_at)) });
    }
  }
  return { schemaVersion: 1, sourceCount: rows.length, issues: issues.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}

async function main() {
  const url = process.env.OPEN_SCIENCE_DATABASE_URL;
  if (!url) throw new Error("OPEN_SCIENCE_DATABASE_URL is required.");
  const rootsArgument = process.argv.find(arg => arg.startsWith("--roots="));
  const roots = rootsArgument ? JSON.parse(await readFile(rootsArgument.slice(8), "utf8")) : [];
  const { Client } = createRequire(new URL("../../apps/server/package.json", import.meta.url))("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await client.query("SELECT user_id,project_id,id,revision,payload,deleted_at FROM evimed_product.documents WHERE kind='source' ORDER BY user_id,project_id,id");
    const result = await sourcePublicationInventory(rows, { readDigest: async (row, rel) => {
      const root = roots.find(entry => entry.userId === row.user_id && entry.projectId === row.project_id)?.root;
      if (!root) return null;
      const target = path.resolve(root, rel);
      if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Source path escapes its supplied workspace root.");
      // Refuse symlinks at every segment, including the explicitly supplied workspace root.
      let current = path.parse(target).root;
      for (const segment of target.slice(current.length).split(path.sep)) {
        current = path.join(current, segment);
        try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Inventory refuses symbolic links."); }
        catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
      }
      const hash = createHash("sha256");
      for await (const bytes of createReadStream(target)) hash.update(bytes);
      return hash.digest("hex");
    } });
    await client.query("ROLLBACK");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { await client.end(); }
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Source inventory failed: ${error.code ?? error.message}\n`); process.exitCode = 1; });
}
