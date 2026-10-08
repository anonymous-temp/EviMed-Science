#!/usr/bin/env node
/**
 * The independent verifier's reply, as an eval (principle 6; design reference §8.6 and E-10).
 *
 * The verifier writes a file for the control plane and replies to a researcher. Its reply once printed the file's name, its fields and
 * its verdict words (owner screenshots of 2026-10-08). This runs the prompt that ships — `verificationPrompt(verificationBrief(claim))` —
 * against the live model in a small tool loop that stands in for the runtime: `open_source` returns the case's invented source text,
 * `write_file` keeps what the verifier writes. A case passes a run when
 *
 *   1. the reply names none of the file's vocabulary (`check_reply.mjs`, read from the same list the instruction is built from), and
 *   2. the file the verifier wrote still parses as the control plane reads it (`parseVerificationResult`).
 *
 * The verifier's wording, language choice and verdict are not judged: the first is language, the second belongs to the claim, and the
 * third is a matter for the verification suites. Nothing is metered (no usage ledger) and nothing is written but the result file.
 *
 *   node evals/autopilot-verification-reply/run_eval.mjs [--runs 3] [--key-file <path>] [--model <name>] [--base-url <url>] [--only <case-id>]
 *
 * To judge a change to the instruction: run it with the instruction removed (`--without-reply-instruction`) as the control, then with it.
 * The control is the point — a reply that is clean without the instruction proves the case is too easy, not that the instruction works.
 *
 * Which model capability would make this deletable: a verifier whose reply is built from its file by the control plane rather than
 * written by the model, after which there is no reply to keep clean.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseVerificationResult, verificationBrief, verificationPrompt, VERIFICATION_ARTIFACT } from "../../apps/server/src/autopilotService.mjs";
import { backstageWordsIn } from "./check_reply.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    "key-file": { type: "string", default: resolve(here, "../../../.evimed-local/secrets/deepseek.api-key") },
    model: { type: "string", default: "deepseek-chat" },
    "base-url": { type: "string", default: "https://api.deepseek.com" },
    only: { type: "string" },
    "without-reply-instruction": { type: "boolean", default: false },
  },
});
const runs = Math.max(1, Math.min(10, Number(values.runs) || 3));
const apiKey = (await readFile(values["key-file"], "utf8")).trim();
if (!apiKey) throw new Error("The DeepSeek key file is empty.");
const { cases } = JSON.parse(await readFile(join(here, "cases.json"), "utf8"));

const tools = [
  { type: "function", function: { name: "open_source", description: "Open one of the listed sources and read its text.",
    parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"] } } },
  { type: "function", function: { name: "write_file", description: "Write a file in the workspace root.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
];

/** The shipped instruction, or — for the control arm — the same prompt with its reply paragraph removed. */
function promptFor(/** @type {any} */ item) {
  const prompt = verificationPrompt(verificationBrief(item.claim));
  if (!values["without-reply-instruction"]) return prompt;
  const at = prompt.indexOf("Your reply is read by the researcher");
  return at < 0 ? prompt : prompt.slice(0, at).trimEnd();
}

/** One verifier, run to its final reply (at most eight model calls). */
async function verify(/** @type {any} */ item) {
  const messages = [{ role: "user", content: promptFor(item) }];
  /** @type {Map<string, string>} */ const files = new Map();
  for (let step = 0; step < 8; step += 1) {
    const response = await fetch(`${values["base-url"]}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: values.model, messages, tools, max_tokens: 2000 }),
    });
    if (!response.ok) throw new Error(`model_http_${response.status}`);
    const message = (await response.json()).choices?.[0]?.message;
    if (!message) throw new Error("model_empty");
    messages.push({ role: "assistant", content: message.content ?? "", ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) });
    if (!message.tool_calls?.length) return { reply: String(message.content ?? ""), files };
    for (const call of message.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* a malformed call is answered as one */ }
      let result = "error: unknown tool";
      if (call.function.name === "open_source") result = item.claim.sources.includes(args.source) ? item.sourceText : "error: not one of the listed sources";
      if (call.function.name === "write_file") { files.set(String(args.path ?? ""), String(args.content ?? "")); result = "ok"; }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  return { reply: "", files, error: "no_final_reply" };
}

/** @type {any[]} */
const results = [];
for (const item of cases.filter((/** @type {{ id: string }} */ candidate) => !values.only || candidate.id === values.only)) {
  const answers = [];
  for (let run = 0; run < runs; run += 1) {
    try {
      const { reply, files, error } = await verify(item);
      const written = files.get(VERIFICATION_ARTIFACT);
      let parsed = null;
      try { parsed = written === undefined ? null : parseVerificationResult(JSON.parse(written)); } catch { parsed = null; }
      const leaked = backstageWordsIn(reply);
      answers.push({ ok: !error && leaked.length === 0 && parsed !== null && !("errorCode" in parsed), leaked, fileParsed: parsed !== null && !("errorCode" in parsed),
        ...(error ? { error } : {}), reply });
    } catch (error) {
      answers.push({ ok: false, error: /** @type {any} */ (error)?.message ?? "verifier_failed", leaked: [], fileParsed: false, reply: "" });
    }
  }
  const passed = answers.filter((answer) => answer.ok).length;
  results.push({ id: item.id, passed, runs, answers, why: item.why });
  console.log(`${passed === runs ? "PASS" : "FAIL"} ${item.id} ${passed}/${runs} ${JSON.stringify(answers.map((answer) => answer.error ?? (answer.leaked.length ? `leaked:${answer.leaked.join("+")}` : answer.fileParsed ? "clean" : "file-unreadable")))}`);
}
const total = results.reduce((sum, result) => sum + result.runs, 0);
const passed = results.reduce((sum, result) => sum + result.passed, 0);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
await mkdir(join(here, "results"), { recursive: true });
const arm = values["without-reply-instruction"] ? "control" : "shipped";
const file = join(here, "results", `run-${stamp}-${arm}.json`);
await writeFile(file, `${JSON.stringify({ at: new Date().toISOString(), arm, model: values.model, runs, passed, total, results }, null, 1)}\n`);
console.log(`${passed}/${total} replies clean with a readable file (${arm}); ${results.filter((result) => result.passed === result.runs).length}/${results.length} cases in every run → ${file}`);
