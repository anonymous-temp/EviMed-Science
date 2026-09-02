import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const versionPattern = /^[0-9][0-9A-Za-z.+_-]{0,63}$/;
// A pre-release version carries its channel: `0.1.1-rc.2`. The general pattern
// already admits it; this name exists so a reader sees which fields are
// deliberately pinned to something upstream has not tagged yet.
const prereleaseVersionPattern = versionPattern;
const releaseIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const revisionPattern = /^[a-f0-9]{40,64}$/;

/** @returns {Error & Record<string, any>} An Error carrying the extra fields its
 *  callers read; a bare Error type rejects every one of them. */
function failure(code, message = code) {
  /** @type {Error & Record<string, any>} */
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure(code);
  return value;
}

function assertKeys(value, allowed, code) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw failure(code);
  }
}

function assertText(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) throw failure(code);
  return value;
}

function assertDigest(value, code = "release_manifest_digest_invalid") {
  return assertText(value, digestPattern, code);
}

function assertRelativePath(value, code) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:\//.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw failure(code);
  }
  return value;
}

function assertImageReference(value, code) {
  if (typeof value !== "string" || !value || value.length > 255 || /[\s\0]/.test(value)) throw failure(code);
  const last = value.slice(value.lastIndexOf("/") + 1);
  if (value.includes("@")) {
    if (!/@sha256:[a-f0-9]{64}$/.test(value)) throw failure(code);
  } else {
    const separator = last.lastIndexOf(":");
    if (separator <= 0) throw failure("release_manifest_image_unpinned");
    const tag = last.slice(separator + 1);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw failure(code);
    if (tag.toLowerCase() === "latest") throw failure("release_manifest_image_unpinned");
  }
  return value;
}

function assertIsoTimestamp(value) {
  if (typeof value !== "string") throw failure("release_manifest_created_at_invalid");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw failure("release_manifest_created_at_invalid");
  }
  if (timestamp > Date.now() + 5 * 60_000) throw failure("release_manifest_created_at_future");
  return value;
}

