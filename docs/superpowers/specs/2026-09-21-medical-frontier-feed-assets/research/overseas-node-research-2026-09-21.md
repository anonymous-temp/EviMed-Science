# Overseas crawl node for a Beijing-hosted medical SaaS — research, 2026-09-21

Job: ~120 public endpoints, <5,000 req/day, <2 GB/day, 7-day spool, a little headless Chromium, push JSON to Beijing on 443. Every figure was read from the vendor's own page **today**; `UNVERIFIED` = no primary page confirmed it.

## 1. Candidates — spec, traffic, price

| Provider / region | Plan | Spec | Traffic | Price/mo |
|---|---|---|---|---|
| **Tencent Lighthouse** overseas (SG/Tokyo/Seoul/Frankfurt/Jakarta/Silicon Valley/Virginia) | 入门型 | 2C/4G/60 GB, 30 Mbps | 1,536 GB | **¥42** (70 GB/2,048 GB = ¥54) |
| **Tencent Lighthouse 中国香港** | 入门型 | 2C/4G/70 GB | 2,048 GB | ¥90 |
| **AWS Lightsail** (Tokyo, SG, Oregon, HK) | — | 2 vCPU/2 GB/60 GB · 4 GB/80 GB | 3 TB · 4 TB | $12 · $24 |
| **Vultr** (Tokyo, Osaka, SG, LA, Seoul) | vc2-2c-4gb | 2 vCPU/4 GB/80 GB | 3 TB | **$20** (vhp, 5 TB = $24) |
| **DigitalOcean** (SGP1 only in Asia) | Basic | 2 vCPU/2 GB/60 GB | 3 TB | $18 |
| **Hetzner** CPX22 | shared AMD | 2 vCPU/4 GB/80 GB | 20 TB EU / 1 TB SIN | **€19.49 EU, €26.49 SIN** +€0.50 IPv4 |
| **BandwagonHost** 80G KVM (LA/HK/JP) | — | 4 GB/80 GB | 3 TB | $19.99 |
| **Oracle Always Free** | Ampere A1 | 2 OCPU/12 GB continuous, 200 GB | 10 TB egress | $0 |

Sources: cloud.tencent.com/document/product/1207/73452 (overage ¥0.8/GB SG-Tokyo-Seoul-Frankfurt-Jakarta, ¥0.5 Silicon Valley/Virginia, ¥1.0 HK; the 88%/85% duration discounts apply **only to 2C/8G and above** overseas) · aws.amazon.com/lightsail/pricing/ (HK/Jakarta/Malaysia/Mumbai/Sydney/São Paulo get **half** the transfer) · api.vultr.com/v2/plans — `www.vultr.com` returns **403** to a scripted fetch, so Vultr's own API is the source · www.digitalocean.com/pricing/droplets (no 2 vCPU/4 GB row → **UNVERIFIED**) · docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ — Hetzner raised prices **15 June 2026**, CPX22 €7.99→€19.49; SIN overage $8.49/TB; the cheap CX23 (€5.49) reads "currently not available" · Oracle home region is fixed and "out of host capacity" is common. **Alibaba SAS** sells in 中国香港/新加坡/东京/硅谷 from the China site but prices live only on the logged-in console — "具体价格以产品购买页显示为准" → **UNVERIFIED**; published overage ¥0.8/GB, ¥1 HK, **¥0.53 Singapore**.

**Payment.** **Vultr still takes Alipay** — "PayPal, Alipay, and UnionPay" plus cards (docs.vultr.com/support/platform/billing/what-payment-methods-do-you-accept); WeChat Pay only in a 2018 blog post → UNVERIFIED. **DigitalOcean**: UnionPay and **Alipay** ($0 auth). **AWS Global** takes **CNY** via China bank redirect and UnionPay *credit* card after ID verification — but **AWS China is a separate partition**; a China account cannot create Tokyo/Singapore/Oregon resources (amazonaws.cn/en/about-aws/china/). **Tencent**: one mainland account buys overseas regions, "无需分别申请中国站账号和国际站账号"; **no 备案** overseas; 实名认证 required; 企业认证 only for 专票. **Alibaba**: aliyun.com (CNY + fapiao) and alibabacloud.com (USD) are separate account systems. **Hetzner**: UnionPay manual, SEPA EUR only, new accounts need an ID copy or advance card payment. **Oracle** needs a non-prepaid card. **BandwagonHost** documents only card + PayPal — Alipay **UNVERIFIED**.

## 2. IP / ASN reputation — thinner evidence than expected

All the ASNs in the question were confirmed today via RIPEstat `as-overview` (AS132203 `TENCENT-NET-AP-CN`, AS45102 `ALIBABA-CN-NET`, AS16509 `AMAZON-02`, AS20473 `AS-VULTR`, AS14061 `DIGITALOCEAN-ASN`, AS24940 + AS213230 `HETZNER`, AS31898 `ORACLE-BMC`); BandwagonHost is AS25820 `IT7NET`, though the BWH↔IT7 ownership link is **UNVERIFIED**.

