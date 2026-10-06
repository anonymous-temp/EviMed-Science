// The frame every public evidence page shares: head (title, description, canonical address, robots, the AI-content metadata), the
// header's navigation and the footer, plus the paths the pages link to one another by (flywheel F08, 2026-10-06).
//
// Hidden knowledge:
//
// - **The head says what the deployment decided.** `noindex` is written both here (`<meta name="robots">`) and, by the router, as the
//   `X-Robots-Tag` header, because a crawler that reads only one of them must still be told. When a page is indexable neither is
//   written (the default is to index) — there is no "index" tag to forget to remove.
// - **No structured markup for machines that read answers** (plan §2.3, ruling 6): no JSON-LD, no microdata and no llms file. The only
//   machine-readable additions are the two the plan keeps: the canonical address and the AI-generated-content metadata.
// - **The AI label has two parts** (《人工智能生成合成内容标识办法》, in force 2025-09-01, and the national standard it points to,
//   GB 45438-2025《网络安全技术 人工智能生成合成内容标识方法》). The explicit part is a visible 「AI 生成」 mark on the card, which the
//   card page draws. The implicit part is metadata: the standard's implicit label is a JSON object under the key `AIGC` whose fields
//   are `Label` (the generated-content attribute; "1" is content generated or synthesized by AI), `ContentProducer` (the generating
//   service provider's name or code), `ProduceID` (that provider's identifier of the content), `ContentPropagator` (the propagating
//   service provider's name or code), `PropagateID` (that provider's identifier of the content) and the two reserved fields
//   `ReserveCode1` and `ReserveCode2`. Those field names and the meaning of `Label: "1"` were checked against published summaries of the
//   standard on 2026-10-06; the primary text of GB 45438-2025 was not open to this build, so its clause numbers are not cited here and
//   the other `Label` values are not used. The standard defines the file formats it covers, not an HTML page, so the object is carried
//   in `<meta name="AIGC" content='{...}'>`, which is this build's choice of carrier and is said so here rather than assumed.

import { html, pathLink, raw } from "./evidencePublicHtml.mjs";
import { evidenceAbsoluteUrl } from "./evidencePublicIndexing.mjs";
import { EVIDENCE_PUBLIC_STYLESHEET_PATH } from "./evidencePublicStyle.mjs";

export const EVIDENCE_SITE_NAME = "EviMed 证据中心";

export const zonePath = (/** @type {string} */ id) => `/evidence/z/${encodeURIComponent(id)}`;
export const changesPath = (/** @type {string} */ id) => `/evidence/z/${encodeURIComponent(id)}/changes`;
export const cardPath = (/** @type {string} */ id) => `/evidence/c/${encodeURIComponent(id)}`;
export const authorPath = (/** @type {string} */ id) => `/evidence/a/${encodeURIComponent(id)}`;
/** Where an anonymous visitor goes to continue from a card: the in-app reading page, which leads to the sign-in and sign-up page. */
export const appCardPath = (/** @type {string} */ zoneId, /** @type {string} */ cardId) => `/app/frontier/zones/${encodeURIComponent(zoneId)}/evidence/${encodeURIComponent(cardId)}`;
export const appZonePath = (/** @type {string} */ zoneId) => `/app/frontier/zones/${encodeURIComponent(zoneId)}`;

const NAV = [
  ["zones", "/evidence/", "证据专区"],
  ["requests", "/evidence/requests", "选题申请"],
  ["simulations", "/evidence/simulations", "模拟研究"],
  ["metrics", "/evidence/metrics", "按月公开的数"],
  ["about", "/evidence/about", "编辑说明"],
];

/**
 * The implicit AI-generated-content label for a card an AI wrote, as the `<meta name="AIGC">` carries it.
 * @param {{ producerName: string, produceId: string, propagateId: string }} fields
 */
export function aigcMetadata({ producerName, produceId, propagateId }) {
  return JSON.stringify({
    Label: "1", ContentProducer: producerName, ProduceID: produceId, ReserveCode1: "", ContentPropagator: EVIDENCE_SITE_NAME, PropagateID: propagateId, ReserveCode2: "",
  });
}

/**
 * A full page.
 * @param {{ title: string, description: string, path: string, noindex: boolean, active?: string, body: any, wide?: boolean, aigc?: string | null,
 *   publicUrl?: unknown, alternates?: boolean }} page
 * @returns {string}
 */
export function renderPage({ title, description, path, noindex, active = "", body, wide = false, aigc = null, publicUrl = null, alternates = false }) {
  const canonical = evidenceAbsoluteUrl(publicUrl, path.split("?")[0]);
  const feedLinks = alternates
    ? html`<link rel="alternate" type="application/rss+xml" title="${EVIDENCE_SITE_NAME}" href="/evidence/feed.xml"><link rel="alternate" type="application/json" title="${EVIDENCE_SITE_NAME}（JSON）" href="/evidence/feed.json">`
    : "";
  return `<!doctype html>\n${html`<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
${noindex ? raw('<meta name="robots" content="noindex">') : ""}
${canonical ? html`<link rel="canonical" href="${canonical}">` : ""}
${aigc ? html`<meta name="AIGC" content="${aigc}">` : ""}
${feedLinks}
<link rel="stylesheet" href="${EVIDENCE_PUBLIC_STYLESHEET_PATH}">
</head>
<body>
<header class="site-header"><div class="inner">
<a class="brand" href="/evidence/">${EVIDENCE_SITE_NAME}</a>
<nav aria-label="站内导航">${NAV.map(([key, href, label]) => html`<a href="${href}"${key === active ? raw(' aria-current="page"') : ""}>${label}</a>`)}</nav>
</div></header>
<main${wide ? "" : raw(' class="read"')}>
${body}
</main>
<footer class="site-footer"><div class="inner">
<p>证据卡是 EviMed 对来源的整理，只是索引，请引用它列出的原始来源。${pathLink("/evidence/about", "编辑说明")} · <a href="/evidence/feed.xml">订阅</a> · <a href="/login">登录或注册</a></p>
</div></footer>
</body>
</html>
`}`;
}