export function validateReleaseManifest(input) {
  const manifest = assertRecord(input, "release_manifest_invalid");
  assertKeys(manifest, ["schemaVersion", "app", "source", "web", "runtime", "proxy", "skills", "inputs", "monitoring"], "release_manifest_fields_invalid");
  if (manifest.schemaVersion !== 2) throw failure("release_manifest_schema_unsupported");

  const app = assertRecord(manifest.app, "release_manifest_app_invalid");
  assertKeys(app, ["name", "version", "releaseId"], "release_manifest_app_fields_invalid");
  if (app.name !== "evimed-science") throw failure("release_manifest_app_invalid");
  assertText(app.version, versionPattern, "release_manifest_app_version_invalid");
  assertText(app.releaseId, releaseIdPattern, "release_manifest_release_id_invalid");
  if (/^(?:dev|development|local|latest|unknown|replace|example)(?:[-_.]|$)/i.test(app.releaseId)) {
    throw failure("release_manifest_release_id_placeholder");
  }

  const source = assertRecord(manifest.source, "release_manifest_source_invalid");
  assertKeys(source, ["revision", "createdAt"], "release_manifest_source_fields_invalid");
  assertText(source.revision, revisionPattern, "release_manifest_revision_invalid");
  assertIsoTimestamp(source.createdAt);

  for (const [name, image] of [["web", manifest.web], ["runtime", manifest.runtime]]) {
    const record = assertRecord(image, `release_manifest_${name}_invalid`);
    // The runtime image records which kernel version it carries and which
    // socket bundle was installed into it. Both are release-traceability facts:
    // a receipt written by a different bundle than the image declares is a
    // receipt graded by rules nobody shipped, and the delivery gate refuses it
    // on that basis.
    const kernelFields = name === "runtime"
      ? ["image", "imageId", "dshVersion", "cordisVersion", "socketVersion", "domainVersion", "uvVersion"]
      : ["image", "imageId"];
    assertKeys(record, kernelFields, `release_manifest_${name}_fields_invalid`);
    assertImageReference(record.image, `release_manifest_${name}_image_invalid`);
    assertText(record.imageId, imageIdPattern, `release_manifest_${name}_image_id_invalid`);
    if (name === "runtime") {
      assertText(record.dshVersion, prereleaseVersionPattern, "release_manifest_dsh_version_invalid");
      assertText(record.cordisVersion, prereleaseVersionPattern, "release_manifest_cordis_version_invalid");
      assertText(record.socketVersion, versionPattern, "release_manifest_socket_version_invalid");
      assertText(record.domainVersion, versionPattern, "release_manifest_domain_version_invalid");
      assertText(record.uvVersion, versionPattern, "release_manifest_uv_version_invalid");
    }
  }

  const proxy = assertRecord(manifest.proxy, "release_manifest_proxy_invalid");
  assertKeys(proxy, ["image", "imageId", "caddyVersion"], "release_manifest_proxy_fields_invalid");
  assertImageReference(proxy.image, "release_manifest_proxy_image_invalid");
  assertText(proxy.imageId, imageIdPattern, "release_manifest_proxy_image_id_invalid");
  assertText(proxy.caddyVersion, versionPattern, "release_manifest_caddy_version_invalid");

  if (!Array.isArray(manifest.skills) || manifest.skills.length > 64) {
    throw failure("release_manifest_skills_invalid");
  }
  const skillNames = new Set();
  for (const skill of manifest.skills) {
    const record = assertRecord(skill, "release_manifest_skill_invalid");
    assertKeys(record, ["name", "source", "files", "digest"], "release_manifest_skill_fields_invalid");
    const name = assertText(record.name, releaseIdPattern, "release_manifest_skill_name_invalid");
    if (skillNames.has(name)) throw failure("release_manifest_skill_duplicate");
    skillNames.add(name);
    assertRelativePath(record.source, "release_manifest_skill_source_invalid");
    if (!Number.isSafeInteger(record.files) || record.files <= 0 || record.files > 100_000) {
      throw failure("release_manifest_skill_files_invalid");
    }
    assertDigest(record.digest);
  }

  if (!Array.isArray(manifest.inputs) || manifest.inputs.length === 0 || manifest.inputs.length > 96) {
    throw failure("release_manifest_inputs_invalid");
  }
  const inputPaths = new Set();
  for (const item of manifest.inputs) {
    const record = assertRecord(item, "release_manifest_input_invalid");
    assertKeys(record, ["path", "digest"], "release_manifest_input_fields_invalid");
    const inputPath = assertRelativePath(record.path, "release_manifest_input_path_invalid");
    if (inputPaths.has(inputPath)) throw failure("release_manifest_input_duplicate");
    inputPaths.add(inputPath);
    assertDigest(record.digest);
  }

  const monitoring = assertRecord(manifest.monitoring, "release_manifest_monitoring_invalid");
  assertKeys(
    monitoring,
    ["prometheusVersion", "alertmanagerVersion", "blackboxExporterVersion", "grafanaVersion"],
    "release_manifest_monitoring_fields_invalid",
  );
  for (const value of Object.values(monitoring)) {
    assertText(value, versionPattern, "release_manifest_monitoring_version_invalid");
  }

  return manifest;
}

export function runtimeReleasePolicyError(config) {
  if (!config?.production) return null;
  const runtime = config.releaseManifest?.runtime;
  if (!runtime) return { code: "release_manifest_missing" };
  const mismatch = [
    ["runtimeContainerImage", config.runtimeContainerImage, runtime.image],
    // A manifest whose kernel or socket bundle is not the one the deployment
    // configures is the mismatch this check exists for, and it must be loud.
    ["dshVersion", config.dshVersion, runtime.dshVersion],
    ["socketBundleVersion", config.socketBundleVersion, runtime.socketVersion],
    ["uvVersion", config.uvVersion, runtime.uvVersion],
  ].find(([, actual, expected]) => actual !== expected);
  if (mismatch) return { code: "release_manifest_mismatch", field: mismatch[0] };
  if (Array.isArray(config.runtimeSkillDirs)) {
    const recorded = new Set(config.releaseManifest.skills.map((skill) => skill.source));
    for (const dir of config.runtimeSkillDirs) {
      const relative = path.relative(config.rootDir, dir).split(path.sep).join("/");
      if (!relative || relative.startsWith("../") || path.isAbsolute(relative) || !recorded.has(relative)) {
        return { code: "release_manifest_mismatch", field: "runtimeSkillDirs" };
      }
    }
  }
  return null;
}

