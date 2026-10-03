import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { HttpError } from "./security.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const authorizationProjection = version => JSON.stringify({ inputs: version.inputs, code: version.code,
  environment: version.environment, sourceRefs: version.findings?.map(finding => finding.sourceRefs), review: version.review });
const verificationScript = `import hashlib, json, pathlib, sys
root = pathlib.Path(__file__).resolve().parent
manifest = json.loads((root / "manifest.json").read_text())
failed = []
for item in manifest["files"]:
    file = (root / item["archivePath"]).resolve()
    if not file.is_relative_to(root) or not file.is_file() or file.stat().st_size != item["bytes"] or hashlib.sha256(file.read_bytes()).hexdigest() != item["sha256"]:
        failed.append(item["archivePath"])
print(json.dumps({"bytes": "changed" if failed else "identical", "failed": failed, "scientific_applicability": "not_assessed"}))
sys.exit(1 if failed else 0)
`;

/** An explicitly selected result and its authorized frozen dependencies. Never a
 * workspace walk; unknown or revoked inputs remain references in the manifest. */
export class ResultExportService {
  constructor({ results, maxBytes = 64 * 1024 * 1024, maxFiles = 64 }) {
    this.results = results; this.maxBytes = maxBytes; this.maxFiles = maxFiles;
  }

  async export(userId, projectId, versionId) {
    const selected = await this.results.get(userId, projectId, versionId);
    const pending = [selected]; const versions = []; const omissions = [];
    const seen = new Set(); const files = []; const contents = Object.create(null);
    let total = 0;
    const add = (name, bytes) => {
      if (Object.hasOwn(contents, name)) return;
      total += bytes.length;
      if (total > this.maxBytes || files.length >= this.maxFiles) throw new HttpError(413, "result_export_limit", "The selected result package exceeds the export limit.");
      contents[name] = bytes; files.push({ archivePath: name, bytes: bytes.length, sha256: sha(bytes) });
    };
    while (pending.length) {
      const version = pending.shift();
      if (seen.has(version.versionId)) continue;
      seen.add(version.versionId);
      const read = await this.results.raw(userId, projectId, version.versionId);
      if (read.version.versionId !== version.versionId || read.version.digest !== version.digest || read.version.size !== version.size) {
        throw new HttpError(409, "result_export_authorization_changed", "The selected result changed during export. Rebuild the package.");
      }
      add(`results/${version.versionId}/${version.path.split("/").at(-1)}`, read.bytes);
      versions.push(read.version);
      for (const input of [...read.version.inputs, read.version.code, read.version.environment].filter(Boolean)) {
        if (!input.versionId || input.availability !== "captured") {
          omissions.push({ id: input.id, kind: input.kind, availability: input.availability, reason: "bytes_not_captured" }); continue;
        }
        try {
          const child = await this.results.get(userId, projectId, input.versionId);
          if (child.digest !== input.digest) throw new HttpError(409, "result_input_changed", "The result input identity changed.");
          if (!seen.has(child.versionId)) pending.push(child);
        } catch (error) {
          if (![403, 404].includes(error?.status)) throw error;
          omissions.push({ kind: input.kind, availability: "restricted", reason: "input_unavailable" });
        }
      }
    }
    add("verify.py", Buffer.from(verificationScript));
    add("README.txt", Buffer.from("EviMed selected research result\n\nRun: python3 verify.py\nThis checks exported file bytes only. Numerical reproduction and scientific applicability are separate assessments.\nUnavailable inputs are references, not bundled data. No environment or recipe is inferred from a filename.\n"));
    const manifest = { format: "evimed-research-result", version: 1, selectedVersionId: selected.versionId,
      exportedAt: new Date().toISOString(), completeness: omissions.length || selected.coverage.gaps.length ? "partial" : "captured",
      versions, omissions, files, scientificApplicability: "not_assessed" };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (total + manifestBytes.length > this.maxBytes) throw new HttpError(413, "result_export_limit", "The selected result package exceeds the export limit.");
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
