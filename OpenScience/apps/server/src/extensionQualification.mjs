import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { canonicalJson, extensionProofDigest, qualifyExtensionProof, validateExtensionProofIdentity } from "@evimed/domain";
import { HttpError, openScopedFileNoFollow, readStableFileHandle } from "./security.mjs";

const domain = "evimed-extension-qualification-v1\0";
const hash = text => createHash("sha256").update(text).digest("hex");
const unavailable = () => new HttpError(503, "extension_proof_untrusted", "The extension qualification record is unavailable.");

/** Only the deployment's independent acceptance harness may write this
 * protected signed record. Customer documents, imports and package health
 * output are never qualification authority.
 */
export class ExtensionQualification {
  /** @param {{root:string,secret:string,currentIdentity:any,surfaces:any}} options */
  constructor({ root, secret, currentIdentity, surfaces }) {
    if (typeof secret !== "string" || Buffer.byteLength(secret) < 32 || typeof currentIdentity !== "function" || typeof surfaces !== "function") {
      throw new Error("Invalid trusted qualification configuration.");
    }
    this.root = path.resolve(root); this.secret = secret; this.currentIdentity = currentIdentity; this.surfaces = surfaces;
  }
  /** @param {any} body */
  signature(body) { return createHmac("sha256", this.secret).update(domain).update(canonicalJson(body)).digest("hex"); }
  /** @param {any} entry @param {{identity?:any}} [expected] */
  async authority(entry, expected = {}) {
    if (!entry || typeof entry.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(entry.id)) throw unavailable();
    const file = path.join(this.root, `${hash(entry.id)}.json`);
    const opened = await openScopedFileNoFollow(this.root, file).catch(error => {
      if (["ENOENT", "file_not_found"].includes(error.code)) return null;
      throw error;
    });
    if (!opened) return null;
    let bytes;
    try {
      if (opened.stat.size < 1 || opened.stat.size > 256 * 1024 || (opened.stat.mode & 0o022) !== 0) throw unavailable();
      bytes = await readStableFileHandle(opened.handle, opened.stat);
    } finally { await opened.handle.close(); }
    let envelope;
    try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw unavailable(); }
    if (!envelope || Object.keys(envelope).sort().join(",") !== "body,signature" || !/^[a-f0-9]{64}$/.test(envelope.signature ?? "")
      || !envelope.body || Object.keys(envelope.body).sort().join(",") !== "catalogueId,receipt,schemaVersion,surfaces"
      || envelope.body.schemaVersion !== 1 || envelope.body.catalogueId !== entry.id) throw unavailable();
    const actual = Buffer.from(envelope.signature, "hex"), signed = Buffer.from(this.signature(envelope.body), "hex");
    if (!timingSafeEqual(actual, signed)) throw unavailable();
    let observedIdentity;
    try { observedIdentity = await this.currentIdentity(entry); }
    catch (error) {
      if (error instanceof HttpError && ["runtime_image_unavailable", "runtime_controller_unavailable", "product_state_unavailable"].includes(error.code)) return null;
      throw error;
    }
    const currentIdentity = validateExtensionProofIdentity(observedIdentity);
    if (expected.identity && canonicalJson(expected.identity) !== canonicalJson(currentIdentity)) throw new HttpError(409, "extension_proof_stale", "The extension qualification identity changed.");
    const trustedSurfaces = await this.surfaces(entry);
    if (canonicalJson(trustedSurfaces) !== canonicalJson(envelope.body.surfaces)) throw unavailable();
    const receipt = envelope.body.receipt;
    const receiptDigest = extensionProofDigest(receipt, hash);
    const authority = { sha256Hex: hash, trustedReceiptDigests: new Set([receiptDigest]), trustedSurfaces };
    qualifyExtensionProof(receipt, currentIdentity, authority);
    return { receipt, currentIdentity, authority };
  }
}
