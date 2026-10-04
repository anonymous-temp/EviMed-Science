/**
 * The SHA-256 of a file's bytes, lower-case hex: the digest the control plane
 * derives a knowledge-base source's id from, so a page that has just uploaded a
 * file can name the source it became without asking the control plane to match
 * it by name.
 */
export async function sha256Hex(file: Pick<Blob, "arrayBuffer">): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
