import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Unmodified published @deepseek-ai/dsh-web-frontend@0.1.5-rc.2 dist/index.html.
const publishedHtml = await readFile(new URL("./fixtures/dsh/rc1/index.html", import.meta.url), "utf8");
const prefix = `/__evimed/f/${"A".repeat(32)}/`;

test("published rc.1 HTML installs a synchronous bootstrap before host boot rows and preserves the native graph and asset chain", async () => {
  const { rebaseRuntimeUiDocument } = await import("../src/runtimeUiDocument.mjs");
  // Exact row order and attribute shapes from published client-modules bootInjections.
  const graph = { entries: [{ url: "/plugins/??@evimed/dsh-socket/client&rev=abc" }], batches: [{ phase: "bootstrap", url: "/plugins/??@deepseek-ai/dsh-client-modules/client&rev=abc" }] };
  const hostRows = `<base href="/"><script>window.__ModuleLoader__={mode:"queue"}</script><link rel="preload" as="script" href="/plugins/??app&rev=abc"><script src="/plugins/??bootstrap&rev=abc"></script><script>window.__DSH_BOOT__=${JSON.stringify(graph)}</script>`;
  const source = publishedHtml.replace("<head>", `<head>${hostRows}`);
  const rendered = rebaseRuntimeUiDocument(Buffer.from(source), { "content-type": "text/html" }, prefix).toString();
  assert.ok(rendered.indexOf(`${prefix}__evimed_bootstrap.js`) < rendered.indexOf("window.__ModuleLoader__"));
  assert.match(rendered, new RegExp(`<script src="${prefix}__evimed_bootstrap.js"></script>`));
  assert.equal((rendered.match(/<base /g) ?? []).length, 1);
  assert.ok(rendered.includes(`<base href="${prefix}">`));
  assert.ok(rendered.includes(`src="${prefix}plugins/??bootstrap&rev=abc"`));
  assert.ok(rendered.includes(`href="${prefix}plugins/??app&rev=abc"`));
  assert.ok(rendered.includes(`window.__DSH_BOOT__=${JSON.stringify(graph)}`));
  for (const relative of ["./assets/index-Df-65__b.js", "./assets/vendor-CCJJTK99.js", "./assets/vendor-BNsW4eBh.css", "./favicon.svg", "./manifest.webmanifest"]) assert.ok(rendered.includes(relative));
  assert.equal(rebaseRuntimeUiDocument(Buffer.from(publishedHtml), { "content-type": "text/html" }, prefix).toString().match(/<base /g).length, 1);
});

test("native Javascript and CSS remain byte-identical and source text containing HTML is never rewritten", async () => {
  const { rebaseRuntimeUiDocument } = await import("../src/runtimeUiDocument.mjs");
  const data = Buffer.from('const html = `<base href="/"><script src="/plugins/a.js"></script>`');
  assert.equal(rebaseRuntimeUiDocument(data, { "content-type": "text/javascript" }, prefix), data);
  const html = Buffer.from(`<html><head><script>const value = '<script src="/plugins/inline.js">';</script><script src='/plugins/actual.js'></script></head></html>`);
  const rendered = rebaseRuntimeUiDocument(html, { "content-type": "text/html" }, prefix).toString();
  assert.ok(rendered.includes(`const value = '<script src="/plugins/inline.js">'`));
  assert.ok(rendered.includes(`src='${prefix}plugins/actual.js'`));
});

test("with the project's stable asset path, the document's own build files are referenced there and nothing else moves", async () => {
  const { rebaseRuntimeUiDocument } = await import("../src/runtimeUiDocument.mjs");
  const rendered = rebaseRuntimeUiDocument(Buffer.from(publishedHtml), { "content-type": "text/html" }, prefix, "/__evimed/a/default/").toString();
  for (const file of ["assets/index-Df-65__b.js", "assets/vendor-CCJJTK99.js", "assets/vendor-BNsW4eBh.css", "assets/index-b24khbeK.css"]) {
    assert.ok(rendered.includes(`"/__evimed/a/default/${file}"`), `${file} was not moved: ${rendered}`);
    assert.ok(!rendered.includes(`"./${file}"`), `${file} is still relative`);
  }
  assert.ok(rendered.includes('href="./favicon.svg"') && rendered.includes('href="./manifest.webmanifest"'), "files outside assets/ stay with the frame");
  assert.ok(rendered.includes(`<base href="${prefix}">`), "the frame's own base is unchanged");
  // A malformed path is not trusted to name anything.
  const refused = rebaseRuntimeUiDocument(Buffer.from(publishedHtml), { "content-type": "text/html" }, prefix, "/elsewhere/").toString();
  assert.ok(refused.includes('src="./assets/index-Df-65__b.js"'));
});
