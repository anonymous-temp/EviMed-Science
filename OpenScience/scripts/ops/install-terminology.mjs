#!/usr/bin/env node
/**
 * Puts the terminology file `term_normalize` reads (`scripts/ops/build-terminology.mjs`) where the deployment reads it: `/data/terminology.sqlite` of the
 * `open-science-data` volume, which the evidence adapter mounts read-only (`EVIMED_TERMINOLOGY_DB`). The volume is written by the web container, so the
 * file goes in through it:
 *
 *   node scripts/ops/install-terminology.mjs --file /var/lib/evimed/terminology.sqlite --container <web container>
 *   node scripts/ops/install-terminology.mjs --file ... --dry-run               # inspect the file and say what would be done
 *   node scripts/ops/install-terminology.mjs --status --adapter-url http://127.0.0.1:8026
 *
 * Hidden knowledge:
 *
 * - **The file is inspected before it is sent**: a regular file (no link), at most 1 GiB, a SQLite file whose `metadata` names the release this reader knows and a
 *   positive count of entities. A file that is none of these is refused here, because the adapter would answer "invalid" for it and the deployment would run on
 *   the built-in table without anyone being told.
 * - **It is installed beside its name and then renamed**, so the adapter never reads half a file; the digest of what arrived is compared with the digest sent.
 * - **A hard link is never made** (the workspace's containment checks refuse one); this copies.
 * - **It is optional**: a deployment without the file keeps `term_normalize`'s built-in table. `--status` and the control plane's readiness (`checks.terminology`)
 *   say whether the file is loaded; nothing fails for it.
 *
 * @module install-terminology
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { TERMINOLOGY_RELEASE } from "./build-terminology.mjs";

const execFileAsync = promisify(execFile);

/** The largest file the readers take (`runtimeManager.mjs` holds the same bound). */
export const TERMINOLOGY_MAX_BYTES = 1024 * 1024 * 1024;
/** Where the adapter reads it in the volume. */
export const TERMINOLOGY_VOLUME_PATH = "/data/terminology.sqlite";

/**
 * What a terminology file is, or why it is not one. Never writes.
 * @param {string} file
 * @returns {{ ok: true, bytes: number, sha256: string, release: string, entities: number, sources: Array<{ id: string, concepts: number }> } | { ok: false, reason: string }}
 */
export function inspectTerminologyFile(file) {
  let info;
  try { info = lstatSync(file); } catch { return { ok: false, reason: "file_missing" }; }
  if (info.isSymbolicLink() || !info.isFile()) return { ok: false, reason: "not_a_regular_file" };
  if (info.size <= 0 || info.size > TERMINOLOGY_MAX_BYTES) return { ok: false, reason: "size_out_of_bounds" };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const meta = Object.fromEntries(db.prepare("SELECT key, value FROM metadata").all().map((row) => [String(row.key), String(row.value)]));
    const entities = Number(meta.entities);
    if (meta.release !== TERMINOLOGY_RELEASE) return { ok: false, reason: "release_unknown" };
    if (!Number.isInteger(entities) || entities <= 0) return { ok: false, reason: "no_entities" };
    const sources = db.prepare("SELECT id, concepts FROM sources ORDER BY id").all().map((row) => ({ id: String(row.id), concepts: Number(row.concepts) }));
    return { ok: true, bytes: info.size, sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), release: meta.release, entities, sources };
  } catch {
    return { ok: false, reason: "not_a_terminology_file" };
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
}

/**
 * Install a file into the volume through the web container. `run` is the docker command runner (a test double in tests).
 * @param {{ file: string, container: string, target?: string, dryRun?: boolean, run?: (args: string[]) => Promise<{ stdout: string }> }} options
 */
export async function installTerminology({ file, container, target = TERMINOLOGY_VOLUME_PATH, dryRun = false, run = async (args) => execFileAsync("docker", args) }) {
  const inspected = inspectTerminologyFile(file);
  if (!inspected.ok) return { installed: false, reason: inspected.reason };
  const summary = { release: inspected.release, entities: inspected.entities, bytes: inspected.bytes, sha256: inspected.sha256, sources: inspected.sources };
  if (dryRun) return { installed: false, dryRun: true, would: `${path.basename(file)} -> ${container}:${target}`, ...summary };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) return { installed: false, reason: "container_invalid" };
  if (!path.posix.isAbsolute(target) || /[\0\r\n'"\\$`]/.test(target)) return { installed: false, reason: "target_invalid" };
  const staging = mkdtempSync(path.join(os.tmpdir(), "evimed-terminology-"));
  const beside = `${target}.partial`;
  try {
    // World-readable: the adapter reads the volume as its own user.
    const staged = path.join(staging, path.posix.basename(target));
    copyFileSync(file, staged);
    chmodSync(staged, 0o644);
    await run(["cp", staged, `${container}:${beside}`]);
    const arrived = String((await run(["exec", container, "sha256sum", beside])).stdout).trim().split(/\s+/)[0];
    if (arrived !== inspected.sha256) {
      await run(["exec", container, "rm", "-f", beside]).catch(() => {});
      return { installed: false, reason: "digest_mismatch", ...summary };
    }
    await run(["exec", container, "mv", "-f", beside, target]);
    return { installed: true, target, ...summary };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * What the evidence adapter says of the file it holds, from its `/health`. Never throws.
 * @param {string} adapterUrl @param {typeof fetch} [fetcher]
 */
export async function terminologyStatus(adapterUrl, fetcher = fetch) {
  try {
    const base = new URL(adapterUrl);
    const response = await fetcher(new URL("/health", base.origin), { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { loaded: false, reason: `adapter_status_${response.status}` };
    const health = /** @type {any} */ (await response.json());
    const fact = health?.terminology ?? {};
    return fact.available === true
      ? { loaded: true, release: fact.release ?? null, entities: Number(fact.entities ?? 0) }
      : { loaded: false, reason: fact.reason ?? "terminology_unavailable" };
  } catch {
    return { loaded: false, reason: "adapter_unreachable" };
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (["dry-run", "status"].includes(name)) out[name] = true;
    else { out[name] = argv[index + 1]; index += 1; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.status) {
    const status = await terminologyStatus(String(args["adapter-url"] ?? ""));
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    process.exit(status.loaded ? 0 : 1);
  }
  if (!args.file || (!args.container && !args["dry-run"])) {
    process.stderr.write("usage: install-terminology.mjs --file FILE --container WEB_CONTAINER [--target PATH] [--dry-run] | --status --adapter-url URL\n");
    process.exit(2);
  }
  const result = await installTerminology({ file: String(args.file), container: String(args.container ?? ""), target: String(args.target ?? TERMINOLOGY_VOLUME_PATH), dryRun: args["dry-run"] === true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.installed || result.dryRun ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
