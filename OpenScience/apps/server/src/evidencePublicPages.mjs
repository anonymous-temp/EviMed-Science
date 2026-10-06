// The public evidence pages as pure functions: a view model in, `{ title, description, body }` out (flywheel F08, 2026-10-06).
//
// Nothing here reads a database or a request. Every value a reader or an author wrote reaches the markup through `html` (which
// escapes it) and every address through `safeHref`/`pathLink`, so the escaping is the template's property and not each call's habit;
// `renderPage` (the layout) wraps what these return. The text is Simplified Chinese, plain and factual: what a thing is, who made it,
// when, and what was checked — no marketing, no ranking language.
//
// What a page shows of a card is exactly what `evidencePublicQuery.mjs` hands it: the claims with their marks and the quotations that
// stand under them, the sources as title and link, the disclosure, the currency label. A source's text is not in the model, so no
// page can print it.

import {
  EVIDENCE_AI_STEP_LABELS_ZH,
  EVIDENCE_CHANGE_CATEGORY_LABELS_ZH,
  EVIDENCE_CHANGE_TRIGGER_LABELS_ZH,
  SOURCE_CURRENCY_LABELS_ZH,
  VCR_VALUE_SOURCE_LABELS_ZH,
} from "@evimed/domain";
import { externalLink, html, pathLink, timeTag } from "./evidencePublicHtml.mjs";
import { EVIDENCE_ABOUT_SECTIONS } from "./evidencePublicAbout.mjs";
import { EVIDENCE_SITE_NAME, appCardPath, appZonePath, authorPath, cardPath, changesPath, zonePath } from "./evidencePublicLayout.mjs";
import { evidencePublicPath } from "./evidencePublicPaths.mjs";

const CLAIM_TYPE_LABELS = { direct: "直接引用", synthesized: "跨来源综合", derived: "分析者推算" };
const CLAIM_STATUS_LABELS = {
  verified: "引文在所标的来源里逐字找到了",
  quote_not_found: "引文在所标的来源里没有找到",
  source_unavailable: "来源的原文当前无法核对，这里只给出处",
  no_quote: "没有给出引文，无法核对",
  derived: "分析者自己的推算，没有引文可核对；它的方法和假设写在下面",
  unknown: "核验状态未知",
};
const COVERAGE_LABELS = { "full-text": "全文", abstract: "摘要", excerpt: "摘录" };
const ORIGINALITY_NOTE = { true: "一手", false: "解读" };
const FACT_BOX_REASON_LABELS = {
  no_comparisons: "这张卡没有可比较的结局。",
  outcome_role_missing: "作者没有写明结局是获益还是不良反应。",
  counts_missing: "事件数或分母缺失，算不出每 1000 人的数字。",
  events_exceed_denominator: "事件数大于分母，数据有误，没有计算。",
  not_per_people: "这个结局的单位是人年，不是人数，不放进事实框。",
  nothing_usable: "没有哪个结局能算出每 1000 人的数字。",
};
const ABSOLUTE_REASON_LABELS = { no_comparison: "没有比较", counts_missing: "事件数或分母缺失", events_exceed_denominator: "事件数大于分母" };
const SUMMARY_CHARS = 150;

/** @param {unknown} value @param {number} [max] */
const clip = (value, max = SUMMARY_CHARS) => {
  const characters = [...String(value ?? "").replace(/\s+/g, " ").trim()];
  return characters.length > max ? `${characters.slice(0, max).join("")}…` : characters.join("");
};
/** @param {number} count @param {string} noun */
const countOf = (count, noun) => `${count} ${noun}`;

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

/**
 * The producer line: who made it and how that bears on the product, the first thing on a zone and a card.
 * @param {{ kindLabel?: string | null, name: string, relationLabel?: string | null, products?: string[] } | null} producer @param {string} [fallbackName]
 */
export function producerLine(producer, fallbackName = "") {
  if (!producer) return html`<p class="producer"><strong>出品方：</strong>${fallbackName || "未写明"}</p>`;
  return html`<p class="producer"><strong>出品方：</strong>${producer.kindLabel ? html`${producer.kindLabel} ` : ""}${producer.name}。${producer.relationLabel ?? ""}${producer.products?.length ? html`（${producer.products.join("、")}）` : ""}</p>`;
}

/** An author's name, linked to the author's page by public handle; a name alone when no handle could be made. @param {{ id: string | null, name: string }} author */
const authorLink = (author) => (author.id ? pathLink(authorPath(author.id), author.name) : author.name);

/** @param {{ total: number, verified: number, warned: number, derived: number }} counts */
export function claimCountsText(counts) {
  if (!counts.total) return html`<span class="muted">没有列出结论</span>`;
  return html`<span class="mark-ok" title="引文逐字找到">✓ ${counts.verified}</span> <span class="mark-warn" title="没有找到引文或无法核对">⚠ ${counts.warned}</span>${counts.derived ? html` <span class="muted">推算 ${counts.derived}</span>` : ""}`;
}

/** @param {{ currency: string, currencyLabel?: string | null }} card */
function currencyBadge(card) {
  const tone = card.currency === "current" ? "ok" : card.currency === "no_longer_updated" ? "" : "warn";
  return html`<span class="badge ${tone}">${card.currencyLabel ?? "现行"}</span>`;
}

