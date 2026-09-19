// One web read end to end: redirects checked hop by hop, robots honoured,
// the browser used only for a page that needs one, documents through the
// parser, and the gateway mode that serves it to the runtime.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPublicSourceGatewayHandler } from "../src/publicSourceGateway.mjs";
import { createWebReader, webReadMetricFamilies, webReadUserAgent } from "../src/webRead.mjs";
import { isOfficialWebSource } from "../src/webReadOfficial.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "web-read");
const fixture = (file) => readFileSync(path.join(fixtureDir, file));

const html = (text, status = 200, extra = {}) => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8", ...extra },
  body: Buffer.isBuffer(text) ? text : Buffer.from(text),
});
const article = (words) => `<html><head><title>Guidance</title></head><body><main><h1>Guidance</h1><p>${words.repeat(40)}</p></main></body></html>`;
const noRobots = () => ({ status: 404, headers: {}, body: Buffer.alloc(0) });

/**
 * A transport over a table of URL → response, recording every request and
 * never touching the network. robots.txt answers 404 unless the table says
 * otherwise.
 */
function fakeTransport(table) {
  const requests = [];
  const transport = async ({ url, headers }) => {
    requests.push({ url: url.href, headers });
    const entry = table[url.href] ?? (url.pathname === "/robots.txt" ? noRobots : null);
    if (!entry) throw new Error(`unexpected request ${url.href}`);
    return typeof entry === "function" ? entry(url) : entry;
  };
  return { transport, requests, pages: () => requests.filter((request) => !request.url.endsWith("/robots.txt")) };
}

const config = { webReadHostIntervalMs: 0, webReadConcurrency: 4, publicSourceGatewayMaxResponseBytes: 4 * 1024 * 1024, publicUrl: "https://evimed.example.cn" };
const fixedNow = () => new Date("2026-09-20T02:00:00.000Z");

