import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { RESULT_PACKAGE_EXCLUSIONS, RESULT_PACKAGE_FORMAT, RESULT_PACKAGE_RECORD_FILES, RESULT_PACKAGE_VERSION, executionRecord,
  omissionReason, packageCompleteness, packageCredentialScan, reproductionRecord, verificationRecord } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/** @param {Uint8Array | string} bytes */
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
/** @param {any} version */
const authorizationProjection = version => JSON.stringify({ inputs: version.inputs, code: version.code,
  environment: version.environment, sourceRefs: version.findings?.map((/** @type {any} */ finding) => finding.sourceRefs), review: version.review,
  snapshotInputs: version.snapshot?.inputs });

/**
 * The verifier a package ships with: one standard-library Python file (`resultPackageVerify.py`), read here once. Python
 * rather than Node because the recipient needs nothing installed to run it (a researcher's machine has python3; a Node
 * runtime is not a given) and because zipfile, hashlib and json cover every check. It is bytes in the package like any
 * other: the platform never runs it.
 */
const VERIFIER = readFileSync(new URL("./resultPackageVerify.py", import.meta.url));

const README = Buffer.from(`EviMed selected research result

What this is
  One result version and the versions it recorded as its inputs, code and environment, each with its size and sha-256,
  plus three records of how it was made and checked. manifest.json lists every file; nothing else is in the archive.

  results/<version>/...   the selected result and the dependencies whose bytes are included
  execution.json          what produced each calculation: method, script digest, environment facts as reported, inputs
  verification.json       what has been checked: findings, review and number bindings, re-runs and their comparisons, corrections
  reproduction.json       for a supported calculation: the recipe, the environment, the numbers and the tolerances to hold a re-run to
  verify.py               a verifier that needs nothing but python3

Check it
  python3 -I verify.py                 (from the extracted folder)   or   python3 -I verify.py package.zip
  It checks file sizes and hashes, that nothing is extra or outside the package, that the versions agree with their files,
  that every input, code and environment a version records is either a file or a named omission, and that the completeness
  the manifest declares is the one its omissions give. Exit status 0: as declared. 1: not as declared. 2: not readable.
  It runs nothing from this package and reads the ZIP without extracting it. The hashes show the files are the ones the
  manifest lists, not that the manifest is the one the platform wrote: take the manifest digest it prints from the sender,
  over another channel. Prefer a copy of verify.py you trust over the one in a package you do not.

Reproduce a calculation
  reproduction.json lists, for each supported calculation, how its environment is reconstructed and the numbers a re-run
  must match, under the tolerances the original declared. Write what you re-ran as a JSON list of {key, value, unit} and
  run  python3 -I verify.py --compare numbers.json.  Exit status 3 means the numbers differ. A re-run is a numerical
  agreement, not a judgement of whether the method suits the question: scientific applicability is not assessed here.

What is not here
  Each omission in manifest.json names the dependency and the reason its bytes are not included: only an identity is
  recorded, access was withdrawn, the record is gone, the stored bytes could not be read back as recorded, including them
  would pass the package limit, or they contain text shaped like a credential. manifest.json also lists what no package
  contains by design: credentials, patient-level data, workspace files that were not selected, the conversation, the
  words of a correction request, and an engine's own code (identified by digest).

Importing or reading this package never executes code, resumes a job, restores a credential or gives access to the project
it came from. Nothing in it is signed; an identity in it is a label.
`);

/** What every package carries besides the versions: manifest, verifier, readme and the three records. */
const FIXED_FILES = 6;
/** The part of a package's allowance kept for the manifest and the three records, which the versions' bytes may not use. */
const RECORD_ALLOWANCE = 2 * 1024 * 1024;

/** @param {any} error @returns {string} */
const codeOf = error => (typeof error?.code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(error.code) ? error.code : "read_failed");
/** The ways a dependency's stored bytes can be unreachable for this export without the export being wrong. @param {any} error */
const omittable = error => [403, 404].includes(error?.status)
  || ["result_snapshot_unavailable", "result_snapshot_changed", "result_snapshot_invalid", "result_input_restricted"].includes(error?.code);

/** An explicitly selected result and its authorized frozen dependencies. Never a workspace walk; unknown or revoked
 * inputs remain references in the manifest. A dependency that cannot be included is a named omission, never a refusal
 * of the package; only the selected result's own bytes not fitting or not being readable refuses it. */