**Cloudflare nowhere states hosting or Chinese ASNs score lower.** Its bot-score page lists inputs as "headers, session characteristics, and browser signals", no ASN mention (developers.cloudflare.com/bots/concepts/bot-score/); ASN appears only as the customer rule field `ip.src.asnum` and in verified-bot validation. **Akamai's detection docs are login-gated → UNVERIFIED**; every "datacenter IPs are pre-scored low" claim found was scraping-vendor marketing. Wikimedia's global block list (`Open proxy/Webhost`), probed today, condemns everyone equally — /16-wide blocks sampled on Alibaba, AWS, Hetzner, Oracle, DigitalOcean, Vultr, IT7 and Tencent. **No provider is clean.**

**The decisive measurement.** From a clean *residential* IP (AS3462 HiNet) with a real browser UA: nejm.org, thelancet.com, nih.gov and medscape.com all returned **403 with `cf-mitigated: challenge`**; fiercepharma.com, nice.org.uk/guidance and fda.gov returned **200** — and fda.gov 302s to its abuse page only when the UA is `python-requests`. The four hardest sites are therefore **UA/TLS/JS-fingerprint gates, not IP-reputation gates: changing ASN will not fix them.** fda.gov/robots.txt sets `Crawl-Delay: 30`; nejm.org and thelancet.com `Disallow: /` only named AI crawlers (GPTBot, CCBot, PerplexityBot…).

**Safer bet:** a Western hosting ASN with replaceable per-instance IPs — AWS AS16509 or Vultr AS20473. Avoid Hetzner and IT7 (wide webhost blocks). Avoid Tencent AS132203 / Alibaba AS45102 not because any document penalises them (none does) but because they are CN-operated APNIC hosting ranges with no per-IP replacement story. Honest summary: ASN buys less than assumed; a headless browser engine, a stable identifying UA with a contact URL and honouring crawl-delay buy more.

## 3. Link quality toward mainland China (push direction)

Tencent says plainly that the cheap tiers are **not** cross-border-optimised: overseas public bandwidth "represents the peak bandwidth, which is **not** considered a guaranteed service metric", and users "may experience significant latency and packet loss when accessing Lighthouse from the Chinese mainland due to the ISP network lines" (intl.cloud.tencent.com/document/product/1103/41266). The Chinese price list repeats it for Hong Kong: "中国香港入门型套餐**无法保障**中国内地与中国香港之间的跨境公网质量…可能出现较大的网络延迟和丢包".

"Optimised to mainland" is a separate product: Tencent GAAP ("支持中国香港精品BGP网络") and Alibaba Global Accelerator. Among the cheap hosts only **BandwagonHost LA USCA_9** names premium carriers — "CN2 GIA by China Telecom (AS4809), CMIN2 (China Mobile AS58807) and China Unicom Premium (AS10099)" — while warning CN2 GIA is capacity-constrained and null-routed under DDoS (bandwagonhost.com/cn2gia-vps.php). **Typical latency: UNVERIFIED** — nobody publishes it; measure. This matters less than it looks for a *push* design: one outbound TLS connection, small bodies, retried from a 7-day spool, so peak-hour loss costs a retry rather than a page. Make the push idempotent (batch id + dedupe in Beijing) and cross-border jitter is a non-event.

## 4. Cloudflare Workers as relay

**Free**: 100,000 req/day, **10 ms CPU per invocation**, **50 subrequests/request**, 5 Cron Triggers, "no general limit on requests per second" (developers.cloudflare.com/workers/platform/limits/ and /pricing/). **Paid**: **$5/mo**, 10 M requests then +$0.30/M, 30 M CPU-ms then +$0.02/M, 10,000 subrequests/request. A 7-day spool can't live in free KV — **1,000 writes/day to distinct keys**; use R2 (10 GB free, egress free).

**Worker egress is labelled and filterable**: Cloudflare adds **`CF-Worker`** to every `fetch()` subrequest "to provide a means for recipients… to recognize, filter, and route traffic generated by Workers", and any protected origin can match `cf.worker.upstream_zone`. A *bot-score* penalty is **UNVERIFIED** — but a one-header block is available to every target, which is the real risk. **From China**: the China Network is **Enterprise-only and needs an ICP filing per apex domain**; `workers.dev` is "intended for personal or hobby projects that aren't business-critical", and claims it is DNS-poisoned in China are **UNVERIFIED** — test from Beijing. **Terms**: no §2.8 exists; the live clauses are §2.2.1(j) "provide a virtual private network or other similar proxy services" and §2.2.1(e) on scripts that "strip or mine data". Verdict: a companion for a few hostile targets, not the primary node.

## 5. X (Twitter) API — the ruling not to monitor X stands

