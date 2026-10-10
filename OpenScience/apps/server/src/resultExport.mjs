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

const README = Buffer.from(`EviMed 研究结果包

这个包里有：
  results/<版本>/...   所选的结果，以及随它保存的输入、代码和环境文件
  execution.json       每个计算是怎么产生的：方法、脚本、运行环境、输入
  verification.json    结论与来源的对应，以及重算和修改的记录
  reproduction.json    可以重算的计算：配方、环境、数值和容差
  manifest.json        包里每个文件的清单，以及没有带上的内容和原因
  verify.py            检查文件是否完整、比对重算数值的脚本，只需要 python3

检查文件是否完整：
  python3 -I verify.py                 （在解压后的文件夹里）  或  python3 -I verify.py package.zip
  它检查文件大小和哈希、清单与文件是否一致、清单里的每个输入是文件还是写明原因的缺项，
  不运行包里的任何东西。退出码 0 表示与清单一致，1 表示不一致，2 表示读不了这个包。

重算一个计算：
  reproduction.json 列出每个可以重算的计算怎样重建环境，以及重算的数值要对上哪些数、容差是多少。
  把你重算得到的结果写成 {key, value, unit} 的 JSON 列表（numbers.json），运行
  python3 -I verify.py --compare numbers.json
  退出码 3 表示数值不同。

没有带上的内容：
  manifest.json 的 omissions 里逐条写明缺的依赖和原因：只记录了身份、已经没有访问权限、
  记录已不在、保存的内容读不回原样、放进来会超出包的大小上限，或含有形似凭据的文本。
  凭据、受试者层面的数据、没有选中的工作区文件、对话本身、修改请求的原话，以及计算引擎自己的代码
  （只记录摘要）从不放进包里。
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