test("a plain page is read directly, with a receipt that names every fact about it", async () => {
  const { transport, requests } = fakeTransport({ "https://www.nice.org.uk/guidance/ng136": html(fixture("nice-ng136.html")) });
  const reader = createWebReader(config, { transport, now: fixedNow });
  const result = await reader.read("https://www.nice.org.uk/guidance/ng136#recommendations");
  assert.deepEqual(result.receipt, {
    url: "https://www.nice.org.uk/guidance/ng136",
    finalUrl: "https://www.nice.org.uk/guidance/ng136",
    title: "Overview | Hypertension in adults: diagnosis and management | Guidance | NICE",
    site: "www.nice.org.uk",
    fetchedAt: "2026-09-20T02:00:00.000Z",
    official: true,
    rendered: false,
    contentType: "html",
    mediaType: "text/html",
    status: 200,
    sha256: createHash("sha256").update(fixture("nice-ng136.html")).digest("hex"),
    bytes: fixture("nice-ng136.html").length,
    extractor: { name: "evimed-html", version: "1.0.0" },
  });
  assert.match(result.text, /This guideline covers identifying and treating primary hypertension/);
  assert.equal(result.notice, undefined);
  // An honest User-Agent naming the product and where to find us, on every request.
  const agent = webReadUserAgent(config);
  assert.match(agent, /^EviMedBot\/1\.0 \(\+https:\/\/evimed\.example\.cn; /);
  assert.ok(requests.every((request) => request.headers["user-agent"] === agent));
  assert.deepEqual(requests.map((request) => request.url), [
    "https://www.nice.org.uk/robots.txt",
    "https://www.nice.org.uk/guidance/ng136",
  ]);
});

test("every redirect hop is validated and checked against its own site's robots.txt", async () => {
  const { transport, requests, pages } = fakeTransport({
    "https://short.example.org/r": html("", 302, { location: "https://docs.example.org/guide" }),
    "https://docs.example.org/guide": html(article("Real guidance text. ")),
    "https://bounce.example.org/r": html("", 301, { location: "http://169.254.169.254/latest/meta-data/" }),
    "https://robots.example.org/r": html("", 302, { location: "https://closed.example.org/page" }),
    "https://closed.example.org/robots.txt": { status: 200, headers: {}, body: Buffer.from("User-agent: *\nDisallow: /\n") },
  });
  const reader = createWebReader(config, { transport, now: fixedNow });

  const followed = await reader.read("https://short.example.org/r");
  assert.equal(followed.receipt.url, "https://short.example.org/r");
  assert.equal(followed.receipt.finalUrl, "https://docs.example.org/guide");
  assert.equal(followed.receipt.site, "docs.example.org");
  assert.equal(followed.receipt.official, false, "an official label is the page's own, never a redirector's");

  await assert.rejects(reader.read("https://bounce.example.org/r"), (error) => error.code === "web_read_host_forbidden");
  await assert.rejects(reader.read("https://robots.example.org/r"), (error) => error.code === "web_read_robots_disallowed");
  assert.ok(!requests.some((request) => request.url.includes("169.254")), "the inward hop was never requested");
  assert.ok(!pages().some((request) => request.url === "https://closed.example.org/page"), "a disallowed page is never fetched");

  const loop = fakeTransport({ "https://loop.example.org/a": html("", 302, { location: "https://loop.example.org/a" }) });
  await assert.rejects(createWebReader(config, { transport: loop.transport }).read("https://loop.example.org/a"), (error) => error.code === "web_read_too_many_redirects");
});

function fakeRenderer(pagesByUrl, { fail = null } = {}) {
  const calls = [];
  return {
    calls,
    enabled: true,
    async render({ url }) {
      calls.push(url.href);
      if (fail) throw fail;
      const page = pagesByUrl[url.href];
      if (!page) throw new Error(`no render for ${url.href}`);
      return page;
    },
  };
}

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

test("a JavaScript challenge goes to the browser, and only a page that needs one does", async () => {
  const nmpa = "https://www.nmpa.gov.cn/xxgk/ggtg/index.html";
  const rendered = `<html><head><title>公告通告</title></head><body><div class="list"><ul>${
    Array.from({ length: 30 }, (_, index) => `<li>\n  <a href="/xxgk/ggtg/${index}.html">国家药监局关于第${index}号的公告</a>\n  <span>2026-09-${String((index % 28) + 1).padStart(2, "0")}</span></li>`).join("")
  }</ul></div></body></html>`;
  const { transport } = fakeTransport({
    [nmpa]: html(fixture("nmpa-ggtg.412.html"), 412),
    "https://www.nice.org.uk/guidance/ng136": html(fixture("nice-ng136.html")),
  });
  const renderer = fakeRenderer({ [nmpa]: { html: rendered, finalUrl: nmpa, status: 200 } });
  const reader = createWebReader(config, { transport, renderer, resolveImpl: publicResolver, now: fixedNow });

  const result = await reader.read(nmpa);
  assert.equal(result.receipt.rendered, true);
  assert.equal(result.receipt.official, true);
  assert.equal(result.receipt.status, 200);
  assert.equal(result.receipt.sha256, createHash("sha256").update(rendered, "utf8").digest("hex"));
  assert.match(result.text, /^- 国家药监局关于第0号的公告 2026-09-01$/m);
  assert.equal(result.links[0].url, "https://www.nmpa.gov.cn/xxgk/ggtg/0.html");

  await reader.read("https://www.nice.org.uk/guidance/ng136");
  assert.deepEqual(renderer.calls, [nmpa], "a page with its text in the HTML is never rendered");
  assert.equal(reader.stats().outcomes.rendered, 1);
  assert.equal(reader.stats().outcomes.html, 1);
});

test("a page still unreadable after rendering, or a browser that lands inward, is a named error", async () => {
  const cde = "https://www.cde.org.cn/main/news/listpage/545cf855a50574699b46b26bcb165f32";
  const { transport } = fakeTransport({ [cde]: html(fixture("cde-news.403.html"), 403) });
  const still = createWebReader(config, {
    transport,
    resolveImpl: publicResolver,
    renderer: fakeRenderer({ [cde]: { html: fixture("nmpa-ggtg.412.html").toString("utf8"), finalUrl: cde, status: 412 } }),
  });
  await assert.rejects(still.read(cde), (error) => error.code === "web_read_unreadable" && error.status === 422);

  const inward = createWebReader(config, {
    transport,
    resolveImpl: async () => [{ address: "10.0.0.8", family: 4 }],
    renderer: fakeRenderer({ [cde]: { html: article("x"), finalUrl: "https://intranet.example.org/", status: 200 } }),
  });
  await assert.rejects(inward.read(cde), (error) => error.code === "web_read_host_forbidden");
});

test("a rendered page is held to the size cap a fetched page is", async () => {
  const ctgov = "https://clinicaltrials.gov/study/NCT03036124";
  const { transport } = fakeTransport({ [ctgov]: html(fixture("ctgov-NCT03036124.direct.html")) });
  const drawn = `<html><body><main><p>Start of the study record.</p>${`<p>${"x".repeat(1_000)}</p>`.repeat(6 * 1024)}<p>Past the cap.</p></main></body></html>`;
  const renderer = fakeRenderer({ [ctgov]: { html: drawn, finalUrl: ctgov, status: 200 } });
  const reader = createWebReader(config, { transport, renderer, resolveImpl: publicResolver });
  const result = await reader.read(ctgov);
  const cap = 5 * 1024 * 1024;
  assert.equal(result.receipt.rendered, true);
  assert.equal(result.receipt.bytes, cap);
  assert.equal(result.receipt.truncated, true);
  assert.equal(result.receipt.sha256, createHash("sha256").update(Buffer.from(drawn).subarray(0, cap)).digest("hex"), "the digest is of the bytes the text came from");
  assert.match(result.text, /Start of the study record/);
  assert.doesNotMatch(result.text, /Past the cap/);
});

test("without a browser: a challenge is a named error, a thin real page is kept and says so", async () => {
  const ctgov = "https://clinicaltrials.gov/study/NCT03036124";
  const thin = "https://thin.example.org/brief";
  const { transport } = fakeTransport({
    "https://www.nmpa.gov.cn/xxgk/ggtg/index.html": html(fixture("nmpa-ggtg.412.html"), 412),
    [ctgov]: html(fixture("ctgov-NCT03036124.direct.html")),
    [thin]: html("<html><body><main><p>A short notice: the clinic is closed on Monday.</p></main></body></html>"),
  });
  const reader = createWebReader(config, { transport });
  await assert.rejects(reader.read("https://www.nmpa.gov.cn/xxgk/ggtg/index.html"), (error) => error.code === "web_read_needs_browser");
  await assert.rejects(reader.read(ctgov), (error) => error.code === "web_read_needs_browser", "an empty shell has nothing to keep");
  const kept = await reader.read(thin);
  assert.match(kept.text, /clinic is closed on Monday/);
  assert.match(kept.notice, /may be incomplete/);

  // A browser that fails outright does not cost the thin page either.
  const broken = createWebReader(config, {
    transport,
    renderer: fakeRenderer({}, { fail: Object.assign(new Error("session died"), { code: "web_render_unavailable", status: 503 }) }),
  });
  assert.match((await broken.read(thin)).notice, /browser could not open it/);
});

test("PDFs and office documents go to the parser; other downloads are refused by name", async () => {
  const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n...guideline...\n");
  const { transport } = fakeTransport({
    "https://www.escardio.org/Guidelines/hf.pdf": { status: 200, headers: { "content-type": "application/pdf" }, body: pdfBytes },
    "https://files.example.org/attachment": { status: 200, headers: { "content-type": "application/octet-stream" }, body: pdfBytes },
    "https://files.example.org/archive.zip": { status: 200, headers: { "content-type": "application/zip" }, body: Buffer.from("PK") },
    "https://files.example.org/notes.txt": { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: Buffer.from("plain notes") },
  });
  const parsed = [];
  const documentParser = {
    async parseBytes(input) {
      parsed.push(input);
      return {
        protocolVersion: 1,
        extractor: { name: "evimed-extract", version: "evimed-extract@0.5.0", parser: "api" },
        text: "Recommendation 1. Offer an SGLT2 inhibitor.",
        pageMap: [{ page: 1, start: 0, end: 44, status: "ok" }],
        metadata: { title: "2026 ESC Heart Failure Guidelines", doi: "10.1093/eurheartj/ehaf000" },
      };
    },
  };
  const reader = createWebReader(config, { transport, documentParser, now: fixedNow });
  const result = await reader.read("https://www.escardio.org/Guidelines/hf.pdf");
  assert.deepEqual(parsed[0], {
    bytes: pdfBytes,
    filename: "hf.pdf",
    mediaType: "application/pdf",
    sha256: createHash("sha256").update(pdfBytes).digest("hex"),
  });
  assert.equal(result.receipt.contentType, "document");
  assert.equal(result.receipt.title, "2026 ESC Heart Failure Guidelines");
  assert.equal(result.receipt.official, true);
  assert.equal(result.receipt.extractor.name, "evimed-extract");
  assert.deepEqual(result.pageMap, [{ page: 1, start: 0, end: 44, status: "ok" }]);
  // An untyped download is sniffed by its magic bytes.
  assert.equal((await reader.read("https://files.example.org/attachment")).receipt.mediaType, "application/pdf");
  assert.equal((await reader.read("https://files.example.org/notes.txt")).text, "plain notes");
  await assert.rejects(reader.read("https://files.example.org/archive.zip"), (error) => error.code === "web_read_content_type_unsupported" && error.status === 415);

  const withoutParser = createWebReader(config, { transport });
  await assert.rejects(withoutParser.read("https://www.escardio.org/Guidelines/hf.pdf"), (error) => error.code === "web_read_document_parser_unavailable");

  const failing = createWebReader(config, {
    transport,
    documentParser: { parseBytes: async () => { throw Object.assign(new Error("该文件格式暂不支持。"), { code: "source_format_unsupported", status: 415 }); } },
  });
  await assert.rejects(failing.read("https://www.escardio.org/Guidelines/hf.pdf"), (error) => error.code === "source_format_unsupported" && error.status === 415);
});

// The 2026-09-20 release's security review used this page: nested <div>s
// then stray </p>s make parse5 quadratic, and these 360 KB held the event
// loop for 16 s, every other request on the server waiting behind one read.
const stallingPage = () => `<html><body>${"<div>".repeat(40_000)}${"</p>".repeat(40_000)}</body></html>`;

/** Runs `work` beside a 10 ms interval: how it ended, and the loop's longest silence meanwhile. */
async function besideA10msInterval(work) {
  let ticks = 0;
  let last = Date.now();
  let longestGapMs = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    longestGapMs = Math.max(longestGapMs, now - last);
    last = now;
    ticks += 1;
  }, 10);
  let error = null;
  try {
    await work();
  } catch (caught) {
    error = caught;
  } finally {
    clearInterval(timer);
  }
  return { error, ticks, longestGapMs: Math.max(longestGapMs, Date.now() - last) };
}

