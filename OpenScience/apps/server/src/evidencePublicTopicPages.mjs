// The public pages of the platform's topic zones as pure functions: a view model in, `{ title, description, body, jsonLd }` out (plan
// 2026-10-29 §4.7, §6.9). Nothing here reads a database or a request; every value reaches the markup through `html`, every address
// through `safeHref`/`pathLink`, as the rest of the public pages do, and the structured data is made from the same view model the
// page is, so it states nothing the page does not show.
//
// Hidden knowledge:
//
// - **Structured data states what is on the page and no more** (Google's rule, and ours): the name, the keywords, the scope, the date
//   the page changed, the breadcrumb a reader sees, the items the list shows. No `ClaimReview` (Google stopped showing it in 2025 and
//   a zone is not a fact check). `about` names a keyword as a `MedicalCondition` (with the MeSH id when its tag has one) or a `Drug`
//   from the tag's kind, and as a plain `Thing` otherwise.
// - **The JSON is made safe for a script block, not trusted**: `<`, `>` and `&` are written as escapes so no value can close the block.
// - **A zone's page is its own canonical address** at `/z/<id>`; the readable alias `/z/s/<slug>` says the same and names the id's page
//   as canonical, so a zone is one page to a search engine whichever address a link used.
// - **The feed is RSS 2.0 with dates in Beijing time** (`+0800`), the zone's last fifty items: a title, the 导读, a link to the original
//   and the item's own identifier as the `guid` (the original's address is the link, and two zones may carry one original).

import { externalLink, html, pathLink, safeHref, timeTag } from "./evidencePublicHtml.mjs";
import { evidenceAbsoluteUrl } from "./evidencePublicIndexing.mjs";
import { EVIDENCE_SITE_NAME, appZonePath } from "./evidencePublicLayout.mjs";
import { evidencePublicPath } from "./evidencePublicPaths.mjs";

const SUMMARY_CHARS = 150;
const LIFECYCLE_NOTES = Object.freeze({ quiet: "这个专区近期动态不多，仍会随新的进展更新。", archived: "这个专区已归档，不再更新；以下是它停止更新前的内容。" });

/** @param {string} id */
export const topicZonePath = (id) => evidencePublicPath(`/z/${encodeURIComponent(id)}`);
/** @param {string} slug */
export const topicZoneSlugPath = (slug) => evidencePublicPath(`/z/s/${encodeURIComponent(slug)}`);
/** @param {string} id */
export const topicZoneFeedPath = (id) => evidencePublicPath(`/z/${encodeURIComponent(id)}/feed.xml`);

/** @param {unknown} value @param {number} [max] */
const clip = (value, max = SUMMARY_CHARS) => {
  const characters = [...String(value ?? "").replace(/\s+/g, " ").trim()];
  return characters.length > max ? `${characters.slice(0, max).join("")}…` : characters.join("");
};

/**
 * 「最新进展」 with its marks `[n]` turned into links to the numbered references under it. A mark is a format (`[` digits `]`), checked
 * against the references the zone holds; one with no reference stays as the plain text the model wrote.
 * @param {string} text @param {Set<number>} known
 */
function progressParagraph(text, known) {
  const parts = text.split(/(\[\d{1,2}\])/g);
  return parts.map((part) => {
    const mark = /^\[(\d{1,2})\]$/.exec(part);
    return mark && known.has(Number(mark[1])) ? html`<a href="#ref-${mark[1]}">${part}</a>` : part;
  });
}

/**
 * One zone's page.
 * @param {{ zone: import("./evidencePublicTopicReads.mjs").PublicTopicZone, items: any[], cited: Map<string, { title: string, source: string, url: string }>,
 *   keyUpdates: any[], shown: number, publicUrl?: unknown, tags?: Map<string, { kind: string | null, nameEn: string | null, meshUi: string | null }> }} model
 *   `shown` is how many items the zone had in the window, of which `items` are the newest; `tags` is what the keywords' tags say of them.
 * @returns {{ title: string, description: string, body: any, jsonLd: any }}
 */
