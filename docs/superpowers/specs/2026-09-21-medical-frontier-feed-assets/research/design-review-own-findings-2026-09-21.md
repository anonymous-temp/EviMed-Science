# Own findings (main controller), verified 2026-09-21

M1 major — robots scope. Plan 6.1 / 10.2.3 step 2: "查 robots … 每站限速" for every fetch. eutils.ncbi.nlm.nih.gov/robots.txt = "back-end server version - no robots! User-agent: * Disallow: /" and mp.weixin.qq.com/robots.txt = "Disallow: /" (allows only /$ /debug /qa /wiki /cgi-bin/loginpage …). Platform applies RobotsPolicy only in web-read mode (webRead.mjs), not API mode. Literal plan would refuse every PubMed call and every WeChat article. Fix: robots applies to page reads (html-list, feeds on web sites); documented APIs follow the provider's API terms (E-utilities usage guidelines, Crossref etiquette); WeChat article pages get an explicit, owner-authorised per-host exception recorded in the registry (`robots: "owner-authorised"`), audited, never a global bypass. Checked from production: 28 other key hosts have no blanket disallow (gov.cn, nmpa, cde, nhsa, nhc 404 robots).

M2 major — number check blind to Chinese numerals. 10.3.7 extracts only Arabic digits; 6.3 said "归一化中英文数字写法". "死亡风险降低三成" escapes. Fix: prompt requires Arabic numerals for every quantity; checker also extracts Chinese numeral quantities (closed vocabulary: 零一二两三四五六七八九十百千万亿半 + 成/倍/%/万/亿) and converts before matching; unconvertible → must match verbatim.

M3 major — WeChat link form. Complete links need chksm; long form without chksm → /mp/wappoc_appmsgcaptcha (measured dev + prod); short /s/<id> works from residential, US datacentre gets verification. Dedupe key must be biz:mid:idx, never the URL; display link must be the complete one.

M4 major — WeChat list route status. Admin-backend listing closed 2026-07-29/30 (we-mp-rss #439/#456, wechat-article-exporter #199/#200); WeRead /web/mp/articles deprecated (-2041), only /api/mp/cover (latest one) — per we-mp-rss docs/weread-mp.md; Sept issues report empty lists. Plan chose we-mp-rss (for licence) → no longer works for listing. Fix: chapter 11.

M5 minor — registry vs schema vocab. sources.egress CHECK ('direct','browser','edge','bridge') vs registry values direct/relay/browser/bridge/none. Fix: CHECK uses registry values ('direct','browser','relay','bridge'); loader skips 'none'.

M6 minor — Crossref window re-scan. 154 journals × 8 polls × 7-day window = 50 MB/day and ~1,230 requests/day for ~30 new works per poll. Fix: incremental from-index-date since last success minus 1 day; full 7-day sweep once a day.

M7 minor — canonical_url unique index turns a dedupe case into an insert error (EMA whats-new vs topic feeds share EPAR links, 99 cross-source identical links in the dry run). Fix: canonical url is a dedupe key (merge as mention), not a unique constraint that throws.

M8 major — heat/independence with WeChat. Media matrices (丁香园 ×N, 医学界 ×30) and reposts would count as independent sources and inflate heat. Fix: operator (账号主体) grouping in the registry; reposts (copyright_stat≠1 with a source line / msg_source_url) count toward their origin.
