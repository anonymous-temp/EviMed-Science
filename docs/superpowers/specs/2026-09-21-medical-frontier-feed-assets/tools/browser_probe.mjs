// Opens each URL in a headless Chromium and reports time-to-list, headline-link and date counts (plan 10.2.6).
// A headline link is >= 8 CJK characters or an English phrase of >= 25 characters; dates are ISO/Chinese or English month names.
// Local:  PWCORE=<playwright-core/index.mjs> CHROME=<chromium> URLS='["https://…"]' node tools/browser_probe.mjs
// Beijing: run inside the runtime image (it ships /usr/bin/chromium) with playwright-core mounted read-only.
const core = process.env.PWCORE;
const { chromium } = await import(core);
const urls = JSON.parse(process.env.URLS);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const t00 = Date.now();
const browser = process.env.CDP
  ? await chromium.connectOverCDP(process.env.CDP)
  : await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] });
const ctx = await browser.newContext({ locale: "zh-CN", userAgent: UA, viewport: { width: 1366, height: 900 } });
for (const url of urls) {
  const page = await ctx.newPage(); const t0 = Date.now(); let err = null;
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); } catch (e) { err = String(e.message).slice(0, 80); }
  let items = []; const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      items = await page.evaluate(() => [...document.querySelectorAll("a")].map((a) => ({ t: (a.textContent || "").replace(/\s+/g, " ").trim(), h: a.href })).filter((x) => /[一-龥]{8,}/.test(x.t) || (x.t.length >= 25 && /[A-Za-z]{3,}(\s+[A-Za-z]{2,}){3,}/.test(x.t))));
    } catch { items = []; }
    if (items.length >= 12) break;
    try { if (await page.evaluate(() => document.getElementsByTagName("item").length + document.getElementsByTagName("entry").length) >= 3) break; } catch {}
    await page.waitForTimeout(500);
  }
  let text = ""; try { text = await page.evaluate(() => document.body?.innerText || ""); } catch {}
  const dates = (text.match(/20\d\d[-.年/]\d{1,2}[-.月/]\d{1,2}|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+20\d\d|\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d\d/g) || []).length;
  let title = ""; try { title = await page.title(); } catch {}
  let feedItems = 0; try { feedItems = await page.evaluate(() => document.getElementsByTagName("item").length + document.getElementsByTagName("entry").length); } catch {}
  console.log(JSON.stringify({ url, ms: Date.now() - t0, title: title.slice(0, 30), links: items.length, feedItems, dates, err, sample: items.slice(6, 9).map((x) => x.t.slice(0, 36)) }));
  await page.close();
}
console.log(JSON.stringify({ total_ms: Date.now() - t00 }));
await browser.close();