export function topicZonePage({ zone, items, cited, keyUpdates, shown, publicUrl = null, tags = new Map() }) {
  const references = (zone.progress?.refs ?? []).flatMap((ref) => {
    const found = cited.get(ref.itemId);
    return found ? [{ n: ref.n, ...found }] : [];
  }).sort((left, right) => left.n - right.n);
  const known = new Set(references.map((ref) => ref.n));
  const keywords = zone.keywords.map((keyword) => keyword.label);
  const row = (/** @type {any} */ item) => html`<li>
<h3>${item.title}${item.labels.map((/** @type {string} */ label) => html` <span class="badge danger">${label}</span>`)}</h3>
${item.guide ? html`<p>${clip(item.guide, 200)}</p>` : ""}
<p class="meta">${item.source}${item.at ? html` · ${timeTag(item.at)}` : ""} · ${externalLink(item.url, "原文")}</p>
</li>`;
  const note = /** @type {Record<string, string>} */ (LIFECYCLE_NOTES)[zone.lifecycle] ?? "";
  const description = clip(zone.progress?.text.replace(/\[\d{1,2}\]/g, "") || zone.scope || `${zone.title}的最新医学进展。`);
  return {
    title: `${zone.title} · ${EVIDENCE_SITE_NAME}`,
    description,
    jsonLd: topicZoneJsonLd({ zone, items, keywords: zone.keywords, publicUrl, tags }),
    body: html`<p class="producer"><strong>出品方：</strong>EviMed 证据中心。平台按主题整理，每条都链接到原文。</p>
<h1>${zone.title}</h1>
<p class="meta">${keywords.length ? html`关键词：${keywords.join(" × ")}` : ""}${zone.specialty ? html` · ${zone.specialty.label}` : ""}${zone.group ? html` · ${zone.group}` : ""}${zone.modified ? html` · 更新于 ${timeTag(zone.modified)}` : ""}</p>
${zone.scope ? html`<p class="lede">${zone.scope}</p>` : ""}
${note ? html`<p class="notice info">${note}</p>` : ""}
${zone.progress ? html`<section aria-labelledby="progress"><h2 id="progress">最新进展</h2>
<p>${progressParagraph(zone.progress.text, known)}</p>
${references.length ? html`<ol class="refs" aria-label="参考的原文">${references.map((ref) => html`<li id="ref-${ref.n}">${ref.title}（${ref.source}）${externalLink(ref.url, "原文")}</li>`)}</ol>` : ""}
${zone.progress.at ? html`<p class="meta">截至 ${timeTag(zone.progress.at)}（北京时间）。由 AI 依据上面的原文整理，请以原文为准。</p>` : ""}
</section>` : ""}
${keyUpdates.length ? html`<section aria-labelledby="key-updates"><h2 id="key-updates">重要更新</h2>
<ul class="list">${keyUpdates.map(row)}</ul></section>` : ""}
<section aria-labelledby="latest"><h2 id="latest">最近 30 天的动态</h2>
${items.length ? html`<ul class="list">${items.map(row)}</ul>
<p class="meta">${shown > items.length ? `共 ${shown} 条，这里列出最新的 ${items.length} 条。` : `共 ${items.length} 条。`}只列标题、导读和原文链接；${pathLink(topicZoneFeedPath(zone.id), "订阅这个专区")}可以收到新的动态。</p>`
    : html`<p class="muted">最近 30 天这个专区没有新的动态。</p>`}
</section>
<section class="cta"><h2>在 EviMed 里继续</h2>
<p>登录或注册后，可以关注这个专区、收到每日提醒，也可以拿这些原文开始自己的研究。</p>
<p><a class="button" href="${zone.slug ? `/app/frontier/zones/s/${encodeURIComponent(zone.slug)}` : appZonePath(zone.id)}">打开这个专区</a> <a href="/login">登录或注册</a></p></section>`,
  };
}

/**
 * The structured data of a zone's page: a `CollectionPage` that is also a `MedicalWebPage`, its breadcrumb, what it is about and the
 * items it lists. Only what the page shows.
 * @param {{ zone: import("./evidencePublicTopicReads.mjs").PublicTopicZone, items: any[], keywords: Array<{ label: string }>, publicUrl?: unknown,
 *   tags: Map<string, { kind: string | null, nameEn: string | null, meshUi: string | null }> }} model
 */