export function readReleaseManifestFile(file) {
  if (!file) return { manifest: null, source: "none", error: null };
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) return { manifest: null, source: "file", error: "release_manifest_file_not_regular" };
    if (stat.size > 128 * 1024) return { manifest: null, source: "file", error: "release_manifest_file_too_large" };
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(handle, "utf8"));
    } catch {
      return { manifest: null, source: "file", error: "release_manifest_json_invalid" };
    }
    try {
      return { manifest: validateReleaseManifest(parsed), source: "file", error: null };
    } catch (err) {
      return { manifest: null, source: "file", error: err?.code ?? "release_manifest_invalid" };
    }
  } catch (err) {
    return {
      manifest: null,
      source: "file",
      error: err?.code === "ELOOP" ? "release_manifest_file_symlink" : "release_manifest_file_unavailable",
    };
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

export async function sha256File(file, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const stat = await fsp.lstat(file);
  if (stat.isSymbolicLink()) throw failure("release_input_symlink");
  if (!stat.isFile()) throw failure("release_input_not_regular");
  if (stat.size > maxBytes) throw failure("release_input_too_large");
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const data = await handle.readFile();
    return `sha256:${createHash("sha256").update(data).digest("hex")}`;
  } finally {
    await handle.close();
  }
}

const DEFAULT_SKIP_DIRS = Object.freeze(["node_modules"]);

export async function digestDirectory(root, { maxFiles = 100_000, errorPrefix = "release_skill", skipDirs = DEFAULT_SKIP_DIRS } = {}) {
  const rootStat = await fsp.lstat(root);
  if (rootStat.isSymbolicLink()) throw failure(`${errorPrefix}_symlink`);
  if (!rootStat.isDirectory()) throw failure(`${errorPrefix}_not_directory`);
  const files = [];

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // Installed, not shipped. `packages/socket` and its two siblings became
      // manifest inputs so the release can say which code the runtime image
      // contains, and each carries a pnpm `node_modules` whose workspace links
      // are symlinks -- so the walk hit the symlink guard and `pnpm
      // release:manifest` failed outright. The image runs `npm install` of its
      // own, so hashing this tree would bind bytes the image never uses.
      //
      // Skipped by name before the lstat, so a symlinked `node_modules` (which
      // is what pnpm actually creates) is not followed either. Every other
      // symlink still throws: the guard is what keeps a link from binding a
      // digest to something outside the tree.
      if (skipDirs.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stat = await fsp.lstat(full);
      if (stat.isSymbolicLink()) throw failure(`${errorPrefix}_symlink`);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files.push({ full, relative: path.relative(root, full).split(path.sep).join("/"), size: stat.size });
        if (files.length > maxFiles) throw failure(`${errorPrefix}_file_limit`);
      } else {
        throw failure(`${errorPrefix}_entry_invalid`);
      }
    }
  }

  await walk(root);
  if (files.length === 0) throw failure(`${errorPrefix}_empty`);
  const aggregate = createHash("sha256");
  for (const file of files) {
    const digest = await sha256File(file.full);
    aggregate.update(file.relative);
    aggregate.update("\0");
    aggregate.update(String(file.size));
    aggregate.update("\0");
    aggregate.update(digest);
    aggregate.update("\n");
  }
  return { files: files.length, digest: `sha256:${aggregate.digest("hex")}` };
}