/** One card as a row of a list. @param {any} card @param {{ showZone?: boolean }} [options] */
function cardItem(card, { showZone = false } = {}) {
  return html`<li>
<h3>${pathLink(cardPath(card.id), card.title)}${card.aiGenerated ? html` <span class="badge ai">AI 生成</span>` : ""}${card.withdrawn ? html` <span class="badge danger">已撤回</span>` : ""}</h3>
${card.summary ? html`<p>${clip(card.summary, 200)}</p>` : ""}
<p class="meta">${card.producer ? html`${card.producer.kindLabel} ${card.producer.name} · ` : ""}${card.originalityLabel ?? ""}${showZone && card.zoneTitle ? html` · ${pathLink(zonePath(card.zoneId), card.zoneTitle)}` : ""}${card.withdrawn ? "" : html` · ${claimCountsText(card.claims)} · ${currencyBadge(card)}`} · 更新于 ${timeTag(card.updatedAt)}${card.lastCheckedAt ? html` · 最后核对 ${timeTag(card.lastCheckedAt)}` : ""}</p>
</li>`;
}

/** @param {string | null} cursor @param {string} base the path, with its own query when it has one */
function pager(cursor, base) {
  if (!cursor) return html``;
  return html`<p class="pager"><a href="${base}${base.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}" rel="next">更早的</a></p>`;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/**
 * @param {{ official: any[], product: any[], user: any[] }} sections
 */
export function indexPage(sections) {
  /** @param {string} id @param {string} title @param {string} note @param {any[]} zones @param {boolean} showProducer */
  const section = (id, title, note, zones, showProducer) => html`<section aria-labelledby="${id}">
<h2 id="${id}">${title}</h2>
<p class="muted">${note}</p>
${zones.length ? html`<ul class="grid">${zones.map((zone) => html`<li class="tile">
<h3>${pathLink(zonePath(zone.id), zone.title)}</h3>
${showProducer ? producerLine(zone.producer, zone.owner.name) : html`<p class="meta">出品：${zone.producer?.name ?? zone.owner.name}</p>`}
${zone.description ? html`<p>${clip(zone.description, 120)}</p>` : ""}
<p class="meta">${countOf(zone.cards, "张证据卡")} · ${countOf(zone.follows, "人关注")} · 更新于 ${timeTag(zone.lastCardAt ?? zone.updatedAt)}</p>
</li>`)}</ul>` : html`<p class="muted">这一栏现在没有公开的专区。</p>`}
</section>`;
  return {
    title: `${EVIDENCE_SITE_NAME}：官方专区、产品专区和用户专区`,
    description: "EviMed 证据中心公开的证据专区。官方专区、产品专区和用户专区分开列出，每张证据卡都写明出品方，每条结论都能追到来源原文。",
    body: html`<h1>${EVIDENCE_SITE_NAME}</h1>
<p class="lede">每张证据卡写明是谁出的、凭什么这样说，每条结论都标出它的引文有没有在来源里逐字找到（✓ 或 ⚠）。证据卡只是索引，请引用它列出的原始来源。排序只看更新日期、关注数和读者评分，没有付费字段。详见${pathLink(evidencePublicPath("/about"), "编辑说明")}。</p>
${section("official", "官方专区", "由平台出品。", sections.official, false)}
${section("product", "产品专区", "由企业或医生出品，讲的是他们自己的产品；每个专区写明出品方和与产品的关系。", sections.product, true)}
${section("user", "用户专区", "由研究者出品、署名发表，并选择公开到互联网。", sections.user, false)}`,
  };
}

// ---------------------------------------------------------------------------
// Zone
// ---------------------------------------------------------------------------

/**
 * @param {{ zone: any, cards: { items: any[], next: string | null } }} model
 */
export function zonePage({ zone, cards }) {
  const counts = zone.currencyCounts ?? {};
  const currency = Object.entries(SOURCE_CURRENCY_LABELS_ZH).filter(([key]) => counts[key]).map(([key, label]) => `${label} ${counts[key]}`);
  return {
    title: `${zone.title} · ${EVIDENCE_SITE_NAME}`,
    description: clip(zone.description || `${zone.kindLabel}“${zone.title}”的证据卡，每张写明出品方，每条结论标出引文核验的结果。`),
    body: html`${producerLine(zone.producer, zone.owner.name)}
<h1>${zone.title}</h1>
<p class="meta">${zone.kindLabel} · ${countOf(zone.cards, "张证据卡")}${zone.withdrawnCards ? `，另有 ${zone.withdrawnCards} 张已撤回` : ""} · ${countOf(zone.follows, "人关注")} · 作者 ${authorLink(zone.owner)}${zone.lastCheckedAt ? html` · 最后核对 ${timeTag(zone.lastCheckedAt)}` : ""}</p>
${zone.description ? html`<p>${zone.description}</p>` : ""}
${zone.background ? html`<details><summary>专区背景</summary><p>${zone.background}</p></details>` : ""}
${currency.length ? html`<p class="meta">时效：${currency.join(" · ")}</p>` : ""}
<p>${pathLink(changesPath(zone.id), "查看这个专区的变更记录")}（更正、更新和撤回都在里面）。</p>
<h2>证据卡</h2>
${cards.items.length ? html`<ul class="list">${cards.items.map((card) => cardItem(card))}</ul>${pager(cards.next, zonePath(zone.id))}` : html`<p class="muted">这个专区现在没有公开的证据卡。</p>`}
<section class="cta"><h2>继续研究</h2>
<p>在 EviMed 里，可以用这些证据卡所依据的原始来源开始自己的研究。登录或注册后即可开始。</p>
<p><a class="button" href="${appZonePath(zone.id)}">继续研究</a> <a href="/login">登录或注册</a></p></section>`,
  };
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/** The absolute effect of a summary-of-findings row. @param {any} effect */
function absoluteText(effect) {
  if (effect?.status !== "computed") return html`<span class="muted">算不出：${/** @type {any} */ (ABSOLUTE_REASON_LABELS)[effect?.reason] ?? "数据不足"}</span>`;
  const unit = effect.unit === "people" ? "人" : "人年";
  return html`每 ${effect.per} ${unit}：对照 ${effect.control}，干预 ${effect.intervention}（相差 ${effect.difference > 0 ? "+" : ""}${effect.difference}）`;
}

/** The clinical view: the summary-of-findings table. @param {any} view */
function clinicalView(view) {
  const rows = view.rows ?? [];
  return html`<section aria-labelledby="sof"><h2 id="sof">结果总结（临床版）</h2>
${view.population ? html`<p><strong>人群：</strong>${view.population}</p>` : ""}
${rows.length ? html`<div class="table-wrap"><table>
<thead><tr><th>结局</th><th>时间点</th><th>对照 → 干预</th><th>相对效应</th><th>绝对效应（每 1000 人）</th><th class="num">研究数 / 受试者数</th><th>证据确定性</th></tr></thead>
<tbody>${rows.map((/** @type {any} */ row) => html`<tr>
<td>${row.title ? html`${row.title}<br><span class="muted">${row.outcome}</span>` : row.outcome}${row.outcomeRole ? html` <span class="badge">${row.outcomeRole === "benefit" ? "获益" : "不良反应"}</span>` : ""}</td>
<td>${row.timeframe}</td>
<td>${row.comparator ?? "—"} → ${row.intervention ?? "—"}</td>
<td>${row.relativeEffect ?? "未写明"}</td>
<td>${absoluteText(row.absoluteEffect)}</td>
<td class="num">${row.studies ?? "—"} / ${row.participants ?? "—"}</td>
<td>${row.certainty ?? "未写明"}</td>
</tr>${row.note ? html`<tr><td colspan="7" class="muted">${row.note}</td></tr>` : ""}`)}</tbody></table></div>
<p class="muted">每 1000 人的数字由程序按事件数和分母算出，不是作者写的；作者写的相对效应和确定性原样列出。</p>` : html`<p class="muted">这张卡没有结构化的结局比较。</p>`}
</section>`;
}

/** @param {string} title @param {any[]} rows */
function factRows(title, rows) {
  if (!rows.length) return html``;
  return html`<h4>${title}</h4><div class="table-wrap"><table>
<thead><tr><th>结局</th><th>时间点</th><th class="num">${rows[0].control.label}</th><th class="num">${rows[0].intervention.label}</th><th class="num">相差</th></tr></thead>
<tbody>${rows.map((row) => html`<tr><td>${row.outcome}</td><td>${row.timeframe}</td><td class="num">${row.control.per1000}</td><td class="num">${row.intervention.per1000}</td><td class="num">${row.difference > 0 ? "+" : ""}${row.difference}</td></tr>`)}</tbody></table></div>`;
}

/** The public view: the authored panels and the fact box. @param {any} view */
function publicView(view) {
  const box = view.factBox;
  return html`<section aria-labelledby="panels"><h2 id="panels">公众版</h2>
${view.panels.filter((/** @type {any} */ panel) => panel.key !== "sourcesAndCheckDate").map((/** @type {any} */ panel) => {
    if (panel.key === "commonMisunderstandings") {
      return html`<h3>${panel.label}</h3>${panel.status === "written" ? html`<ul>${panel.items.map((/** @type {any} */ item) => html`<li><strong>${item.misunderstanding}</strong><br>${item.correction}${item.observedIn ? html`<br><span class="muted">观察到的地方：${item.observedIn}</span>` : ""}${item.traced ? "" : html` <span class="mark-warn" title="没有全部追到已核验的结论">⚠ 未全部追到已核验的结论</span>`}</li>`)}</ul>` : html`<p class="muted">作者没有填写这一栏。</p>`}`;
    }
    return html`<h3>${panel.label}</h3>${panel.status === "written" ? html`<p>${panel.text}${panel.traced ? html` <span class="mark-ok" title="这一栏所依据的结论都已核验">✓</span>` : html` <span class="mark-warn" title="没有全部追到已核验的结论">⚠ 未全部追到已核验的结论</span>`}</p>` : html`<p class="muted">作者没有填写这一栏。</p>`}`;
  })}
<div class="factbox"><h3>事实框：每 ${box.per} 人里</h3>
${box.status === "available" ? html`<p class="muted">和对照相比，每 ${box.per} 人里的人数；两组用同一个分母，数字由程序按事件数和分母算出。</p>${factRows("获益", box.benefits)}${factRows("不良反应", box.harms)}`
    : html`<p class="muted">这张卡没有事实框：${/** @type {any} */ (FACT_BOX_REASON_LABELS)[box.reason] ?? "数据不足。"}</p>`}
${box.excluded?.length && box.status === "available" ? html`<p class="muted">另有 ${box.excluded.length} 个结局没有放进事实框（没有写明获益或不良反应，或算不出每 1000 人的数字）。</p>` : ""}
</div></section>`;
}

/** The claims with their marks, quotations and sources. @param {any} card */
function basisSection(card) {
  return html`<section aria-labelledby="basis"><h2 id="basis">依据</h2>
<p class="muted">✓ 表示引文在它标明的来源里逐字找到了；⚠ 表示没有找到，或者来源的原文当前无法核对。</p>
${card.claimList.length ? card.claimList.map((/** @type {any} */ claim) => html`<div class="claim ${claim.mark === "✓" ? "verified" : claim.mark === "⚠" ? "unverified" : ""}" id="claim-${claim.claimId}">
<p>${claim.mark === "✓" ? html`<span class="mark-ok">✓</span> ` : claim.mark === "⚠" ? html`<span class="mark-warn">⚠</span> ` : ""}${claim.text} <span class="badge">${/** @type {any} */ (CLAIM_TYPE_LABELS)[claim.claimType] ?? claim.claimType}</span>${claim.confidence ? html` <span class="badge">把握度：${claim.confidence === "high" ? "高" : claim.confidence === "moderate" ? "中" : "低"}</span>` : ""}${claim.valueSource ? html` <span class="badge">数值来源：${/** @type {any} */ (VCR_VALUE_SOURCE_LABELS_ZH)[claim.valueSource] ?? claim.valueSource}</span>` : ""}</p>
<p class="meta">${/** @type {any} */ (CLAIM_STATUS_LABELS)[claim.status] ?? CLAIM_STATUS_LABELS.unknown}</p>
${claim.quotes.map((/** @type {any} */ entry) => html`${entry.quote ? html`<blockquote>${entry.quote}</blockquote>` : ""}${entry.source ? html`<p class="meta">来源 [${entry.source.index}] ${externalLink(entry.source.url, entry.source.title)}</p>` : ""}`)}
${claim.applicability ? html`<p class="meta">适用范围：${claim.applicability}</p>` : ""}${claim.uncertainty ? html`<p class="meta">不确定性：${claim.uncertainty}</p>` : ""}
${claim.claimType === "derived" ? html`${claim.method ? html`<p class="meta">方法：${claim.method}</p>` : ""}${claim.assumptions ? html`<p class="meta">假设：${claim.assumptions}</p>` : ""}${claim.sensitivity ? html`<p class="meta">敏感性：${claim.sensitivity}</p>` : ""}` : ""}
</div>`) : html`<p class="muted">这张卡没有列出结论。</p>`}
<h3>来源</h3>
${card.sources.length ? html`<ol>${card.sources.map((/** @type {any} */ source) => html`<li id="source-${source.index}">${externalLink(source.url, source.title)}<span class="muted">${source.coverage ? ` · ${/** @type {any} */ (COVERAGE_LABELS)[source.coverage] ?? source.coverage}` : ""}${source.checkedAt ? html` · 核对于 ${timeTag(source.checkedAt)}` : ""}${source.publicationStatus ? " · 来源有撤稿、更正或关注声明" : ""}</span></li>`)}</ol><p class="muted">这里只给出处和链接，不转载来源的原文。</p>` : html`<p class="muted">这张卡没有列出来源。</p>`}
</section>`;
}

/** @param {any} person */
const personText = (person) => [person.name, person.affiliation, person.title].filter(Boolean).join("，");

/** The disclosure block of plan §8. @param {any} card */
function disclosureSection(card) {
  const disclosure = card.disclosure ?? {};
  const steps = (disclosure.aiSteps ?? []).map((/** @type {string} */ step) => /** @type {any} */ (EVIDENCE_AI_STEP_LABELS_ZH)[step] ?? step);
  const unstated = html`<span class="muted">未披露</span>`;
  return html`<section aria-labelledby="disclosure"><h2 id="disclosure">披露</h2>
<dl class="facts">
<dt>出品方</dt><dd>${card.producer ? html`${card.producer.kindLabel} ${card.producer.name}。${card.producer.relationLabel}${card.producer.products?.length ? html`（${card.producer.products.join("、")}）` : ""}` : unstated}</dd>
<dt>性质</dt><dd>${card.originalityLabel ?? unstated}（${/** @type {any} */ (ORIGINALITY_NOTE)[String(card.primary)]}）</dd>
<dt>AI 参与</dt><dd>${card.aiGenerated ? html`<span class="badge ai">AI 生成</span> 这张卡有 AI 参与写作。` : "没有披露 AI 参与写作。"}</dd>
<dt>AI 模型和版本</dt><dd>${disclosure.model ? html`${disclosure.model}${disclosure.modelVersion ? ` ${disclosure.modelVersion}` : ""}` : unstated}</dd>
<dt>AI 做了哪几步</dt><dd>${steps.length ? steps.join("、") : unstated}</dd>
<dt>生成日期</dt><dd>${disclosure.generatedAt ? timeTag(disclosure.generatedAt) : unstated}</dd>
<dt>最后核对日期</dt><dd>${card.lastCheckedAt ? timeTag(card.lastCheckedAt) : disclosure.lastCheckedAt ? timeTag(disclosure.lastCheckedAt) : unstated}</dd>
<dt>作者</dt><dd>${disclosure.authors?.length ? disclosure.authors.map(personText).join("；") : unstated}</dd>
<dt>审核人</dt><dd>${disclosure.reviewers?.length ? disclosure.reviewers.map(personText).join("；") : unstated}</dd>
${disclosure.reportingStandard ? html`<dt>报告规范</dt><dd>${disclosure.reportingStandard}</dd>` : ""}
<dt>时效</dt><dd>${currencyBadge(card)}${card.hasPendingEvidence ? html` 平台发现了 ${card.pendingItems} 项可能相关的新研究，尚未纳入这张卡。` : ""}</dd>
</dl></section>`;
}

/** @param {any} links */
function lineageSection(links) {
  /** @param {any} ref */
  const one = (ref) => html`${pathLink(cardPath(ref.id), ref.title)}<span class="muted">（${ref.producer?.name ?? ref.creator}）</span>`;
  const rows = [
    links.previous ? html`<li>上一版本：${one(links.previous)}</li>` : "",
    ...links.next.map((/** @type {any} */ ref) => html`<li>后续版本：${one(ref)}</li>`),
    links.origin ? html`<li>研究源自：${one(links.origin)}</li>` : "",
    ...links.research.map((/** @type {any} */ ref) => html`<li>由这张卡发起的研究：${one(ref)}</li>`),
  ].filter(Boolean);
  if (!rows.length) return html``;
  return html`<section aria-labelledby="lineage"><h2 id="lineage">版本与来龙去脉</h2><ul>${rows}</ul></section>`;
}

/**
 * A card that is in force.
 * @param {{ card: any, links: any, view: "clinical" | "public" }} model
 */
export function cardPage({ card, links, view }) {
  const other = view === "public" ? "clinical" : "public";
  const description = view === "public" && card.viewContent?.panels?.[0]?.text ? card.viewContent.panels[0].text : card.summary || card.title;
  return {
    title: `${card.title} · ${EVIDENCE_SITE_NAME}`,
    description: clip(description),
    body: html`${producerLine(card.producer, card.creator.name)}
<h1>${card.title}${card.aiGenerated ? html` <span class="badge ai">AI 生成</span>` : ""}</h1>
<p class="meta">${card.originalityLabel ?? ""} · ${pathLink(zonePath(card.zone.id), card.zone.title)} · 作者 ${authorLink(card.creator)} · 第 ${card.revision} 版，更新于 ${timeTag(card.updatedAt)} · ${claimCountsText(card.claims)} · ${currencyBadge(card)}</p>
${card.hasPendingEvidence ? html`<p class="notice warn">平台发现了 ${card.pendingItems} 项可能影响这张卡的新研究，尚未纳入。读到的结论可能不是最新的。</p>` : ""}
${card.currency === "source_changed" ? html`<p class="notice warn">这张卡引用的来源出现了撤稿、更正或关注声明，依据这些来源的结论待复核。</p>` : ""}
<p class="muted">证据卡是 EviMed 对来源的整理，只是索引：需要引用时，请引用下面列出的原始来源，不要引用这张卡。</p>
<p>${view === "public" ? "公众版" : "临床版"} · 切换到 ${pathLink(`${cardPath(card.id)}?view=${other}`, other === "public" ? "公众版" : "临床版")}</p>
${card.summary ? html`<p class="lede">${card.summary}</p>` : ""}
${card.content?.question ? html`<p><strong>问题：</strong>${card.content.question}</p>` : ""}${card.content?.answer ? html`<p><strong>回答：</strong>${card.content.answer}</p>` : ""}
${view === "public" ? publicView(card.viewContent) : clinicalView(card.viewContent)}
${basisSection(card)}
${disclosureSection(card)}
${lineageSection(links)}
<p>${pathLink(changesPath(card.zone.id), "这个专区的变更记录")}</p>
<section class="cta"><h2>继续研究</h2>
<p>在 EviMed 里，可以用这张卡所依据的原始来源开始自己的研究，问题已经替你填好。登录或注册后即可开始。</p>
<p><a class="button" href="${appCardPath(card.zone.id, card.id)}">用这张卡继续研究</a> <a href="/login">登录或注册</a></p></section>`,
  };
}

/**
 * A card that was taken back keeps its page: why, when, and where the log records it.
 * @param {{ card: any }} model
 */
export function withdrawnCardPage({ card }) {
  const withdrawn = card.withdrawn;
  const entry = withdrawn.changeLogId ? `${changesPath(card.zoneId)}?before=${Number(withdrawn.changeLogId) + 1}#log-${encodeURIComponent(withdrawn.changeLogId)}` : null;
  return {
    title: `已撤回：${card.title} · ${EVIDENCE_SITE_NAME}`,
    description: `这张证据卡已被撤回，不再作为证据。${clip(withdrawn.reason, 100)}`,
    body: html`${producerLine(card.producer, card.creator.name)}
<h1>${card.title} <span class="badge danger">已撤回</span></h1>
<p class="notice danger">这张证据卡已于 ${withdrawn.at ? timeTag(withdrawn.at) : "（日期未记录）"}撤回，不再作为证据。它原来的结论不再列出。</p>
<dl class="facts">
<dt>撤回原因</dt><dd>${withdrawn.reason || "没有写明"}</dd>
<dt>撤回日期</dt><dd>${withdrawn.at ? timeTag(withdrawn.at) : "没有记录"}</dd>
<dt>变更记录</dt><dd>${entry ? pathLink(entry, "查看记录这次撤回的条目") : html`${pathLink(changesPath(card.zoneId), "专区的变更记录")}`}</dd>
<dt>所在专区</dt><dd>${pathLink(zonePath(card.zoneId), card.zoneTitle ?? "专区")}</dd>
<dt>最后更新</dt><dd>${timeTag(card.updatedAt)}</dd>
</dl>
<p class="muted">撤回的卡片保留这一页，是为了让引用过它的人能看到发生了什么。</p>`,
  };
}

// ---------------------------------------------------------------------------
// Change log
// ---------------------------------------------------------------------------

/**
 * @param {{ zone: any, items: any[], nextBefore: string | null }} model
 */
export function changesPage({ zone, items, nextBefore }) {
  return {
    title: `变更记录：${zone.title} · ${EVIDENCE_SITE_NAME}`,
    description: `${zone.title}的变更记录：更正、更新和撤回，每条写明日期、改了什么、为什么改、由什么触发。`,
    body: html`${producerLine(zone.producer, zone.owner.name)}
<h1>变更记录：${pathLink(zonePath(zone.id), zone.title)}</h1>
<p class="muted">更正、更新和撤回都记在这里：日期、改了什么、为什么改、由什么触发。每条说明由程序按事实写成。记录只追加，发布后不能改。</p>
${items.length ? html`<div class="table-wrap"><table>
<thead><tr><th>日期</th><th>类别</th><th>说明</th><th>触发</th><th>卡片</th></tr></thead>
<tbody>${items.map((entry) => html`<tr id="log-${entry.id}">
<td>${timeTag(entry.occurredAt)}</td>
<td>${entry.categoryLabel ?? /** @type {any} */ (EVIDENCE_CHANGE_CATEGORY_LABELS_ZH)[entry.category] ?? entry.category}</td>
<td>${entry.summary}</td>
<td>${entry.triggerLabel ?? /** @type {any} */ (EVIDENCE_CHANGE_TRIGGER_LABELS_ZH)[entry.trigger] ?? entry.trigger}</td>
<td>${entry.cardTitle ? pathLink(cardPath(entry.cardId), entry.cardTitle) : ""}</td>
</tr>`)}</tbody></table></div>` : html`<p class="muted">这个专区还没有变更记录。</p>`}
${nextBefore ? html`<p class="pager"><a href="${changesPath(zone.id)}?before=${encodeURIComponent(nextBefore)}" rel="next">更早的记录</a></p>` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Author
// ---------------------------------------------------------------------------

/** @param {any} data */
export function authorPage(data) {
  const { author, producer, people, zones, cards, totals, changes } = data;
  return {
    title: `${author.name} · ${EVIDENCE_SITE_NAME}`,
    description: `${author.name}公开的证据专区和证据卡，以及关注数、被研究引用的次数和变更记录。`,
    body: html`<h1>${author.name}</h1>
${producer ? producerLine(producer) : ""}
${people.length ? html`<p class="meta">卡片里署名的作者和审核人：${people.map((/** @type {any} */ person) => personText(person)).join("；")}</p>` : ""}
<dl class="facts">
<dt>公开的证据卡</dt><dd>${totals.cards}</dd>
<dt>关注者</dt><dd>${totals.followers}</dd>
<dt>被研究引用</dt><dd>${totals.runsFromCards} 次<span class="muted">（别人的研究从这位作者的卡片出发的次数，不含作者自己的）</span></dd>
</dl>
<h2>专区</h2>
<ul class="list">${zones.map((/** @type {any} */ zone) => html`<li><h3>${pathLink(zonePath(zone.id), zone.title)}</h3>${zone.description ? html`<p>${clip(zone.description, 120)}</p>` : ""}<p class="meta">${zone.kindLabel} · ${countOf(zone.cards, "张证据卡")} · ${countOf(zone.follows, "人关注")} · 更新于 ${timeTag(zone.updatedAt)}</p></li>`)}</ul>
<h2>最近的证据卡</h2>
${cards.length ? html`<ul class="list">${cards.map((/** @type {any} */ card) => cardItem(card))}</ul>` : html`<p class="muted">没有公开的证据卡。</p>`}
<h2>最近的变更记录</h2>
${changes.length ? html`<ul>${changes.map((/** @type {any} */ entry) => html`<li>${timeTag(entry.occurredAt)} ${entry.summary}${entry.cardTitle ? html` <span class="muted">（${pathLink(changesPath(entry.zoneId), "查看记录")}）</span>` : ""}</li>`)}</ul>` : html`<p class="muted">还没有变更记录。</p>`}`,
  };
}

// ---------------------------------------------------------------------------
// About, metrics, simulations, requests
// ---------------------------------------------------------------------------

export function aboutPage() {
  return {
    title: `编辑说明 · ${EVIDENCE_SITE_NAME}`,
    description: "EviMed 证据中心的编辑说明：五条原则、三类专区、平台自己发布的标准，以及更正、质疑和撤回是怎么做的。",
    body: html`<h1>编辑说明</h1>
${EVIDENCE_ABOUT_SECTIONS.map((section) => html`<section aria-labelledby="${section.id}"><h2 id="${section.id}">${section.title}</h2>${section.blocks.map((block) => {
    if (block.type === "p") return html`<p>${block.text}</p>`;
    const items = block.items.map((item) => html`<li>${item}</li>`);
    return block.type === "ol" ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`;
  })}</section>`)}
<p class="muted">按月公开的数在${pathLink(evidencePublicPath("/metrics"), "这一页")}，选题申请在${pathLink(evidencePublicPath("/requests"), "这一页")}。</p>`,
  };
}

/** @param {number | null} hours */
function hoursText(hours) {
  if (hours === null || hours === undefined) return "没有可计时的纠错";
  return hours >= 48 ? `${Math.round((hours / 24) * 10) / 10} 天` : `${hours} 小时`;
}

/**
 * @param {{ months: { month: string, data: boolean, figures: any }[] }} model
 */
export function metricsPage({ months }) {
  return {
    title: `按月公开的数 · ${EVIDENCE_SITE_NAME}`,
    description: "EviMed 证据中心每月公开的三个数：核验通过率、纠错的中位时效、质疑数及其结果。",
    body: html`<h1>按月公开的数</h1>
<p class="muted">三个数都是从数据表里重新算出来的，不是另外记下的总数。月份按北京时间的日历月算。没有数据的月份写明没有数据，不写 0。</p>
<ul>
<li><strong>核验通过率</strong>：当月末仍然公开的证据卡里，所有结论中引文在来源里逐字找到的占比。</li>
<li><strong>纠错中位时效</strong>：从来源变更（或读者提出质疑）到卡片更新的时间的中位数，只算由这两类信号引起的更正和撤回。</li>
<li><strong>质疑</strong>：读者当月提出的质疑数，和它们现在的结果：维持、修正、撤回、处理中。</li>
</ul>
${months.length ? html`<div class="table-wrap"><table>
<thead><tr><th>月份</th><th>核验通过率</th><th>纠错中位时效</th><th>质疑和结果</th></tr></thead>
<tbody>${months.map(({ month, data, figures }) => data ? html`<tr>
<td>${month}</td>
<td>${figures.verification.passRate === null ? "这个月没有已列出的结论" : html`${Math.round(figures.verification.passRate * 1000) / 10}%<br><span class="muted">${figures.verification.verified} / ${figures.verification.claims} 条结论，${figures.verification.cards} 张卡</span>`}</td>
<td>${hoursText(figures.corrections.medianLatencyHours)}<br><span class="muted">${figures.corrections.entries} 条更正或撤回记录</span></td>
<td>${figures.challenges.filed ? html`提出 ${figures.challenges.filed}：维持 ${figures.challenges.upheld}，修正 ${figures.challenges.amended}，撤回 ${figures.challenges.withdrawn}，处理中 ${figures.challenges.open}${figures.challenges.upheldShare === null ? "" : html`<br><span class="muted">已判定的里维持的占 ${Math.round(figures.challenges.upheldShare * 1000) / 10}%</span>`}` : "这个月没有质疑"}</td>
</tr>` : html`<tr><td>${month}</td><td colspan="3" class="muted">这个月没有数据。</td></tr>`)}</tbody></table></div>` : html`<p class="muted">还没有可以公开的数据。</p>`}`,
  };
}

/** The fixed statement the simulated column opens with. */
export const SIMULATION_BANNER = "模拟研究的结果是模拟，不是证据。它们来自模型和假设，不能用来回答临床问题，也不会进入任何证据卡。";

/**
 * @param {{ reader: boolean, items: any[], next: string | null }} model
 */
export function simulationsPage({ reader, items, next }) {
  return {
    title: `模拟研究 · ${EVIDENCE_SITE_NAME}`,
    description: "EviMed 的“模拟研究”栏目：虚拟临研的模拟结果。模拟的结果不是证据。",
    body: html`<h1>模拟研究</h1>
<p class="notice warn">${SIMULATION_BANNER}</p>
${!reader || !items.length ? html`<p class="muted">这个栏目现在没有公开的模拟研究。</p>` : html`<ul class="list">${items.map((item) => html`<li><h3>${pathLink(evidencePublicPath(`/simulations/${encodeURIComponent(item.id)}`), item.title)}</h3>${item.summary ? html`<p>${clip(item.summary, 200)}</p>` : ""}${item.publishedAt ?? item.createdAt ? html`<p class="meta">${item.producer?.name ? html`${item.producer.name} · ` : ""}${timeTag(item.publishedAt ?? item.createdAt)}</p>` : ""}</li>`)}</ul>${pager(next, evidencePublicPath("/simulations"))}`}`,
  };
}

/**
 * One published simulation. The record is what 虚拟临研 stored when its study lead published a report (`vcrPublications.mjs`):
 * sections, each with its text and its numbers, every number carrying the value-source label it had in the study; the
 * intended use and the limitations from the report's cover; the engine receipts. A flat `numbers` list is read too.
 * @param {any} record
 */
export function simulationPage(record) {
  const rows = (/** @type {any[]} */ values) => html`<div class="table-wrap"><table>
<thead><tr><th>项目</th><th class="num">数值</th><th>数值来源</th></tr></thead>
<tbody>${values.map((/** @type {any} */ entry) => html`<tr><td>${entry.label}</td><td class="num">${entry.value}${entry.unit ? ` ${entry.unit}` : ""}</td><td>${/** @type {any} */ (VCR_VALUE_SOURCE_LABELS_ZH)[entry.valueSource] ?? "来源未标注"}</td></tr>`)}</tbody></table></div>`;
  const numbers = Array.isArray(record.numbers) ? record.numbers : [];
  const sections = Array.isArray(record.sections) ? record.sections : [];
  const limitations = Array.isArray(record.limitations) ? record.limitations.map(String).filter(Boolean) : record.limitations ? [String(record.limitations)] : [];
  const receipts = Array.isArray(record.receipts) ? record.receipts : [];
  const published = record.publishedAt ?? record.createdAt ?? null;
  return {
    title: `${record.title} · 模拟研究 · ${EVIDENCE_SITE_NAME}`,
    description: clip(record.summary || `${record.title}：一项模拟研究。模拟的结果不是证据。`),
    body: html`<p class="notice warn">${SIMULATION_BANNER}</p>
<h1>${record.title}</h1>
${published || record.producer?.name ? html`<p class="meta">${record.producer?.name ? html`${record.producer.name} · ` : ""}${published ? timeTag(published) : ""}</p>` : ""}
${record.summary ? html`<p class="lede">${record.summary}</p>` : ""}
${record.intendedUse ? html`<h2>用途</h2><p>${record.intendedUse}</p>` : ""}
${sections.map((/** @type {any} */ section) => html`${section.heading ? html`<h2>${section.heading}</h2>` : ""}${section.text ? html`<p>${section.text}</p>` : ""}${Array.isArray(section.values) && section.values.length ? rows(section.values) : ""}`)}
${numbers.length ? html`<h2>数字和它们的来源</h2>${rows(numbers)}` : ""}
${Array.isArray(record.assumptions) && record.assumptions.length ? html`<h2>假设</h2><ul>${record.assumptions.map((/** @type {string} */ item) => html`<li>${item}</li>`)}</ul>` : ""}
${limitations.length ? html`<h2>局限</h2><ul>${limitations.map((/** @type {string} */ item) => html`<li>${item}</li>`)}</ul>` : ""}
${receipts.length ? html`<h2>计算回执</h2><p class="muted">这些数字由统计引擎计算，回执编号：${receipts.map((/** @type {any} */ receipt) => String(typeof receipt === "string" ? receipt : receipt?.id ?? "")).filter(Boolean).join("、")}</p>` : ""}
<p>${pathLink(evidencePublicPath("/simulations"), "返回模拟研究")}</p>`,
  };
}

/** @param {{ items: any[] }} model */
export function requestsPage({ items }) {
  return {
    title: `选题申请 · ${EVIDENCE_SITE_NAME}`,
    description: "任何人都可以申请官方专区的选题，按申请人数排序，谁申请都一样。",
    body: html`<h1>选题申请</h1>
<p class="lede">任何人都可以申请官方专区的选题。这里按申请人数排序，谁申请都一样；同一个账号对同一个选题只算一票。</p>
<p class="muted">申请和附议需要登录 EviMed 账号：${pathLink("/login", "登录或注册")}。这里列的是读者写的话，平台没有审核过，也不收录进搜索引擎。</p>
${items.length ? html`<ol class="list">${items.map((item) => html`<li><h3>${item.title}</h3><p class="meta">${item.requesters} 人申请${item.zoneId ? html` · 指向专区：${pathLink(zonePath(item.zoneId), item.zoneTitle)}` : ""} · ${timeTag(item.createdAt)}</p></li>`)}</ol>` : html`<p class="muted">现在没有人申请选题。</p>`}`,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function notFoundPage() {
  return {
    title: `没有找到这一页 · ${EVIDENCE_SITE_NAME}`,
    description: "没有找到这个公开页面。",
    body: html`<h1>没有找到这一页</h1><p>这个地址没有公开的内容。它可能不存在，或者作者没有把它公开到互联网。</p><p>${pathLink(evidencePublicPath("/"), "回到证据专区")}</p>`,
  };
}

/** @param {number} seconds */
export function rateLimitedPage(seconds) {
  return {
    title: `访问太频繁 · ${EVIDENCE_SITE_NAME}`,
    description: "访问太频繁，请稍后再试。",
    body: html`<h1>访问太频繁</h1><p>请等 ${seconds} 秒后再试。</p>`,
  };
}
