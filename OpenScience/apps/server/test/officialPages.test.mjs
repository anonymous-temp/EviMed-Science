// The official pages `official_page_fetch` may preserve are listed twice — by
// the research server, which refuses a URL before asking, and by the gateway,
// which refuses it again at the network edge — and the two lists must be one
// list. A route on one side only is either a page the tool offers and the
// gateway refuses (a run spends a call to learn it) or an egress the gateway
// allows that no tool reviewed.
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createPublicSourceGatewayHandler,
  PUBLIC_SOURCE_ALLOWED_HOSTS,
  PUBLIC_SOURCE_OFFICIAL_DOCUMENT_PATHS,
} from "../src/publicSourceGateway.mjs";

const execFile = promisify(execFileCallback);
const mcpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../runtime/mcp/evimed-research");

async function runtimeOfficialPaths() {
  // Asked of the module, not grepped out of its text: the list is whatever the
  // tool actually validates against.
  const script = "import json,sys; sys.path.insert(0, '.'); import official_pages; print(json.dumps({h: list(p) for h, p in official_pages.OFFICIAL_PATHS.items()}))";
  const { stdout } = await execFile("python3", ["-c", script], { cwd: mcpDir });
  return JSON.parse(stdout);
}

test("the research server and the gateway approve exactly the same official pages", async () => {
  const runtime = await runtimeOfficialPaths();
  const gateway = Object.fromEntries([...PUBLIC_SOURCE_OFFICIAL_DOCUMENT_PATHS].map(([host, prefixes]) => [host, [...prefixes]]));
  assert.ok(Object.keys(runtime).length >= 16, "the runtime list did not load");
  assert.deepEqual(runtime, gateway);
  for (const host of Object.keys(runtime)) {
    assert.ok(PUBLIC_SOURCE_ALLOWED_HOSTS.has(host), `${host} is an official page host the gateway does not allow at all`);
  }
  // The authorities that answer a JavaScript challenge or a firewall rather
  // than their document are absent on purpose (measured 2026-09-18); adding
  // one back needs a new measurement, not an edit.
  for (const host of ["www.nmpa.gov.cn", "www.cde.org.cn", "www.nhc.gov.cn", "www.chictr.org.cn", "bnf.nice.org.uk"]) {
    assert.equal(host in runtime, false, `${host} was not measured as reachable with one plain GET`);
  }
});

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

function runtimeManager() {
  return { assertActiveModelGatewayToken: (token) => { if (token !== "runtime-token") throw new Error("invalid token"); return { userId: "u", projectId: "p" }; } };
}

async function gatewayRequest(base, body) {
  return fetch(`${base}/internal/sources/v1/fetch`, {
    method: "POST",
    headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a host with an API and official pages keeps both, each on its own paths", async (t) => {
  // DailyMed: the connector searches `/dailymed/services/v2/` as JSON and
  // `official_page_fetch` preserves `/dailymed/drugInfo.cfm` as HTML. Listing
  // the pages used to forbid every other request to the host.
  const fetched = [];
  const server = createServer(createPublicSourceGatewayHandler({}, runtimeManager(), {
    fetchImpl: async (url, options) => {
      fetched.push(String(url));
      const html = options.headers.accept === "text/html";
      return new Response(html ? "<main><h1>Label</h1><p>BOXED WARNING</p></main>" : JSON.stringify({ data: [] }), {
        headers: { "content-type": html ? "text/html; charset=utf-8" : "application/json" },
      });
    },
  }));
  const base = await listen(server);
  t.after(() => server.close());

  const search = await gatewayRequest(base, { url: "https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name=metformin", accept: ["application/json"] });
  assert.equal(search.status, 200);
  const label = await gatewayRequest(base, { url: "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=56d13a1c-b289-4528-b23c-60f5427b4552", accept: ["text/html"] });
  assert.equal(label.status, 200);
  assert.match(await label.text(), /BOXED WARNING/);

  const htmlOnApi = await gatewayRequest(base, { url: "https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json", accept: ["text/html"] });
  assert.equal((await htmlOnApi.json()).error.code, "public_source_document_path_forbidden");
  const jsonOnPage = await gatewayRequest(base, { url: "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=x", accept: ["application/json"] });
  assert.equal((await jsonOnPage.json()).error.code, "public_source_api_path_forbidden");
  const elsewhere = await gatewayRequest(base, { url: "https://dailymed.nlm.nih.gov/dailymed/archives/index.cfm", accept: ["application/json"] });
  assert.equal((await elsewhere.json()).error.code, "public_source_api_path_forbidden");
  assert.equal(fetched.length, 2, "only the two approved requests reached the upstream");
});

test("the new authorities are reachable on their document paths and nowhere else", async (t) => {
  let calls = 0;
  const server = createServer(createPublicSourceGatewayHandler({}, runtimeManager(), {
    fetchImpl: async () => {
      calls += 1;
      return new Response("<main><h1>Official</h1><p>Recommendation text.</p></main>", { headers: { "content-type": "text/html" } });
    },
  }));
  const base = await listen(server);
  t.after(() => server.close());
  for (const url of [
    "https://www.nice.org.uk/guidance/ng136/chapter/Recommendations",
    "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/aspirin-to-prevent-cardiovascular-disease-preventive-medication",
    "https://www.sign.ac.uk/guidelines/management-of-chronic-pain/",
    "https://www.who.int/publications/i/item/9789240118164",
    "https://www.ema.europa.eu/en/medicines/human/EPAR/ozempic",
    "https://www.fda.gov/drugs/drug-safety-communications/fda-removes-risk-evaluation-and-mitigation-strategy-rems-program-antipsychotic-drug-clozapine",
    "https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=020357",
    "https://www.gov.cn/zhengce/zhengceku/202509/content_7039760.htm",
  ]) {
    const response = await gatewayRequest(base, { url, accept: ["text/html"] });
    assert.equal(response.status, 200, url);
  }
  for (const url of [
    "https://www.nice.org.uk/about",
    "https://www.fda.gov/news-events/press-announcements",
    "https://www.gov.cn/yaowen/index.htm",
    "https://www.who.int/news",
  ]) {
    const response = await gatewayRequest(base, { url, accept: ["text/html"] });
    assert.equal((await response.json()).error.code, "public_source_document_path_forbidden", url);
  }
  assert.equal(calls, 8);
});
