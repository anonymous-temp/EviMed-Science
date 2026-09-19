/**
 * The web pages a run read (contract X5), for the 「已阅读的网页」 cards in the
 * run view and in the 「依据」 popover. Pure functions; the components draw.
 *
 * The browser never shows a live browser (ruling 2026-09-19): what a reader
 * gets is the page's title, site and time, a link to the original, and a link
 * to the snapshot the run preserved and may have quoted — the copy the quote
 * check read, which is what makes a web source checkable after the fact.
 */

import type { WebReadPage } from "@/lib/apiClient";

/** Only an http(s) address becomes a link: the record crossed a network. */
export function safeWebHref(value: string | undefined | null): string | null {
  if (!value || !/^https?:\/\//i.test(value)) return null;
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

/** The reader route for a preserved snapshot in this run's workspace. */
export function snapshotHref(runId: string, snapshotPath: string): string {
  const encoded = snapshotPath.split("/").map(encodeURIComponent).join("/");
  return `/app/runs/${encodeURIComponent(runId)}/files/${encoded}`;
}

/**
 * The page a claim's source was read from, when the run read it with
 * `web_read`: the preserved snapshot the claim cites, or failing that the same
 * address. Null for a source that is not a page this run read.
 */
export function pageForSource(
  pages: readonly WebReadPage[] | null | undefined,
  source: { artifactPath?: string; sourceUrl?: string },
): WebReadPage | null {
  if (!pages?.length) return null;
  if (source.artifactPath) {
    const bySnapshot = pages.find((page) => page.snapshotPath === source.artifactPath);
    if (bySnapshot) return bySnapshot;
  }
  const href = safeWebHref(source.sourceUrl);
  if (!href) return null;
  return pages.find((page) => page.finalUrl === href || page.url === href) ?? null;
}

/**
 * 「已阅读的网页 N 个」, with how many are official — counted only when every
 * page is listed, so the share is never a share of a truncated list.
 */
export function readPagesSummary(pages: readonly WebReadPage[], total?: number): string {
  const count = Math.max(total ?? 0, pages.length);
  const official = pages.filter((page) => page.official).length;
  return official > 0 && count === pages.length
    ? `已阅读的网页 ${count} 个（官方来源 ${official} 个）`
    : `已阅读的网页 ${count} 个`;
}
