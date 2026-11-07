import type { FileRoot } from "@ai4s/shared";
import { readArtifact } from "./artifactFile";

/**
 * A report names its pictures by path relative to itself (`figures/trend.png`, `图/趋势.png`). The conversation's file card
 * resolves those through the kernel's own preview; the report page reads the file as text, so it resolves them here: against
 * the report's own directory, held to the workspace, read through the same authenticated file read the text came from.
 */

const MIME: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon", css: "text/css",
};

/** Largest picture the page will inline; a bigger one stays a missing image rather than stalling the page. */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** Whether a reference is a file of the report's own folder, not an address of its own (`https:`, `data:`, `//host`, `#id`, `/abs`). */
export function isRelativeReference(ref: string): boolean {
  const value = ref.trim();
  return value !== "" && !value.startsWith("#") && !value.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

/**
 * The workspace path a reference names, resolved against the report's path, or `null` when it would leave the workspace or
 * is not a file reference. The query and fragment are dropped; each segment is percent-decoded once (Markdown writers encode
 * Chinese names, others do not).
 */
export function resolveWorkspaceReference(reportPath: string, ref: string): string | null {
  if (!isRelativeReference(ref)) return null;
  const bare = ref.trim().split("#")[0]!.split("?")[0]!;
  const parts = reportPath.split("/").filter(Boolean);
  parts.pop();
  for (const raw of bare.split("/")) {
    let segment: string;
    try { segment = decodeURIComponent(raw); } catch { return null; }
    if (segment === "" || segment === ".") continue;
    if (segment.includes("\\") || segment.includes("\0")) return null;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
}

/** A file of the workspace as a `data:` address, or `null` when it is missing, unreadable, not text or image, or too large. */
export async function readWorkspaceDataUrl(path: string, root: FileRoot | undefined, projectId?: string): Promise<string | null> {
  const mime = MIME[extOf(path)];
  if (!mime) return null;
  try {
    const file = await readArtifact(path, root, projectId);
    if (!file) return null;
    if (file.encoding === "base64") {
      if (file.data.length > MAX_ASSET_BYTES * 1.4) return null;
      return `data:${mime};base64,${file.data}`;
    }
    if (file.data.length > MAX_ASSET_BYTES) return null;
    return `data:${mime};charset=utf-8,${encodeURIComponent(file.data)}`;
  } catch {
    return null;
  }
}

/**
 * An HTML report with the pictures and style sheets it names by relative path read from the workspace and put into the
 * document, because the preview frame is sandboxed with no network of its own (`img-src data:`). A reference that cannot be
 * read is left as written, so it shows as a missing picture.
 */
export async function inlineHtmlWorkspaceAssets(html: string, reportPath: string, root: FileRoot | undefined, projectId?: string): Promise<string> {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const jobs: Array<Promise<void>> = [];
  const cache = new Map<string, Promise<string | null>>();
  const load = (ref: string) => {
    const target = resolveWorkspaceReference(reportPath, ref);
    if (!target) return Promise.resolve(null);
    let pending = cache.get(target);
    if (!pending) { pending = readWorkspaceDataUrl(target, root, projectId); cache.set(target, pending); }
    return pending;
  };
  for (const img of Array.from(doc.querySelectorAll("img[src], source[src], image"))) {
    const ref = img.getAttribute("src") ?? img.getAttribute("href") ?? img.getAttribute("xlink:href");
    if (!ref || !isRelativeReference(ref)) continue;
    jobs.push(load(ref).then((url) => { if (url) img.setAttribute(img.hasAttribute("src") ? "src" : "href", url); }));
  }
  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
    const ref = link.getAttribute("href");
    if (!ref || !isRelativeReference(ref)) continue;
    const target = resolveWorkspaceReference(reportPath, ref);
    if (!target) continue;
    jobs.push(readArtifact(target, root, projectId).then((file) => {
      if (!file || file.encoding !== "utf8") return;
      const style = doc.createElement("style");
      style.textContent = file.data;
      link.replaceWith(style);
    }).catch(() => undefined));
  }
  if (jobs.length === 0) return html;
  await Promise.all(jobs);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