**Tiers are gone.** "The X API uses pay-per-usage pricing. No subscriptions—pay only for what you use": posts **$0.005 each**, users $0.010, capped at **3 M post reads/cycle** before Enterprise (price UNVERIFIED) — docs.x.com/x-api/getting-started/pricing. Basic retired after 2026-06-01, Pro after 2026-09-01, migrated to PPU with $200/$5,000 Stripe charges. `GET /2/users/:id/tweets`: 10,000/15 min per app, `max_results` 100. **No free tier for a commercial reader**, and **Nitter is dead** (archived again 11 Sept 2026). A few accounts would run ~$30/month metered with no ceiling you control.

## 6. WeChat official-account bridges

| Option | Cost | Login | Latency | Maintained |
|---|---|---|---|---|
| **wechat2rss** | **¥15/mo, ¥150/yr** licence | personal WeChat via 微信读书 QR | ~6 h avg (1–2 checks/day) | yes, 2026-07-31 |
| **we-mp-rss** (rachelos) | free, **MIT** | your own 公众号 admin QR | your cron | yes, 2026-08-13 |
| **WeRSS** (werss.app) | hosted | WeChat QR | 1 min–28 h | **closed: "暂不开放新订阅"** |
| **wewe-rss** | free | 微信读书 | — | **archived** 2024-12 |
| RSSHub `wechat` | free | — | — | indirect scrapers; `feeddd` broken |

Decisive: **wechat2rss's licence forbids this use** — "严禁将本软件用于任何商业用途…严禁搭建公开服务或二次分发内容", and it warns "使用本工具可能导致微信号被限制或封禁" (wechat2rss.xlab.app/deploy/agreement.html; 400+ accounts per WeChat account, 群发 only, no history). **we-mp-rss (MIT) is the only legally clean self-host.** Neither needs a mainland server, but both need a real WeChat identity — run it on the Beijing side, not the crawl node.

## 7. Regulatory (documented facts, not legal advice)

ICP 备案 attaches to servers **inside** mainland China; a domain resolving overseas needs none, your Beijing endpoint does (help.aliyun.com/zh/icp-filing/basic-icp-service/product-overview/faq-about-icp-filing-applications-in-different-scenarios). The cross-border rules govern **outbound** transfer (数据出境), thresholds 10万/100万 persons — inbound fetching of public foreign pages is not what they regulate (cac.gov.cn/2024-03/22/c_1712776611775634.htm). MIIT 信管函[2017]32号 — "未经电信主管部门批准，不得自行建立或租用专线（含虚拟专用网络VPN）等其他信道开展跨境经营活动" — targets unlicensed cross-border telecom **operation for others**; MIIT's Q&A says ordinary 办公自用 networking is unaffected, so don't resell or share the node's connectivity. robots.txt is voluntary — "These rules are not a form of access authorization" (RFC 9309) — so each site's ToS is contractual, not Chinese regulation.

## Recommendation

**Primary: Vultr, Tokyo (`nrt`), `vc2-2c-4gb` — 2 vCPU / 4 GB / 80 GB NVMe / 3 TB — $20/month, paid by Alipay.** It alone combines a Western hosting ASN whose sampled prefixes were not on Wikimedia's webhost list, Alipay in the vendor's current billing docs, a Tokyo region (DigitalOcean has none; Hetzner is €26.49 in Singapore with an ID check at signup), hourly billing, and destroy-and-redeploy for a fresh IP when one gets refused. Not the cheapest — but the node's whole job is to be *accepted* by the targets, and the operator's ASN is the one variable you cannot change after buying. **Fallback: Tencent Lighthouse 东京 or 新加坡, 入门型 2C/4G/60 GB/30 Mbps/1,536 GB, ¥42/month** — two minutes from the existing mainland account, RMB, fapiao, no 备案; take it if procurement weight beats a few refused endpoints, and only after it passes the same test. Avoid the Hong Kong entry tier. Buy **monthly first** either way: Tencent's overseas duration discount does not apply below 2C/8G, so waiting costs nothing.

**10-minute acceptance test on the fresh VM, before any long billing term.** (1) `curl -s https://ipinfo.io/json` — record ASN and country. (2) With a real Chrome UA, `curl -o /dev/null -D- -w '%{http_code}\n'` against nejm.org, thelancet.com, nih.gov, medscape.com, fiercepharma.com, nice.org.uk/guidance, fda.gov — note any `cf-mitigated` header; then the GFW set (substack.com, bbc.com, theguardian.com, research.google). (3) Headless Chromium on nejm.org and one script-drawn page — assert real article text, not a challenge page. (4) 20 POSTs to your ingest endpoint recording status and `time_total`, then `mtr -rwc 50 <beijing-ip>`. (5) A 30-minute loop at your real cadence, counting non-200s. **Accept** if ≥6 of 7 targets return 200 under a real browser, the browser extracts article text from nejm.org, 20/20 pushes are 200 with p95 < 1.5 s, and mtr loss to Beijing stays under 5% at 20:00–23:00 Beijing time. **Reject and destroy** (an hour costs ~$0.03) if any two fail — retry in Osaka or Silicon Valley before switching provider.
