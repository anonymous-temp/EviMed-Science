/**
 * The reader's images (contract 1.4.0 `media`, contract B `GET /api/frontier/media/:id`, 2026-10-22).
 *
 * The plugin stores each image an entry carries — re-encoded, at most 1.5 MB, named by the SHA-256 of its stored bytes — and serves
 * it at `GET /v1/media/{id}` behind the same bearer token as every other route. The browser never reaches the plugin: it asks the
 * control plane, which signs nothing and adds nothing, and passes the bytes on.
 *
 * Hidden knowledge:
 *
 * - **An id is served only while a published item names it** (`FrontierService.media`): an image of a withdrawn or never
 *   published item is a 404 like an id that never existed. The id is a content hash, so an answer may be cached for a day by the
 *   reader's browser (`Cache-Control: private, max-age=86400`) under the id as its tag: the same id is always the same bytes.
 * - **Only images.** The plugin is trusted, but a body that does not say it is an image, or is larger than the plugin's own cap
 *   allows, is refused (`frontier_media_invalid`) rather than handed to a browser; `X-Content-Type-Options: nosniff` goes with
 *   every answer.
 * - An evicted image (the plugin's store keeps the least recently served under its cap) is the plugin's 404, and so the reader's:
 *   the item keeps its media entry and its original link (contract 1.4.0), and the reader omits the picture.
 *
 * @module frontierMedia
 */

import { readKnowledgePluginToken } from "./knowledgePluginClient.mjs";
import { HttpError } from "./security.mjs";

/** A media id: the SHA-256 of the stored bytes. */
export const FRONTIER_MEDIA_ID = /^[a-f0-9]{64}$/;
/** The plugin re-encodes to at most 1.5 MB; a little room for its headers' rounding, never a video. */
export const FRONTIER_MEDIA_MAX_BYTES = 2 * 1024 * 1024;
/** The image types a reader is handed. */
export const FRONTIER_MEDIA_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

/**
 * The reader's media list from an item's stored `media` (contract 1.4.0), each pointing at the proxy; entries without a valid id
 * are left out (never a made-up picture).
 * @param {unknown} media @returns {Array<{ id: string, url: string, width: number | null, height: number | null, alt: string | null }>}
 */
export function frontierMediaList(media) {
  const size = (/** @type {unknown} */ value) => (Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 20_000 ? Number(value) : null);
  return (Array.isArray(media) ? media : [])
    .filter((entry) => entry && typeof entry === "object" && FRONTIER_MEDIA_ID.test(String(entry.id ?? ""))
      && (entry.kind === undefined || entry.kind === "image" || entry.kind === "video-poster"))
    .slice(0, 8)
    .map((entry) => ({ id: entry.id, url: `/api/frontier/media/${entry.id}`, width: size(entry.width), height: size(entry.height),
      alt: typeof entry.alt === "string" && entry.alt.trim() ? entry.alt.trim().slice(0, 300) : null }));
}

/**
 * One image's bytes from the plugin.
 * @param {{ baseUrl?: string, tokenFile?: string, timeoutMs?: number, fetch?: typeof fetch } | null | undefined} client the
 *   platform's `KnowledgePluginClient` (its address, token file, deadline and fetch)
 * @param {string} id
 * @returns {Promise<{ bytes: Buffer, contentType: string }>}
 */
export async function fetchFrontierMedia(client, id) {
  if (!FRONTIER_MEDIA_ID.test(String(id ?? ""))) throw new HttpError(404, "frontier_media_not_found", "No such image.");
  if (!client?.baseUrl || !client.tokenFile || typeof client.fetch !== "function") {
    throw new HttpError(503, "knowledge_plugin_unconfigured", "The knowledge plugin is not configured for this deployment.");
  }
  const token = await readKnowledgePluginToken(client.tokenFile);
  if (token.error) throw new HttpError(503, "knowledge_plugin_unconfigured", "The knowledge plugin token file is unusable.");
  let response;
  try {
    response = await client.fetch(new URL(`${client.baseUrl}/v1/media/${id}`), {
      method: "GET", headers: { accept: FRONTIER_MEDIA_TYPES.join(", "), authorization: `Bearer ${token.value}` }, redirect: "error",
      signal: AbortSignal.timeout(Math.max(1_000, Number(client.timeoutMs) || 8_000)),
    });
  } catch {
    throw new HttpError(503, "knowledge_plugin_unreachable", "The knowledge plugin is unreachable.");
  }
  if (response.status === 404) throw new HttpError(404, "frontier_media_not_found", "No such image.");
  if (!response.ok) throw new HttpError(502, "knowledge_plugin_failed", `The knowledge plugin failed with HTTP ${response.status}.`);
  const contentType = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!FRONTIER_MEDIA_TYPES.includes(contentType) || declared > FRONTIER_MEDIA_MAX_BYTES) {
    try { await response.body?.cancel(); } catch { /* refused either way */ }
    throw new HttpError(502, "frontier_media_invalid", "The knowledge plugin's answer is not an image this reader serves.");
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let length = 0;
  for await (const chunk of /** @type {any} */ (response.body ?? [])) {
    length += chunk.length;
    if (length > FRONTIER_MEDIA_MAX_BYTES) throw new HttpError(502, "frontier_media_invalid", "The knowledge plugin's image is larger than its own cap.");
    chunks.push(Buffer.from(chunk));
  }
  return { bytes: Buffer.concat(chunks), contentType };
}
