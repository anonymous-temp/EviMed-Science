// Types a plan's turns into the NATIVE composer of one account's conversation, in a real browser, and records what the product made of
// each: the run record, the reply, the tools. Run from the runtime image on docker's default bridge network by `host.py` (see its
// header for why); prints no secret. Env: BASE, USERNAME, PASSWORD, PLAN (a JSON file), RESULT (where to write).
//
// A turn typed here looks to the platform exactly like a person's: it is adopted from the kernel page, read by the follow-up judge,
// committed to memory when it ends and counted as evidence by the learning loop. That is the point, and also why this driver cannot
// carry the `automated` mark (the control plane learns of a native turn from the kernel's event stream, where no request header
// exists): isolation is the throwaway account, which the caller deletes at the end, and what it learnt goes with it.
//
// Plan: { project: string | null, projectName?: string | null, newConversation: boolean, stopRuntime?: boolean,
//         steps: [{ op: "turn", label, text, newConversation?: boolean, beforeMs?: number, afterMs?: number, timeoutMs?: number }] }
// Result: { turns: [{ label, text, sessionId, requestId, status, run, reply, toolNames, wallMs, error? }], error?, notes: [] },
// rewritten after every turn so a failure leaves the turns before it.
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.OPEN_SCIENCE_PLAYWRIGHT_CORE);
const base = process.env.BASE; const username = process.env.USERNAME; const password = process.env.PASSWORD;
const plan = JSON.parse(fs.readFileSync(process.env.PLAN, "utf8"));
const resultPath = process.env.RESULT;
const say = (...a) => console.log(`[driver ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ["succeeded", "failed", "cancelled", "canceled", "timed_out"];
const result = { turns: [], notes: [] };
const note = (text) => { if (result.notes.length < 80) result.notes.push(String(text).slice(0, 300)); };
const save = () => fs.writeFileSync(resultPath, JSON.stringify(result));

function promptProof(frame) {
  if (frame?.type === "open" && frame.endpoint === "session/prompt") {
    const request = frame.payload?.args?.request;
    if (!request?.sessionId || !request.requestId) return null;
    return { sessionId: request.sessionId, requestId: request.requestId };
  }
  if (frame?.type === "client-request" && frame.method === "session/prompt") return promptProof({ type: "open", endpoint: frame.method, payload: frame.payload });
  return null;
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: "/usr/bin/chromium" });
let code = 0;
try {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1512, height: 945 } });
  const project = plan.project || null;
  // The tab's project is its storage's: set before the page loads, as a project switch would.
  if (project) await context.addInitScript((id) => { try { window.sessionStorage.setItem("openScience.projectId", id); window.localStorage.setItem("openScience.projectId", id); } catch { /* storage may be unavailable on a blank page */ } }, project);
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username, password } });
  const csrf = (await login.json()).data?.csrfToken; say("login", login.status(), Boolean(csrf));
  const headers = { "x-open-science-csrf": csrf, ...(project ? { "x-open-science-project": project } : {}) };
  const get = async (route) => { const r = await context.request.get(`${base}${route}`, { headers, timeout: 60000 }); return { status: r.status(), body: await r.json().catch(() => null) }; };
  const page = await context.newPage(); const sent = []; const refused = new Map();
  page.on("websocket", (socket) => {
    const streams = new Map();
    socket.on("framesent", (event) => { try { const frame = JSON.parse(String(event.payload)); const proof = promptProof(frame); if (proof) { sent.push(proof); streams.set(frame.streamId, proof.requestId); } } catch { /* not a frame we read */ } });
    socket.on("framereceived", (event) => { try { const frame = JSON.parse(String(event.payload)); const id = streams.get(frame.streamId); if (frame.type === "error" && id) refused.set(id, String(frame.error?.code ?? "native_error").slice(0, 100)); } catch { /* not a frame we read */ } });
  });
  page.on("request", (request) => { if (/\/session\/prompt$/.test(new URL(request.url()).pathname)) { try { const proof = promptProof(request.postDataJSON()); if (proof) sent.push(proof); } catch { /* no body */ } } });
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) note(`console ${m.type()} ${m.text().slice(0, 200)}`); });
  page.on("requestfailed", (r) => note(`request failed ${r.method()} ${new URL(r.url()).pathname.replace(/\/f\/[^/]+/, "/f/<t>").slice(0, 80)} ${r.failure()?.errorText ?? ""}`));
  page.on("response", (r) => { const u = new URL(r.url()); if (r.status() >= 400 && !/\.(js|css|png|svg|woff2?)$/.test(u.pathname)) note(`http ${r.status()} ${r.request().method()} ${u.pathname.replace(/\/f\/[^/]+/, "/f/<t>").slice(0, 100)}`); });

  const t0 = Date.now();
  await page.goto(`${base}/app/chat`, { waitUntil: "domcontentloaded", timeout: 120000 });
  const composer = async () => {
    const deadline = Date.now() + 360000; let retries = 0;
    while (Date.now() < deadline) {
      const alert = page.getByText("打开超时，请重试");
      if (await alert.count() && retries < 3) {
        retries += 1; note(`open timeout shown at ${Math.round((Date.now() - t0) / 1000)}s, retry ${retries}`);
        await page.getByRole("button", { name: "重试" }).first().click().catch((e) => note(`retry click failed ${String(e).slice(0, 100)}`));
      }
      for (const frame of page.frames().filter((f) => /\/__evimed\/f\//.test(f.url()))) {
        const input = frame.locator("[data-composer-input][contenteditable='true']").filter({ visible: true }).first();
        if (await input.count()) { say("composer ready at", `${Math.round((Date.now() - t0) / 1000)}s`); return input; }
      }
      await sleep(1000);
    }
    throw new Error("native composer did not load within six minutes");
  };
  const newConversation = async () => {
    await composer();
    const before = page.url();
    // Inside a project the project row's own button; the global 「新对话」 leaves every project (owner ruling 2026-10-20).
    if (plan.projectName) await page.getByRole("button", { name: `在“${plan.projectName}”新建对话` }).first().click();
    else await page.getByText("新对话", { exact: true }).first().click();
    await sleep(4000);
    say("new conversation", "url changed", page.url() !== before);
  };
  const submit = async (text) => {
    const input = await composer(); await input.fill(text);
    const index = sent.length; await input.press("Control+Enter");
    const deadline = Date.now() + 30000; while (Date.now() < deadline && sent.length === index) await sleep(250);
    if (sent.length <= index) throw new Error("native composer did not transmit session/prompt");
    return sent[index];
  };
  const runOf = async (prompt) => {
    const runs = (await get("/api/agent-runs")).body?.data ?? [];
    return runs.find((r) => r.sessionId === prompt.sessionId && (r.kernelRequestIds ?? []).includes(prompt.requestId)) ?? null;
  };
  // A turn the model holds on a question to the person (`ask_user`, attended mode) waits for an answer this driver never gives:
  // it is read as asked — the question kept, the run cancelled — rather than as twelve minutes of "still pending".
  const pendingQuestion = async (sessionId) => {
    const tr = await get(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/transcript`);
    const items = tr.body?.data?.messages ?? [];
    const lastUser = items.map((m) => m.role).lastIndexOf("user");
    for (const part of (lastUser >= 0 ? items.slice(lastUser + 1) : items).flatMap((m) => m.parts ?? [])) {
      const tool = String(part.tool ?? part.toolName ?? part.name ?? "");
      const status = String(part.state?.status ?? part.status ?? "");
      if (/^ask[_-]user/.test(tool) && status === "pending") return JSON.stringify(part.state?.input ?? part.input ?? {}).slice(0, 600);
    }
    return null;
  };
  const completed = async (prompt, label, timeoutMs) => {
    const started = Date.now();
    let polls = 0;
    while (Date.now() - started < timeoutMs) {
      if (refused.has(prompt.requestId)) throw new Error(`prompt refused ${refused.get(prompt.requestId)}`);
      const run = await runOf(prompt);
      if (run && TERMINAL.includes(run.status)) { say(label, "run", run.id, run.status, `${Math.round((Date.now() - started) / 1000)}s`); return run; }
      polls += 1;
      if (run && Date.now() - started > 45000 && polls % 5 === 0) {
        const question = await pendingQuestion(prompt.sessionId).catch(() => null);
        if (question) {
          say(label, "asked the person", question.slice(0, 160));
          const cancel = await context.request.post(`${base}/api/agent-runs/${encodeURIComponent(run.id)}/cancel`, { headers, data: {} }).catch(() => null);
          throw Object.assign(new Error(`${label} asked the person a question (ask_user) and waits for an answer; run cancelled ${cancel ? cancel.status() : "?"}`), { asked: question });
        }
      }
      await sleep(4000);
    }
    throw new Error(`${label} still pending after ${Math.round(timeoutMs / 1000)}s`);
  };
  const replyOf = async (sessionId) => {
    const tr = await get(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/transcript`);
    const items = tr.body?.data?.messages ?? [];
    const textOf = (m) => (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("").trim();
    const lastUser = items.map((m) => m.role).lastIndexOf("user");
    const after = lastUser >= 0 ? items.slice(lastUser + 1) : items;
    const assistant = [...after].reverse().find((m) => m.role === "assistant" && textOf(m));
    const toolNames = after.flatMap((m) => (m.parts ?? []).filter((p) => /tool/.test(String(p.type))).map((p) => String(p.toolName ?? p.name ?? p.tool ?? "?")));
    return { reply: assistant ? textOf(assistant) : "", toolNames, transcriptStatus: tr.status };
  };

  let first = true;
  for (const step of plan.steps) {
    if (step.op !== "turn") throw new Error(`unknown step ${step.op}`);
    const turn = { label: step.label, text: step.text };
    result.turns.push(turn);
    try {
      if (first ? plan.newConversation : step.newConversation) await newConversation();
      first = false;
      if (step.beforeMs) await sleep(step.beforeMs);
      const started = Date.now();
      const prompt = await submit(step.text);
      Object.assign(turn, { sessionId: prompt.sessionId, requestId: prompt.requestId });
      const run = await completed(prompt, step.label, step.timeoutMs ?? 12 * 60000);
      await sleep(5000);
      Object.assign(turn, { status: run.status, run: (await runOf(prompt)) ?? run, wallMs: Date.now() - started, ...(await replyOf(prompt.sessionId)) });
      if (step.afterMs) await sleep(step.afterMs);
    } catch (error) {
      if (error?.asked) turn.asked = error.asked;
      turn.error = String(error?.message ?? error).slice(0, 300);
      result.error = `turn ${step.label}: ${turn.error}`;
      save();
      throw error;
    }
    save();
  }
  if (plan.stopRuntime !== false) { const stop = await context.request.post(`${base}/api/commands/stop_runtime`, { headers, data: {} }); say("stop_runtime", stop.status()); }
} catch (error) { code = 2; result.error ??= String(error?.message ?? error).slice(0, 300); say("ERROR", result.error); }
finally { save(); await browser.close(); }
process.exit(code);