export class ResultExportService {
  /**
   * @param {{ results: any, replays?: any, corrections?: any, maxBytes?: number, maxFiles?: number }} dependencies
   *   `replays`: the replay service (the recipe of a result and the re-runs of it); `corrections`: the correction
   *   reader. Either absent leaves that record `unavailable` in the package, never the package refused.
   */
  constructor({ results, replays = null, corrections = null, maxBytes = 64 * 1024 * 1024, maxFiles = 96 }) {
    this.results = results; this.replays = replays; this.corrections = corrections; this.maxBytes = maxBytes; this.maxFiles = maxFiles;
  }

  /** @param {string} userId @param {string} projectId @param {string} versionId */
  async export(userId, projectId, versionId) {
    const selected = await this.results.get(userId, projectId, versionId);
    /** @type {any[]} */ const pending = [selected];
    /** @type {any[]} */ const versions = [];
    /** What became of each version a reference named: its file, or why it is not one. @type {Map<string, {archivePath?: string, reason?: string, bytes?: number}>} */
    const decided = new Map();
    const seen = new Set();
    /** @type {any[]} */ const files = [];
    /** @type {Record<string, Uint8Array>} */ const contents = Object.create(null);
    const limitError = () => new HttpError(413, "result_export_limit", "The selected result package exceeds the export limit.");
    const room = this.maxBytes - VERIFIER.length - README.length - Math.min(RECORD_ALLOWANCE, Math.floor(this.maxBytes / 8));
    const roomFiles = this.maxFiles - FIXED_FILES;
    let total = 0;
    /** @param {string} name @param {Uint8Array} bytes @param {Record<string, any>} extra */
    const add = (name, bytes, extra) => {
      if (Object.hasOwn(contents, name)) return;
      total += bytes.length;
      contents[name] = bytes; files.push({ archivePath: name, bytes: bytes.length, sha256: sha(bytes), ...extra });
    };
    while (pending.length) {
      const version = pending.shift();
      if (seen.has(version.versionId)) continue;
      seen.add(version.versionId);
      const isSelected = version.versionId === selected.versionId;
      let read;
      try { read = await this.results.raw(userId, projectId, version.versionId); }
      catch (error) {
        if (isSelected || !omittable(error)) throw error;
        decided.set(version.versionId, { reason: omissionReason({ status: /** @type {any} */ (error).status, code: /** @type {any} */ (error).code }), bytes: version.size });
        continue;
      }
      if (read.version.versionId !== version.versionId || read.version.digest !== version.digest || read.version.size !== version.size) {
        throw new HttpError(409, "result_export_authorization_changed", "The selected result changed during export. Rebuild the package.");
      }
      versions.push(read.version);
      const scan = packageCredentialScan({ path: version.path, mimeType: version.mimeType, bytes: read.bytes });
      if (scan === "credential_shaped") decided.set(version.versionId, { reason: "credential_shaped_text", bytes: read.bytes.length });
      else if (total + read.bytes.length > room || files.length >= roomFiles) {
        if (isSelected) throw limitError();
        decided.set(version.versionId, { reason: "over_package_limit", bytes: read.bytes.length });
      } else {
        const archivePath = `results/${version.versionId}/${version.path.split("/").at(-1)}`;
        add(archivePath, read.bytes, { role: isSelected ? "result" : "dependency", versionId: version.versionId, scan });
        decided.set(version.versionId, { archivePath });
      }
      for (const input of [...read.version.inputs, read.version.code, read.version.environment].filter(Boolean)) {
        if (!input.versionId || input.availability !== "captured" || decided.has(input.versionId) || seen.has(input.versionId)) continue;
        try {
          const child = await this.results.get(userId, projectId, input.versionId);
          if (child.digest !== input.digest) throw new HttpError(409, "result_input_changed", "The result input identity changed.");
          if (child.size > room - total || files.length >= roomFiles) decided.set(child.versionId, { reason: "over_package_limit", bytes: child.size });
          else pending.push(child);
        } catch (error) {
          if (![403, 404].includes(/** @type {any} */ (error)?.status)) throw error;
          decided.set(input.versionId, { reason: "input_unavailable" });
        }
      }
    }

    // Every reference of every version read is a file or a named omission.
    /** @type {any[]} */ const omissions = [];
    for (const version of versions) {
      for (const [role, references] of /** @type {[string, any[]][]} */ ([["input", version.inputs], ["code", [version.code]], ["environment", [version.environment]]])) {
        for (const reference of references.filter(Boolean)) {
          const outcome = reference.versionId && reference.availability === "captured" ? decided.get(reference.versionId) : null;
          if (outcome?.archivePath) continue;
          omissions.push({ requiredBy: version.versionId, role, kind: reference.kind, id: reference.id, versionId: reference.versionId ?? null,
            digest: reference.digest ?? null, bytes: outcome?.bytes ?? null, availability: reference.availability,
            reason: outcome?.reason ?? omissionReason({ availability: reference.availability }) });
        }
      }
    }
    // The selected result's own bytes, when they could not be included, are the first thing a recipient needs to know.
    const selectedOutcome = decided.get(selected.versionId);
    if (!selectedOutcome?.archivePath) {
      omissions.unshift({ requiredBy: null, role: "result", kind: "artifact", id: selected.versionId, versionId: selected.versionId, digest: selected.digest,
        bytes: selected.size, availability: "captured", reason: selectedOutcome?.reason ?? "bytes_not_captured" });
    }

    const accounting = {
      archivePathFor: (/** @type {string} */ id) => decided.get(id)?.archivePath ?? null,
      reasonFor: (/** @type {string} */ requiredBy, /** @type {string} */ role, /** @type {any} */ reference) => omissions.find(item => item.requiredBy === requiredBy
        && item.role === role && item.kind === reference.kind && item.id === reference.id && item.versionId === (reference.versionId ?? null))?.reason ?? null,
    };
    const subjects = versions.filter(version => version.versionId === selected.versionId || version.machineValues?.length
      || ["engine_job", "skill_script", "render"].includes(version.snapshot?.kind));
    /** A record that cannot be read is `unavailable` with its reason; it is a label, never a refusal of the package.
     * @param {(() => Promise<any[]>) | null} operation */
    const recorded = async operation => {
      if (!operation) return { status: "unavailable", reason: "not_configured" };
      try { return { status: "recorded", items: await operation() }; } catch (error) { return { status: "unavailable", reason: codeOf(error) }; }
    };
    const execution = []; const verification = []; const calculations = [];
    for (const version of subjects) {
      execution.push(executionRecord(version, accounting));
      verification.push(verificationRecord(version, {
        replays: await recorded(this.replays ? () => this.replays.listFor(userId, projectId, version.versionId) : null),
        corrections: await recorded(this.corrections ? async () => (await this.corrections.read(userId, projectId, version.versionId)).items : null),
      }));
      if (version.machineValues?.length) {
        const recipe = this.replays ? await this.replays.recipe(userId, version).catch(() => null) : null;
        const record = reproductionRecord(version, { recipe, archivePathFor: accounting.archivePathFor });
        if (record) calculations.push(record);
      }
    }
    /** @param {unknown} value */
    const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    const records = [
      [RESULT_PACKAGE_RECORD_FILES.execution, json({ schemaVersion: 1, versions: execution })],
      [RESULT_PACKAGE_RECORD_FILES.verification, json({ schemaVersion: 1, versions: verification })],
      [RESULT_PACKAGE_RECORD_FILES.reproduction, json({ schemaVersion: 1, calculations,
        ...(calculations.length ? {} : { note: "No calculation in this package has a recorded recipe or an observed script, so there is nothing to reconstruct." }) })],
    ];
    for (const [name, bytes] of records) add(/** @type {string} */ (name), /** @type {Buffer} */ (bytes), { role: "record", versionId: null, scan: "not_applicable" });
    add("verify.py", VERIFIER, { role: "verifier", versionId: null, scan: "not_applicable" });
    add("README.txt", README, { role: "readme", versionId: null, scan: "not_applicable" });

    const manifest = { format: RESULT_PACKAGE_FORMAT, version: RESULT_PACKAGE_VERSION, selectedVersionId: selected.versionId,
      exportedAt: new Date().toISOString(), completeness: packageCompleteness({ omissions, gaps: selected.coverage.gaps }),
      coverageGaps: [...selected.coverage.gaps], scientificApplicability: "not_assessed",
      records: { ...RESULT_PACKAGE_RECORD_FILES }, files, versions, omissions, exclusions: RESULT_PACKAGE_EXCLUSIONS };
    const manifestBytes = json(manifest);
    if (total + manifestBytes.length > this.maxBytes) throw limitError();
    contents["manifest.json"] = manifestBytes;
    // Reauthorize every included version after materialization, before release.
    for (const version of versions) {
      const current = await this.results.get(userId, projectId, version.versionId);
      if (current.digest !== version.digest || current.size !== version.size
        || authorizationProjection(current) !== authorizationProjection(version)) {
        throw new HttpError(409, "result_export_authorization_changed", "Source access changed during export. Rebuild the package.");
      }
    }
    return { bytes: Buffer.from(zipSync(contents, { level: 0 })), manifest,
      filename: `${selected.versionId}.evimed.zip`, mimeType: "application/zip" };
  }
}
