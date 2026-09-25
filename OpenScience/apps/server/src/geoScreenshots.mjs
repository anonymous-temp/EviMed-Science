/**
 * The probe's screenshots, kept by content (build spec §2): one file per
 * distinct image under the server's data directory,
 * `geo/snapshots/<first two hex>/<sha256>.png`.
 *
 * Hidden knowledge:
 *
 * - **Content-addressed, written once.** The same page shot twice (a login
 *   wall the probe hits on every question) is one file; a second write finds
 *   the file and does nothing. A write goes to a temporary name in the same
 *   directory and is renamed into place, so a reader never sees half a file
 *   and two writers of the same bytes cannot corrupt each other.
 * - **The name is the digest of the bytes**, recomputed here — never a name a
 *   caller supplies — so a snapshot's `screenshot_sha256` always names exactly
 *   the image that was stored.
 * - **PNG only.** The route serves these as `image/png`; anything else the
 *   probe might return is refused rather than stored under a lying suffix.
 *
 * @module geoScreenshots
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The largest screenshot kept (the probe gateway's own ceiling). */
export const GEO_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Where a screenshot lives. Throws on anything but a lowercase sha256, so no
 * caller can turn a name into a path outside the directory.
 * @param {string} dataDir @param {string} sha256
 */
export function geoScreenshotFile(dataDir, sha256) {
  if (!dataDir) throw new TypeError("The server data directory is not configured.");
  if (!SHA256.test(String(sha256))) throw new TypeError("A screenshot is addressed by its lowercase sha256.");
  return path.join(dataDir, "geo", "snapshots", sha256.slice(0, 2), `${sha256}.png`);
}

/**
 * Keep a screenshot. `stored` is false when the same bytes were already kept.
 * @param {string} dataDir @param {Buffer | Uint8Array} bytes
 * @returns {Promise<{ sha256: string, stored: boolean, bytes: number }>}
 */
export async function storeGeoScreenshot(dataDir, bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buffer.length) throw Object.assign(new Error("The screenshot is empty."), { code: "screenshot_empty" });
  if (buffer.length > GEO_SCREENSHOT_MAX_BYTES) throw Object.assign(new Error("The screenshot is too large."), { code: "screenshot_too_large" });
  if (!buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw Object.assign(new Error("The screenshot is not a PNG image."), { code: "screenshot_not_png" });
  }
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const file = geoScreenshotFile(dataDir, sha256);
  if (await exists(file)) return { sha256, stored: false, bytes: buffer.length };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o640);
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { sha256, stored: true, bytes: buffer.length };
}

/**
 * The stored bytes of a screenshot, or null when there is none (or the name
 * is not a sha256). The route checks ownership before it asks.
 * @param {string} dataDir @param {string} sha256
 * @returns {Promise<Buffer | null>}
 */
export async function readGeoScreenshot(dataDir, sha256) {
  let file;
  try {
    file = geoScreenshotFile(dataDir, sha256);
  } catch {
    return null;
  }
  try {
    return await readFile(file);
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "ENOENT") return null;
    throw error;
  }
}

/** @param {string} file */
async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "ENOENT") return false;
    throw error;
  }
}