export function topicZoneJsonLd({ zone, items, keywords, publicUrl, tags }) {
  const absolute = (/** @type {string} */ path) => evidenceAbsoluteUrl(publicUrl, path) ?? path;
  const page = absolute(topicZonePath(zone.id));
  const site = absolute(evidencePublicPath("/"));
  /** @type {Array<Record<string, unknown>>} */
  const about = keywords.map((keyword) => {
    const tag = tags.get(keyword.label);
    if (tag?.kind === "disease") {
      return { "@type": "MedicalCondition", name: keyword.label, ...(tag.nameEn ? { alternateName: tag.nameEn } : {}),
        ...(tag.meshUi ? { code: { "@type": "MedicalCode", codeValue: tag.meshUi, codingSystem: "MeSH" } } : {}) };
    }
    if (tag?.kind === "drug" || tag?.kind === "drug-class") return { "@type": "Drug", name: keyword.label, ...(tag.nameEn ? { alternateName: tag.nameEn } : {}) };
    return { "@type": "Thing", name: keyword.label };
  });
  const crumbs = [{ name: EVIDENCE_SITE_NAME, url: site }, ...(zone.specialty ? [{ name: zone.specialty.label, url: null }] : []), ...(zone.group ? [{ name: zone.group, url: null }] : []), { name: zone.title, url: page }];
  const listed = items.filter((item) => item.url);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": ["CollectionPage", "MedicalWebPage"], "@id": `${page}#page`, url: page, name: zone.title, description: zone.scope || zone.title, inLanguage: "zh-CN",
        ...(zone.modified ? { dateModified: new Date(zone.modified).toISOString() } : {}),
        isPartOf: { "@type": "WebSite", name: EVIDENCE_SITE_NAME, url: site },
        publisher: { "@type": "Organization", name: EVIDENCE_SITE_NAME },
        about, breadcrumb: { "@id": `${page}#breadcrumb` }, mainEntity: { "@id": `${page}#items` },
      },
      { "@type": "BreadcrumbList", "@id": `${page}#breadcrumb`,
        itemListElement: crumbs.map((crumb, index) => ({ "@type": "ListItem", position: index + 1, name: crumb.name, ...(crumb.url ? { item: crumb.url } : {}) })) },
      { "@type": "ItemList", "@id": `${page}#items`, numberOfItems: listed.length,
        itemListElement: listed.map((item, index) => ({ "@type": "ListItem", position: index + 1, name: item.title, url: item.url })) },
    ],
  };
}

/**
 * The index's section of topic zones: specialty → group → zones, each a title linked to its page with the week's count.
 * @param {Array<{ specialty: { key: string, label: string }, groups: Array<{ label: string, zones: any[] }> }>} topics
 */
export function topicIndexSection(topics) {
  if (!topics.length) return html``;
  const zoneItem = (/** @type {any} */ zone) => html`<li class="tile">
<h4>${pathLink(topicZonePath(zone.id), zone.title)}${zone.lifecycle === "quiet" ? html` <span class="badge">近期较少更新</span>` : ""}</h4>
${zone.scope ? html`<p>${clip(zone.scope, 80)}</p>` : ""}
<p class="meta">${zone.week ? `近 7 天 ${zone.week} 条` : "近 7 天暂无新增"}${zone.modified ? html` · 更新于 ${timeTag(zone.modified)}` : ""}</p>
</li>`;
  return html`<section aria-labelledby="topics"><h2 id="topics">证据专区</h2>
<p class="muted">每个专区只讲一个主题，由 AI 依据公开原文整理最新进展，每条动态都链接到原文。</p>
${topics.map((entry) => html`<h3>${entry.specialty.label}</h3>
${entry.groups.map((group) => html`${group.label ? html`<p class="group"><strong>${group.label}</strong></p>` : ""}<ul class="grid">${group.zones.map(zoneItem)}</ul>`)}`)}
</section>`;
}

/** An instant as RFC 822 in Beijing time (`Thu, 29 Oct 2026 08:30:00 +0800`). @param {string | Date} value */
export function rfc822Beijing(value) {
  const date = new Date(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", weekday: "short", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year} ${parts.hour}:${parts.minute}:${parts.second} +0800`;
}

/** @param {string} value */
const xml = (value) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[/** @type {"&"} */ (character)]);

/**
 * A zone's feed: RSS 2.0, the last items, dates in Beijing time.
 * @param {{ zone: import("./evidencePublicTopicReads.mjs").PublicTopicZone, items: any[], generatedAt: Date, publicUrl?: unknown }} model
 */
export function topicZoneRss({ zone, items, generatedAt, publicUrl = null }) {
  const absolute = (/** @type {string} */ path) => evidenceAbsoluteUrl(publicUrl, path) ?? path;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>',
    `<title>${xml(`${zone.title} · ${EVIDENCE_SITE_NAME}`)}</title>`,
    `<link>${xml(absolute(topicZonePath(zone.id)))}</link>`,
    `<description>${xml(zone.scope || `${zone.title}的医学动态。`)}</description>`,
    "<language>zh-CN</language>",
    `<lastBuildDate>${rfc822Beijing(generatedAt)}</lastBuildDate>`,
    `<atom:link rel="self" type="application/rss+xml" href="${xml(absolute(topicZoneFeedPath(zone.id)))}"/>`,
  ];
  for (const item of items) {
    const link = safeHref(item.url);
    lines.push("<item>",
      `<title>${xml(item.title)}</title>`,
      ...(link ? [`<link>${xml(link)}</link>`] : []),
      `<guid isPermaLink="false">${xml(`evimed-item:${item.id}`)}</guid>`,
      ...(item.at ? [`<pubDate>${rfc822Beijing(item.at)}</pubDate>`] : []),
      `<description>${xml(`${item.guide ? `${item.guide}（来源：${item.source}）` : `来源：${item.source}`}`)}</description>`,
      "</item>");
  }
  lines.push("</channel></rss>");
  return `${lines.join("\n")}\n`;
}
