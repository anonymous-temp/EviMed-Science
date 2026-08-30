#!/usr/bin/env node
/**
 * Brief geo-001: the measurement half, run for real through the real gateway.
 *
 * Resumable by construction. Every round is appended to the ledger the moment
 * it returns, and a round already measured is skipped on restart — the probe
 * serves one caller at a time and a full sweep takes many minutes, so an
 * interruption that lost the finished rounds would make this unrepeatable in
 * practice.
 *
 * A failed round is written too, marked as failed, and is NOT skipped on
 * resume. That is the point: a cached failure replayed on resume is the exact
 * defect this capability warns runs about.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createGeoProbeGatewayHandler, GEO_PROBE_GATEWAY_PATH } from
  "../../apps/server/src/geoProbeGateway.mjs";

// Two sets, because the first one cannot answer the question it looks like it
// answers. Every branded question names the product, so the model has to say
// the name back — a 25/25 mention rate there measures the question set, not the
// brand's visibility. The unbranded set is how a patient actually asks, and it
// is the only one where "did we come up" has content.
const SETS = {
  branded: [
    "速效救心丸可以长期服用吗？",
    "速效救心丸和硝酸甘油有什么区别？",
    "速效救心丸饭前吃还是饭后吃？",
    "心绞痛发作时含服几粒速效救心丸？",
    "速效救心丸能预防心梗吗？",
  ],
  unbranded: [
    "胸闷气短心慌吃什么中成药？",
    "冠心病心绞痛平时含服什么药应急？",
    "家里给老人常备哪种救心药比较好？",
    "突然心口疼含什么药能缓解？",
    "心绞痛发作时应该怎么办？",
  ],
};
const SET_NAME = process.argv[2] ?? "branded";
const QUESTIONS = SETS[SET_NAME];
if (!QUESTIONS) {
  console.error(`unknown question set "${SET_NAME}"; known: ${Object.keys(SETS).join(", ")}`);
  process.exit(2);
}
const PLATFORMS = ["deepseek", "doubao", "kimi", "qianwen", "yuanbao"];
const BRAND = "速效救心丸";
const COMPETITORS = ["复方丹参滴丸", "麝香保心丸", "硝酸甘油", "稳心颗粒", "通心络"];

// Ledgers land under results/<run-id>/, not beside the script: a second run is
// a second directory, and a sweep that overwrote the first one would destroy
// the only thing the next round has to compare against.
const runId = process.env.GEO_RUN_ID ?? "2026-08-30-geo-001";
const runDir = path.join(path.dirname(new URL(import.meta.url).pathname), "results", runId);
const ledgerPath = path.join(runDir, SET_NAME === "branded" ? "geo-probe-log.jsonl" : `geo-probe-log.${SET_NAME}.jsonl`);

import { mkdirSync } from "node:fs";
mkdirSync(runDir, { recursive: true });

const handler = createGeoProbeGatewayHandler({
  geoProbeUrl: process.env.OPEN_SCIENCE_GEO_PROBE_URL,
  geoProbeAllowPlaintext: process.env.OPEN_SCIENCE_GEO_PROBE_ALLOW_PLAINTEXT === "1",
  geoProbeTimeoutMs: 400000,
}, { assertActiveModelGatewayToken() {} });

function response() {
  const chunks = [];
  return {
    statusCode: 0,
    writeHead(status) { this.statusCode = status; },
    end(chunk) { if (chunk) chunks.push(chunk); this.body = Buffer.concat(chunks).toString("utf8"); },
  };
}

async function call(body) {
  const payload = JSON.stringify(body);
  const stream = (async function* () { yield Buffer.from(payload, "utf8"); })();
  const res = response();
  await handler({
    method: "POST",
    url: GEO_PROBE_GATEWAY_PATH,
    headers: { authorization: "Bearer local-sweep" },
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
  }, res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

function measuredAlready() {
  if (!existsSync(ledgerPath)) return new Set();
  const keys = new Set();
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.inDenominator === true) keys.add(`${row.question} ${row.provider}`);
    } catch {
      // A half-written line from a kill. The round it belonged to is simply not
      // marked done, so the loop below asks it again.
    }
  }
  return keys;
}

const ready = await call({ op: "providers" });
if (ready.status !== 200) {
  console.error(`providers unreachable: ${ready.status} ${ready.body.code}`);
  process.exit(1);
}
console.log(`ready: ${ready.body.data.ready.join(", ")}`);
const notReady = ready.body.data.providers.filter((row) => !row.ready).map((row) => row.provider);
if (notReady.length) console.log(`NOT ready (never asked, not silent): ${notReady.join(", ")}`);

const already = measuredAlready();
const total = QUESTIONS.length * PLATFORMS.length;
console.log(`set "${SET_NAME}": ledger holds ${already.size} measured round(s); ${total - already.size} to go`);
console.log("");

for (const question of QUESTIONS) {
  for (const provider of PLATFORMS) {
    if (already.has(`${question} ${provider}`)) {
      console.log(`  skip  ${provider.padEnd(9)}          ${question.slice(0, 16)}`);
      continue;
    }
    const started = Date.now();
    // A busy probe means WAIT, not "no answer" — the skill says so and the
    // first version of this script ignored it. A client-side timeout does not
    // free the single slot, so the killed request kept working server-side and
    // ten consecutive rounds came back 409 in one second. The loop finished and
    // printed "sweep complete" having measured none of them: the harness had
    // the defect it was built to detect.
    let out = await call({ op: "ask", question, providers: [provider] });
    for (let attempt = 0; attempt < 20 && out.body.code === "geo_probe_busy"; attempt += 1) {
      process.stdout.write(`  wait  ${provider.padEnd(9)} probe busy, holding 30s (${attempt + 1}/20)\n`);
      await new Promise((resolve) => setTimeout(resolve, 30000));
      out = await call({ op: "ask", question, providers: [provider] });
    }
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const row = out.body.data?.results?.[0];
    const record = row
      ? {
          question,
          provider,
          status: row.status,
          inDenominator: row.inDenominator,
          surface: out.body.data.surface,
          latencyMs: row.latencyMs,
          answerDigest: row.answerDigest,
          answerChars: row.answer.length,
          citations: row.citations.length,
          // The URLs, not just the count. Whether a platform cites the label
          // and a guideline or cites three content farms is the finding; a
          // count cannot tell those apart, and the first version of this script
          // kept only the count.
          citedUrls: row.citations.map((entry) => entry.url).filter(Boolean),
          screenshotName: row.screenshotName,
          // Recomputable facts kept beside the digest, so a later recount does
          // not have to re-fetch the answer to check them.
          mentionsBrand: row.answer.includes(BRAND),
          competitorsMentioned: COMPETITORS.filter((name) => row.answer.includes(name)),
          answer: row.answer,
          error: row.error,
          at: new Date().toISOString(),
        }
      : {
          question,
          provider,
          status: "failed",
          inDenominator: false,
          surface: { mode: "default", session: "new_chat" },
          error: `${out.body.code}: ${out.body.error}`,
          at: new Date().toISOString(),
        };
    appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
    const detail = record.inDenominator
      ? `brand=${record.mentionsBrand ? "Y" : "n"} comp=${record.competitorsMentioned.length} cite=${record.citations}`
      : String(record.error ?? "").slice(0, 52);
    console.log(`  ${record.inDenominator ? "ok  " : "FAIL"}  ${provider.padEnd(9)} ${elapsed.padStart(6)}s  ${detail.padEnd(28)} ${question.slice(0, 16)}`);
  }
}
// "The loop finished" and "everything was measured" are different facts, and
// the first version of this script printed the second when it meant the first.
const finished = measuredAlready();
console.log("");
if (finished.size === total) {
  console.log(`sweep complete: ${total}/${total} measured`);
} else {
  console.log(`sweep INCOMPLETE: ${finished.size}/${total} measured, ${total - finished.size} still unmeasured. Re-run to resume.`);
  process.exitCode = 1;
}
