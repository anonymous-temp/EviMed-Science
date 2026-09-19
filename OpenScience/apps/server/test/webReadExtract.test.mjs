// Main text out of a page, and whether a page needs a browser, on the pages
// the plan measured (recorded 2026-09-19, fixtures/web-read/manifest.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodePage, extractHtml, pageCharset, renderReason, SHELL_VISIBLE_CHARS } from "../src/webReadExtract.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "web-read");
const manifest = JSON.parse(readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"));

function recorded(file) {
  const entry = manifest.files.find((item) => item.file === file);
  assert.ok(entry, `${file} is not in the fixture manifest`);
  const bytes = readFileSync(path.join(fixtureDir, file));
  const html = decodePage(bytes, entry.contentType);
  const page = extractHtml(html, { baseUrl: entry.url });
  return { entry, html, page, reason: renderReason({ status: entry.status, html, visibleChars: page.visibleChars }) };
}

test("every recorded fixture is the file its manifest describes", async () => {
  const { createHash } = await import("node:crypto");
  assert.equal(manifest.files.length, 5);
  for (const entry of manifest.files) {
    const bytes = readFileSync(path.join(fixtureDir, entry.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.file);
  }
});

test("NICE's guideline page reads directly: the guidance text, headings, links, no page furniture", () => {
  const { page, reason } = recorded("nice-ng136.html");
  assert.equal(reason, null, "a page with its text in the HTML needs no browser");
  assert.ok(page.visibleChars > 3_000, `only ${page.visibleChars} visible characters were kept`);
  assert.match(page.title, /Hypertension in adults: diagnosis and management/);
  assert.match(page.text, /^# Hypertension in adults: diagnosis and management$/m);
  assert.match(page.text, /This guideline covers identifying and treating primary hypertension/);
  assert.match(page.text, /Reference number: NG136/);
  // The site header and footer are outside `main` and are not text.
  assert.doesNotMatch(page.text, /Cookies/i);
  assert.ok(page.links.some((link) => link.url.startsWith("https://www.nice.org.uk/guidance/ng136/")), "the guideline's own sections are returned as links");
  assert.ok(page.links.every((link) => /^https?:\/\//.test(link.url) && !link.url.includes("#")));
});

test("ClinicalTrials.gov's study page is an application shell to a plain client", () => {
  const { page, reason } = recorded("ctgov-NCT03036124.direct.html");
  assert.ok(page.visibleChars < SHELL_VISIBLE_CHARS);
  assert.deepEqual(reason, { kind: "shell", vendor: null });
});

test("NMPA and NHC answer a plain client with the 瑞数 JavaScript challenge", () => {
  for (const file of ["nmpa-ggtg.412.html", "nhc-gfxwj.412.html"]) {
    const { page, reason } = recorded(file);
    assert.equal(page.visibleChars, 0, file);
    assert.deepEqual(reason, { kind: "challenge", vendor: "ruishu" }, file);
  }
});

test("CDE's 403 is a refusal of a plain client, sent to a browser rather than read as the page", () => {
  const { page, reason } = recorded("cde-news.403.html");
  assert.ok(page.visibleChars < SHELL_VISIBLE_CHARS);
  assert.deepEqual(reason, { kind: "blocked", vendor: null });
});

test("a real page that also carries a vendor's detection script is read as it is", () => {
  const body = `<html><head><script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js"></script></head><body><main><p>${"Recommendation text. ".repeat(40)}</p></main></body></html>`;
  const page = extractHtml(body, { baseUrl: "https://example.org/" });
  assert.equal(renderReason({ status: 200, html: body, visibleChars: page.visibleChars }), null);
  // A 404 is what a browser would get too: not a render reason.
  assert.equal(renderReason({ status: 404, html: "<p>Not found</p>", visibleChars: 9 }), null);
  assert.equal(renderReason({ status: 503, html: "<p>down</p>", visibleChars: 4 }), null);
  assert.deepEqual(renderReason({ status: 503, html: "<p>x</p><script>var a='acw_sc__v2'</script>", visibleChars: 1 }), { kind: "challenge", vendor: "aliyun-waf" });
});

test("a GBK page declared only in its meta tag decodes as GBK", () => {
  const html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"><title>关于发布药品说明书的公告</title></head><body><div class="list"><ul><li><a href="/xxgk/1.html">国家药监局关于修订说明书的公告</a><span>2026-09-16</span></li></ul></div></body></html>`;
  const bytes = Buffer.from(new TextEncoder().encode(html));
  // Re-encode as GBK: TextDecoder cannot encode, so build the bytes the way a
  // GBK server would send them from a known GBK sample.
  const gbk = Buffer.from("b9d8d3dab7a2b2bcd2a9c6b7cbb5c3f7cae9b5c4b9abb8e6", "hex"); // 关于发布药品说明书的公告
  const document = Buffer.concat([
    Buffer.from('<html><head><meta charset="gbk"><title>', "latin1"), gbk,
    Buffer.from("</title></head><body><p>", "latin1"), gbk, Buffer.from("</p></body></html>", "latin1"),
  ]);
  assert.equal(pageCharset(document, "text/html"), "gbk");
  const page = extractHtml(decodePage(document, "text/html"), { baseUrl: "https://www.nmpa.gov.cn/" });
  assert.equal(page.title, "关于发布药品说明书的公告");
  assert.match(page.text, /关于发布药品说明书的公告/);
  // The header's charset wins over the meta tag.
  assert.equal(pageCharset(bytes, "text/html; charset=utf-8"), "utf-8");
});

test("tables read as rows, lists as items, hidden and interactive elements not at all", () => {
  const html = `<html><head><title>List</title></head><body>
    <nav><a href="/">首页</a></nav>
    <div id="content">
      <h2>公告通告</h2>
      <table><tr><th>标题</th><th>日期</th></tr>
        <tr><td><a href="/a.html">关于A的公告</a></td><td>2026-09-16</td></tr>
        <tr><td><a href="b.html">关于B的公告</a></td><td>2026-09-15</td></tr></table>
      <ul><li>第一条</li><li>第二条<ul><li>子条目</li></ul></li></ul>
      <p style="display: none">隐藏文字</p><p aria-hidden="true">也隐藏</p>
      <button>搜索</button><select><option>选项</option></select>
      <p>第一行<br>第二行</p>
    </div>
    <footer>版权所有</footer></body></html>`;
  const page = extractHtml(html, { baseUrl: "https://www.nmpa.gov.cn/xxgk/ggtg/index.html" });
  assert.match(page.text, /^## 公告通告$/m);
  assert.match(page.text, /^\| 标题 \| 日期 \|\n\| 关于A的公告 \| 2026-09-16 \|\n\| 关于B的公告 \| 2026-09-15 \|$/m);
  assert.match(page.text, /^- 第一条\n- 第二条\n- 子条目$/m);
  assert.match(page.text, /第一行\n第二行/);
  for (const absent of ["隐藏文字", "也隐藏", "搜索", "选项", "首页", "版权所有"]) {
    assert.ok(!page.text.includes(absent), `${absent} should not be read`);
  }
  assert.deepEqual(page.links.map((link) => link.url), [
    "https://www.nmpa.gov.cn/a.html",
    "https://www.nmpa.gov.cn/xxgk/ggtg/b.html",
  ]);
});

test("an empty page that names its document in a meta refresh says where it is", () => {
  const page = extractHtml(`<html><head><meta http-equiv="refresh" content="0; url=/real/page.html"></head><body></body></html>`, { baseUrl: "https://site.example.org/start" });
  assert.equal(page.refreshUrl, "https://site.example.org/real/page.html");
  assert.equal(page.visibleChars, 0);
});