test("a page built to stall the parser is refused by name while the event loop keeps ticking", async () => {
  const { transport } = fakeTransport({ "https://hostile.example.org/page": html(stallingPage()) });
  const reader = createWebReader(config, { transport, parseTimeoutMs: 500 });
  const watched = await besideA10msInterval(() => reader.read("https://hostile.example.org/page"));
  assert.equal(watched.error?.code, "web_read_page_too_complex");
  assert.equal(watched.error?.status, 422);
  assert.match(watched.error.message, /hostile\.example\.org's page did not parse within 1 s/);
  assert.ok(watched.ticks >= 10, `the interval ticked ${watched.ticks} times`);
  assert.ok(watched.longestGapMs < 1_000, `the event loop went ${watched.longestGapMs} ms without ticking`);
  const families = Object.fromEntries(webReadMetricFamilies(reader.stats()).map((family) => [family.name, family]));
  const limit = families.open_science_web_read_limits_total.series.find((item) => item.labels.limit === "parse" && item.labels.action === "refused");
  assert.equal(limit?.value, 1);
  assert.equal(families.open_science_web_read_in_flight.series.find((item) => item.labels.tier === "parse")?.value, 0);
});

test("the read's deadline, or its caller hanging up, ends the parse thread", async () => {
  const { transport } = fakeTransport({ "https://hostile.example.org/page": html(stallingPage()) });
  const reader = createWebReader(config, { transport });
  const started = Date.now();
  await assert.rejects(
    reader.read("https://hostile.example.org/page", { signal: AbortSignal.timeout(300) }),
    (error) => error.code === "web_read_timeout",
  );
  assert.ok(Date.now() - started < 5_000, "the read's deadline ended it, not the ten-second parse budget");
  const caller = new AbortController();
  setTimeout(() => caller.abort(), 200);
  await assert.rejects(reader.read("https://hostile.example.org/page", { signal: caller.signal }), (error) => error.code === "web_read_aborted");
  // Ended, not abandoned: a thread still parsing would burn a core for 16 s.
  const before = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const used = process.cpuUsage(before);
  assert.ok((used.user + used.system) / 1_000 < 400, `the process used ${((used.user + used.system) / 1_000).toFixed(0)} ms of CPU after both reads ended`);
});

test("a page nested past what the parse thread can walk is refused by name", async () => {
  const { transport } = fakeTransport({ "https://deep.example.org/page": html(`<html><body>${"<span>".repeat(50_000)}deep text</body></html>`) });
  const reader = createWebReader(config, { transport });
  await assert.rejects(reader.read("https://deep.example.org/page"), (error) => error.code === "web_read_page_too_complex" && /nested too deeply/.test(error.message));
});

test("the authorities of the plan's five pages are labelled official, a blog is not", () => {
  for (const url of [
    "https://www.nmpa.gov.cn/xxgk/ggtg/index.html",
    "https://www.cde.org.cn/main/news/listpage/545cf855a50574699b46b26bcb165f32",
    "http://www.nhc.gov.cn/wjw/gfxwj/list.shtml",
    "https://clinicaltrials.gov/study/NCT03036124",
    "https://www.nice.org.uk/guidance/ng136",
    "https://mpa.hunan.gov.cn/mpa/x.html",
    "https://www.ema.europa.eu/en/medicines/human/EPAR/ozempic",
  ]) assert.equal(isOfficialWebSource(url), true, url);
  for (const url of ["https://example.org/blog", "https://www.escardio.org/Congresses", "https://gov.example.com/", "not a url"]) {
    assert.equal(isOfficialWebSource(url), false, url);
  }
});

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

const runtimeManager = {
  assertActiveModelGatewayToken(token) {
    if (token !== "runtime-token") throw new Error("invalid token");
    return { userId: "alice", projectId: "paper-1" };
  },
};

const post = (base, body, token = "runtime-token") => fetch(`${base}/internal/sources/v1/fetch`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("the gateway serves a web read to the runtime, and the switch refuses it by name", async (t) => {
  const reads = [];
  const webReader = { async read(url) { reads.push(url); return { receipt: { url, finalUrl: url }, text: "page text", links: [] }; } };
  const server = createServer(createPublicSourceGatewayHandler({ webReadEnabled: true }, runtimeManager, { webReader }));
  const base = await listen(server);
  t.after(() => server.close());

  const answered = await post(base, { webRead: { url: "https://www.nice.org.uk/guidance/ng136" } });
  assert.equal(answered.status, 200);
  assert.deepEqual(await answered.json(), { receipt: { url: "https://www.nice.org.uk/guidance/ng136", finalUrl: "https://www.nice.org.uk/guidance/ng136" }, text: "page text", links: [] });
  assert.equal((await (await post(base, { webRead: { url: "https://x.example.org" } }, "stolen")).json()).error.code, "public_source_gateway_token_invalid");
  assert.equal((await (await post(base, { webRead: { url: "https://x.example.org", accept: ["text/html"] } })).json()).error.code, "public_source_gateway_field_invalid");
  assert.equal((await (await post(base, { webRead: { url: "https://x.example.org" }, url: "https://x.example.org" })).json()).error.code, "public_source_gateway_field_invalid");
  assert.equal(reads.length, 1);

  const off = createServer(createPublicSourceGatewayHandler({ webReadEnabled: false }, runtimeManager, { webReader }));
  const offBase = await listen(off);
  t.after(() => off.close());
  const refused = await post(offBase, { webRead: { url: "https://www.nice.org.uk/guidance/ng136" } });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, "web_read_disabled");
  assert.equal(reads.length, 1);
});

test("a web read's own refusal reaches the runtime with its code and reason", async (t) => {
  const { transport } = fakeTransport({ "https://www.nmpa.gov.cn/xxgk/ggtg/index.html": html(fixture("nmpa-ggtg.412.html"), 412) });
  const server = createServer(createPublicSourceGatewayHandler({ ...config, webReadEnabled: true }, runtimeManager, {
    webReader: createWebReader(config, { transport }),
  }));
  const base = await listen(server);
  t.after(() => server.close());
  const response = await post(base, { webRead: { url: "https://www.nmpa.gov.cn/xxgk/ggtg/index.html" } });
  assert.equal(response.status, 422);
  const { error } = await response.json();
  assert.equal(error.code, "web_read_needs_browser");
  assert.match(error.message, /www\.nmpa\.gov\.cn answers a plain client with a JavaScript challenge/);
});

test("the tier-1 API mode no longer fetches web pages as raw HTML", async (t) => {
  let upstream = 0;
  const server = createServer(createPublicSourceGatewayHandler({}, runtimeManager, {
    fetchImpl: async () => { upstream += 1; return new Response("<p>x</p>", { headers: { "content-type": "text/html" } }); },
  }));
  const base = await listen(server);
  t.after(() => server.close());
  const accept = await post(base, { url: "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=x", accept: ["text/html"] });
  assert.equal((await accept.json()).error.code, "public_source_gateway_accept_invalid");
  const host = await post(base, { url: "https://www.nhs.uk/symptoms/chest-pain/", accept: ["application/json"] });
  assert.equal((await host.json()).error.code, "public_source_gateway_url_forbidden");
  const labelPage = await post(base, { url: "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=x", accept: ["application/json"] });
  assert.equal((await labelPage.json()).error.code, "public_source_api_path_forbidden");
  assert.equal(upstream, 0);
});

test("an open-access PDF can come back parsed, with the PDF beside the text", async (t) => {
  const pdf = Buffer.from("%PDF-1.7 open access article");
  const fetchImpl = async (url) => {
    if (String(url).startsWith("https://api.unpaywall.org/")) {
      return Response.json({ best_oa_location: { url_for_pdf: "https://repo.example.org/a.pdf", host_type: "repository", version: "publishedVersion", license: "cc-by" } });
    }
    return new Response(pdf, { headers: { "content-type": "application/pdf" } });
  };
  const resolveImpl = async () => [{ address: "93.184.216.34", family: 4 }];
  const parsedInputs = [];
  const documentParser = {
    async parseBytes(input) {
      parsedInputs.push(input);
      return { protocolVersion: 1, extractor: { name: "evimed-extract", version: "evimed-extract@0.5.0", parser: "api" }, text: "Results: HR 0.74", units: [], summary: "", facts: [], methods: [] };
    },
  };
  const credentials = { publicSourceCredentials: { unpaywall: "contact@example.test" } };
  const server = createServer(createPublicSourceGatewayHandler(credentials, runtimeManager, { fetchImpl, resolveImpl, documentParser }));
  const base = await listen(server);
  t.after(() => server.close());

  const response = await post(base, { openAccessPdfDoi: "10.1234/oa.1", parse: true });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(Buffer.from(payload.pdf.base64, "base64").toString(), pdf.toString());
  assert.equal(payload.pdf.sha256, createHash("sha256").update(pdf).digest("hex"));
  assert.equal(payload.pdf.origin, "https://repo.example.org");
  assert.equal(payload.pdf.license, "cc-by");
  assert.deepEqual(payload.parsed, { text: "Results: HR 0.74", extractor: { name: "evimed-extract", version: "evimed-extract@0.5.0", parser: "api" } });
  assert.equal(payload.parseError, null);
  assert.equal(parsedInputs[0].mediaType, "application/pdf");
  assert.equal(parsedInputs[0].filename, "10.1234-oa.1.pdf");

  // No parser: the PDF still comes back, with the reason the text did not.
  const bare = createServer(createPublicSourceGatewayHandler(credentials, runtimeManager, { fetchImpl, resolveImpl }));
  const bareBase = await listen(bare);
  t.after(() => bare.close());
  const unparsed = await (await post(bareBase, { openAccessPdfDoi: "10.1234/oa.1", parse: true })).json();
  assert.equal(unparsed.parsed, null);
  assert.equal(unparsed.parseError.code, "source_parser_unavailable");
  assert.ok(unparsed.pdf.base64.length > 0);
  // And the raw mode is unchanged for a caller that did not ask.
  const raw = await post(bareBase, { openAccessPdfDoi: "10.1234/oa.1" });
  assert.equal(raw.headers.get("content-type"), "application/pdf");
  assert.equal((await (await post(bareBase, { openAccessPdfDoi: "10.1234/oa.1", parse: "yes" })).json()).error.code, "public_source_gateway_field_invalid");
});

test("what reads came to and every limit that bit them reach the operator's metrics", async () => {
  const { transport } = fakeTransport({
    "https://www.nice.org.uk/guidance/ng136": html(fixture("nice-ng136.html")),
    "https://closed.example.org/robots.txt": { status: 200, headers: {}, body: Buffer.from("User-agent: *\nDisallow: /\n") },
  });
  const reader = createWebReader(config, { transport });
  await reader.read("https://www.nice.org.uk/guidance/ng136");
  await assert.rejects(reader.read("https://closed.example.org/x"));
  const families = Object.fromEntries(webReadMetricFamilies(reader.stats()).map((family) => [family.name, family]));
  const sample = (name, labels) => families[name].series.find((item) => Object.entries(labels).every(([key, value]) => item.labels[key] === value))?.value;
  assert.equal(sample("open_science_web_read_outcomes_total", { outcome: "html" }), 1);
  assert.equal(sample("open_science_web_read_outcomes_total", { outcome: "refused" }), 1);
  assert.equal(sample("open_science_web_read_limits_total", { limit: "robots", action: "refused" }), 1);
  assert.equal(sample("open_science_web_render_events_total", { event: "render" }), 0);
  assert.deepEqual(webReadMetricFamilies(null), []);
});
