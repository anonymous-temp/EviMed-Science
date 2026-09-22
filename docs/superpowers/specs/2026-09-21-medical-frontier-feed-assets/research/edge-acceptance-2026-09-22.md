# Overseas node acceptance, 2026-09-22

Host: Vultr Tokyo 45.32.58.204 (AS20473 The Constant Company), 2 vCPU / 3.4 GB / 47 GB, Ubuntu 26.04.1, kernel 7.0.
Reinstalled by the owner the same day; host key ED25519 SHA256:qhdZVAKHmQcAWjx0eZ83sDackjMDtkkPVfHPUWZnOJw; login root with ~/.ssh/evimed_deploy.

1. Registry probe, relay + browser egress (134 sources), `tools/probe_registry.py ssh:frontier-edge`:
   - fake desktop Chrome UA (the tool's old default): relay 43/67 readable; browser 6/67 → `probe-edge-2026-09-22.jsonl`
   - honest `EviMedBot/1.0 (+https://82.156.128.153; frontier collector)` (VERIFY_UA): relay 59/67 (88 %), FDA 16/16, NICE 4/5, Fierce 3/3; browser 11/67 → `probe-edge-honest-ua-2026-09-22.jsonl`
   - curl spot check: FDA fake UA → 302 to the abuse page (404 after -L), CDC → 403, canada.ca → reset; the honest UA → 200 on all three.
2. Same honest UA from the Beijing production host over the 166 non-direct sources: 33 become readable (all 14 FDA web pages, CDC HAN, Health Canada InfoWatch, ISMP Canada, Medscape, GINA, AGA, ACG, DDW, …) → `probe-prod-honest-ua-2026-09-22.jsonl`.
3. Push to Beijing (8 KB POST to https://82.156.128.153/edge/frontier/v1/probe, answered 401 by the app): new TLS each time p50 0.78 s / p95 2.57 s; one reused connection p50 0.37 s / p95 1.46 s → `push-latency-*.txt`.
4. Headless Chromium (mcr.microsoft.com/playwright:v1.63.0-noble, Chromium build 1243) on the 36 overseas sources neither site reads with plain HTTP: 9 readable (TGA news + safety alerts, Cochrane Clinical Answers, ESMO guidelines + newsroom, AHRQ EPC, Johns Hopkins newsroom, Bayer, Mayo Clinic Platform); Cloudflare managed challenge (「请稍候…」) blocks 9 (NIH ×4, CDA-AMC, SSRN, Healthcare IT News, Digital Health, Perplexity); 6 registry URLs are stale (404) → `edge-browser-2026-09-22.jsonl`.
5. Web search, SearXNG 2026.8.4 on both sides, 20 medical queries: Tokyo 20/20 answered (~30 results each; bing + google cse; duckduckgo and startpage CAPTCHA, brave HTTP error); Beijing 1/20, 8 results in total (quark CAPTCHA-suspended) → `search-compare-2026-09-22.jsonl`.
6. WeChat article links through search engines: 18 of the 31 accounts queried with `site:mp.weixin.qq.com`, 0 usable links → `wechat-search-engines-2026-09-22.jsonl`.

Left running on the node: Docker 29.1 (Ubuntu docker.io), a private SearXNG `edge-search` on 127.0.0.1:8888 (`/opt/searxng/settings.yml`, 0600), the Playwright image and `/opt/bprobe` (playwright-core + tools/browser_probe.mjs). Nothing listens publicly except sshd.
