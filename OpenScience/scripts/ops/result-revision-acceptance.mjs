/** Hosted T08 acceptance, invoked by capability-acceptance --result-revisions.
 * Requires a deployed candidate manifest. No responses, outputs or producer facts are mocked.
 * Secrets use the existing acceptance password-file convention and never enter evidence.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
/* global sessionStorage, localStorage, HTMLTextAreaElement, document, window */

const execute = promisify(execFile);
const sha = value => createHash("sha256").update(value).digest("hex");
const STUDIES = [{ id: "A", label: "Synthetic A", yi: 0, vi: 0.1 }, { id: "B", label: "Synthetic B", yi: 1, vi: 0.1 }, { id: "C", label: "Synthetic C", yi: 3, vi: 0.1 }];
const PUBLIC_SOURCE = "https://medlineplus.gov/clinicaltrials.html";
export const REVISION_JOURNEYS = [
  { id: "forest-restyle", target: "forest.svg", selection: "figure", numerical: "identical", instruction: "Only restyle the forest SVG: use larger readable labels and a monochrome palette; retain all estimates, study identities and citations. Recalculate meta.dl from the exact unchanged aggregate JSON using research_calculate to establish unchanged numbers. Write forest.svg plus report.md/report.docx/report.pdf under the supplied outputDirectory. Include the exact marker STYLE-ONLY in all three report formats." },
  { id: "add-study", target: "studies.csv", selection: "table-cell", numerical: "changed", instruction: "Add one synthetic aggregate study D with yi=2 and vi=0.1 to a new aggregate JSON. Use research_calculate meta.dl on this four-study input; do not calculate statistics with a language model or shell replacement. Create a revised studies.csv, SVG and report.md/report.docx/report.pdf under the supplied outputDirectory. Explain the added study and changed pooled estimate; include ADD-STUDY in all three report formats." },
  { id: "correct-conclusion", target: "report.md", selection: "text", numerical: "identical", instruction: "Correct the selected deliberately unsupported claim using the already preserved NIH public source, naming its exact preserved path and SHA-256 in the revised report. Do not fetch a substitute or change study data. Explain uncertainty and quote the supporting preserved passage. Recalculate unchanged meta.dl via research_calculate to establish unchanged numbers. Write revised report.md/report.docx/report.pdf under the supplied outputDirectory and include CORRECT-CLAIM in all three formats." },
];

export function assertCandidate(manifest, health, ready, expectedRevision) {
  assert.match(expectedRevision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.source.revision, expectedRevision, "local manifest is not the requested candidate");
  assert.ok(manifest.app.releaseId && manifest.runtime.image, "candidate manifest lacks release/runtime identity");
  assert.match(manifest.runtime.imageId, /^sha256:[a-f0-9]{64}$/, "candidate lacks immutable runtime image identity");
  const replay = manifest.services?.find(service => service.name === "result-replay");
  assert.ok(replay?.image, "candidate manifest lacks the deterministic replay service");
  assert.match(replay.imageId, /^sha256:[a-f0-9]{64}$/, "candidate lacks immutable replay image identity");
  assert.equal(health.releaseId, manifest.app.releaseId, "host is serving a different release; no mutation authorized");
  assert.equal(ready.ok, true, "candidate readiness is not healthy");
  const release = ready.checks?.release ?? ready.release;
  assert.equal(release?.ok, true, "candidate release readiness is unavailable");
  const details = release.details ?? release.value ?? release;
  assert.equal(details.releaseId, manifest.app.releaseId);
  assert.equal(details.revision, expectedRevision.slice(0, 12));
}
export function promptProof(frame) {
  if (frame?.type === "open" && frame.endpoint === "session/prompt") {
    const request = frame.payload?.args?.request;
    if (!request?.sessionId || !request.requestId || !Array.isArray(request.content)) return null;
    const text = request.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    return { sessionId: request.sessionId, requestId: request.requestId, instructionDigest: sha(text), referenceId: request.evimedResultRevision?.referenceId ?? null };
  }
  if (frame?.type === "client-request" && frame.method === "session/prompt") return promptProof({ type: "open", endpoint: frame.method, payload: frame.payload });
  return null;
}
export function assertNumerical(before, after, expected) {
  assert.ok(before.machineValues?.length && after.machineValues?.length, "empty figure metadata cannot prove numerical consistency");
  const values = version => Object.fromEntries(version.machineValues.map(item => [item.key, { value: item.value, unit: item.unit ?? null }]));
  const left = values(before); const right = values(after);
  assert.equal(before.code?.id, "meta.dl"); assert.equal(after.code?.id, "meta.dl");
  assert.ok(Number.isFinite(left["values.pooled_effect"]?.value) && Number.isFinite(right["values.pooled_effect"]?.value));
  if (expected === "identical") assert.deepEqual(right, left);
  else { assert.notEqual(right["values.pooled_effect"].value, left["values.pooled_effect"].value, "adding one aggregate study did not change the pooled estimate"); assert.ok(Math.abs(right["values.pooled_effect"].value - 1.5) < 1e-10, "four equal-variance synthetic studies have pooled effect 1.5"); }
}
export function assertSuccessor(original, successor, run, prompt) {
  assert.equal(successor.projectId, original.projectId);
  assert.equal(successor.supersedesVersionId, original.versionId, "output lacks trusted ancestry");
  assert.equal(successor.producer.runId, run.id);
  assert.equal(successor.producer.sessionId, prompt.sessionId);
  assert.ok(run.kernelRequestIds?.includes(prompt.requestId), "result was not produced by the submitted native request");
  assert.ok(successor.inputs.some(input => input.versionId === original.versionId && input.digest === original.digest));
  assert.ok(successor.path.startsWith(`artifacts/result-revisions/${prompt.referenceId}/output/`));
}
export function assertStaging(status, input, stage, original, projectId, selection) {
  assert.equal(status, 201, "immutable selection staging failed");
  assert.equal(input.projectId, projectId); assert.equal(input.digest, original.digest);
  assert.equal(input.anchor.elementKind ?? input.anchor.kind, selection);
  assert.ok(stage?.draft && /^rr_[a-f0-9]{64}$/.test(stage.referenceId), "native selection staging failed");
}

function required(name) { const value = process.env[name]?.trim(); assert.ok(value, `${name} is required`); return value; }
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function runResultRevisionAcceptance(args) {
  const base = String(args.base ?? required("OPEN_SCIENCE_ACCEPTANCE_BASE_URL")).replace(/\/+$/, "");
  const manifest = JSON.parse(await readFile(String(args["candidate-manifest"] ?? required("OPEN_SCIENCE_ACCEPTANCE_CANDIDATE_MANIFEST")), "utf8"));
  const expectedRevision = String(args["expected-revision"] ?? required("OPEN_SCIENCE_ACCEPTANCE_EXPECTED_REVISION"));
  const timeout = Number(args["timeout-ms"] ?? 1_800_000);
  assert.ok(Number.isSafeInteger(timeout) && timeout >= 60_000 && timeout <= 7_200_000, "use a bounded 1–120 minute per-turn timeout");
  const out = path.resolve(String(args.out ?? `/tmp/evimed-result-revision-${Date.now()}`));
  await mkdir(out, { recursive: true, mode: 0o700 });
  await execute("pdftotext", ["-v"], { timeout: 10_000 });
  await execute("python3", ["--version"], { timeout: 10_000 });
  const report = { base, expectedRevision, releaseId: manifest.app.releaseId, runtimeImage: manifest.runtime.image,
    runtimeImageId: manifest.runtime.imageId, replayService: manifest.services?.find(service => service.name === "result-replay"),
    startedAt: new Date().toISOString(), scope: "actual-hosted-native-revision", scientificApplicability: "not_assessed", journeys: [], accepted: false };
  const require = createRequire(import.meta.url);
  const { chromium } = require(required("OPEN_SCIENCE_PLAYWRIGHT_CORE"));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.OPEN_SCIENCE_WALK_CHROMIUM ? { executablePath: process.env.OPEN_SCIENCE_WALK_CHROMIUM } : {}) });
  let context;
  try {
    context = await browser.newContext({ ignoreHTTPSErrors: Boolean(args.insecure), locale: "zh-CN", viewport: { width: 1512, height: 945 } });
    const health = await context.request.get(`${base}/api/health`); const ready = await context.request.get(`${base}/api/ready`);
    assert.equal(health.status(), 200); assert.equal(ready.status(), 200);
    assertCandidate(manifest, (await health.json()).data, (await ready.json()).data, expectedRevision);
    report.candidateVerified = true;
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: process.env.OPEN_SCIENCE_ACCEPTANCE_USERNAME ?? "cdss-access",
      password: (await readFile(required("OPEN_SCIENCE_ACCEPTANCE_PASSWORD_FILE"), "utf8")).trim() } });
    assert.equal(login.status(), 200, "acceptance login failed");
    const csrf = (await login.json()).data.csrfToken;
    assert.ok(typeof csrf === "string" && csrf, "login returned no CSRF token");
    const projectId = String(args.project ?? `acceptance-result-revision-${Date.now().toString(36)}`);
    const headers = { "x-open-science-csrf": csrf, "x-open-science-project": projectId };
    const api = async (route, data) => {
      const response = data === undefined ? await context.request.get(`${base}${route}`, { headers, timeout: 30_000 }) : await context.request.post(`${base}${route}`, { headers, data, timeout: 30_000 });
      if (!response.ok()) throw Object.assign(new Error(`${route.split("?")[0]} returned ${response.status()}`), { status: response.status() });
      return (await response.json()).data;
    }
    const existing = await api("/api/projects");
    if (!existing.some(project => project.id === projectId)) {
      const created = await context.request.post(`${base}/api/projects`, { headers, data: { id: projectId, name: "Result revision acceptance" }, timeout: 30_000 });
      const body = await created.json();
      assert.ok(created.ok() || created.status() === 409 && body.code === "project_exists", `acceptance project creation returned ${created.status()}`);
    }
    report.projectId = projectId;
    await context.addInitScript(id => { sessionStorage.setItem("openScience.projectId", id); localStorage.setItem("openScience.projectId", id); }, projectId);
    const page = await context.newPage(); const sent = []; const refused = new Map();
    page.on("websocket", socket => {
      const streams = new Map();
      socket.on("framesent", event => { try { const frame = JSON.parse(String(event.payload)); const proof = promptProof(frame); if (proof) { sent.push(proof); streams.set(frame.streamId, proof.requestId); } } catch { /* unrelated native frame */ } });
      socket.on("framereceived", event => { try { const frame = JSON.parse(String(event.payload)); const requestId = streams.get(frame.streamId); if (frame.type === "error" && requestId) refused.set(requestId, String(frame.error?.code ?? "native_error").slice(0, 100)); } catch { /* unrelated native frame */ } });
    });
    page.on("request", request => { if (/\/session\/prompt$/.test(new URL(request.url()).pathname)) { try { const proof = promptProof(request.postDataJSON()); if (proof) sent.push(proof); } catch { /* not a JSON native prompt */ } } });
    page.on("response", response => { if (response.status() >= 400 && /\/session\/prompt$/.test(new URL(response.url()).pathname)) { try { const proof = promptProof(response.request().postDataJSON()); if (proof) refused.set(proof.requestId, `http_${response.status()}`); } catch { /* unrelated response */ } } });
    const composer = async () => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        for (const frame of page.frames().filter(candidate => /\/__evimed\/f\//.test(candidate.url()))) {
          const input = frame.locator("[data-composer-input][contenteditable='true']").filter({ visible: true }).first();
          if (await input.count()) return input;
        }
        await sleep(1000);
      }
      throw new Error("native composer did not load within three minutes");
    }
    const submit = async (text, draft = null) => {
      const input = await composer();
      if (draft) { const existingDraft = await input.evaluate(node => node instanceof HTMLTextAreaElement ? node.value : node.innerText); assert.ok(existingDraft?.includes("修改要求："), "immutable selection draft was not delivered"); await input.fill(draft + text); }
      else await input.fill(text);
      const index = sent.length; await input.press("Control+Enter");
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && sent.length === index) await sleep(250);
      assert.ok(sent.length > index, "native composer did not transmit session/prompt");
      return sent[index];
    }
    const completed = async prompt => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        assert.ok(!refused.has(prompt.requestId), `native prompt was refused (${refused.get(prompt.requestId)})`);
        let runs;
        try { runs = await api("/api/agent-runs"); }
        catch (error) { if (error.status && ![408, 429, 502, 503, 504].includes(error.status)) throw error; await sleep(3000); continue; }
        assert.ok(Array.isArray(runs), "agent-runs did not return its documented data array");
        const run = runs.find(entry => entry.sessionId === prompt.sessionId && entry.kernelRequestIds?.includes(prompt.requestId));
        if (run && ["succeeded", "failed", "cancelled", "canceled", "timed_out"].includes(run.status)) {
          assert.equal(run.status, "succeeded", "native turn did not finish successfully"); return run;
        }
        await sleep(3000);
      }
      throw new Error("native turn remains pending at the bounded observation deadline; it was not canceled");
    }
    const versions = async () => {
      const items = []; let cursor = null; const seen = new Set();
      do { const value = await api(`/api/results?${new URLSearchParams({ projectId, limit: "100", ...(cursor ? { cursor } : {}) })}`); items.push(...value.items); cursor = value.nextCursor;
        assert.ok(!cursor || !seen.has(cursor), "result cursor did not advance"); if (cursor) seen.add(cursor);
      } while (cursor); return items;
    }
    const raw = async version => {
      const response = await context.request.get(`${base}/api/results/${version.versionId}/raw?projectId=${encodeURIComponent(projectId)}`, { headers, timeout: 30_000 });
      assert.equal(response.status(), 200); const bytes = await response.body(); assert.equal(sha(bytes), version.digest); assert.equal(bytes.length, version.size); return bytes;
    }
    const capturedFor = async (run, predicate) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) { const captured = (await versions()).filter(value => value.producer.runId === run.id); if (predicate(captured)) return captured; await sleep(1000); }
      throw new Error("completed native outputs did not acquire immutable captures within one minute");
    }
    const workspaceBytes = async relative => {
      assert.ok(relative && !relative.startsWith("/") && !relative.split("/").includes("..") && !relative.includes("\\"), "invalid preserved workspace reference");
      const response = await context.request.get(`${base}/api/files/download/${relative.split("/").map(encodeURIComponent).join("/")}`, { headers, timeout: 30_000 });
      assert.equal(response.status(), 200, "missing actual workspace output"); return response.body();
    }
    const formats = async (directory, marker, numericValues, source) => {
      assert.equal(numericValues.length, 2, "pooled and heterogeneity machine values are required");
      const texts = {};
      for (const ext of ["md", "docx", "pdf"]) {
        const relative = `${directory}/report.${ext}`;
        const bytes = await workspaceBytes(relative);
        const file = path.join(out, `${sha(directory).slice(0, 8)}-report.${ext}`); await writeFile(file, bytes, { mode: 0o600 });
        if (ext === "md") texts[ext] = bytes.toString("utf8");
        else if (ext === "pdf") { assert.equal(bytes.subarray(0, 5).toString(), "%PDF-"); texts[ext] = (await execute("pdftotext", ["-layout", file, "-"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
        else { texts[ext] = (await execute("python3", ["-c", "import sys,zipfile,xml.etree.ElementTree as E\nz=zipfile.ZipFile(sys.argv[1]); name='word/document.xml'; assert z.getinfo(name).file_size<=2*1024*1024\nr=E.fromstring(z.read(name)); ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}\nprint('\\n'.join(''.join(t.text or '' for t in p.findall('.//w:t',ns)) for p in r.findall('.//w:p',ns)))", file], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
        assert.ok(texts[ext].includes(marker), `${ext} lacks revision marker`);
        for (const value of numericValues) assert.ok(texts[ext].includes(Number(value).toFixed(6)), `${ext} lacks six-decimal machine value ${Number(value).toFixed(6)}`);
        const compact = texts[ext].replace(/\s+/g, "");
        assert.ok(compact.includes(source.path.replace(/\s+/g, "")) && compact.includes(source.sha256), `${ext} lost the preserved source identity`);
        if (marker === "CORRECT-CLAIM") assert.ok(texts[ext].replace(/\s+/g, " ").includes(source.quote.replace(/\s+/g, " ")), `${ext} lacks the byte-supported preserved quotation`);
      }
      return Object.fromEntries(Object.entries(texts).map(([ext, text]) => [ext, { textDigest: sha(text), markerPresent: true, machineValuesPresent: true }]));
    }
    for (const journey of REVISION_JOURNEYS) {
      const entry = { id: journey.id, status: "running", steps: {} }; report.journeys.push(entry);
      try {
        const directory = `acceptance/${journey.id}`;
        await api("/api/files/upload", { path: `${directory}/aggregate.json`, data: Buffer.from(JSON.stringify({ studies: STUDIES })).toString("base64"), encoding: "base64" });
        await page.goto(`${base}/app/chat`, { waitUntil: "domcontentloaded" });
        const originalPrompt = await submit(`Create a small synthetic three-study meta-analysis demonstration, never medical advice. Input ${directory}/aggregate.json contains studies {id,label,yi,vi}. Use research_calculate meta.dl and wait for its actual completed result; preserve its output. Write ${directory}/studies.csv and ${directory}/forest.svg using native file write tools so they have immutable captures. Use web_read to preserve ${PUBLIC_SOURCE}; retain its returned markdownPath and artifactSha256s[markdownPath], not the original HTML hash. Write ${directory}/source-evidence.json as {path:preservedMarkdownPath,sha256:preservedMarkdownHash,quote:one exact preserved passage explaining what clinical trials test}. Write ${directory}/report.md containing this deliberately unsupported sentence verbatim for a subsequent correction exercise: Clinical trials always prove that a treatment works. Clearly label that sentence as an unverified exercise claim, not a medical conclusion. Render report.docx and report.pdf alongside Markdown. Include marker ORIGINAL and pooled_effect/tau_squared to six decimals, and the source path/hash in all report formats. Keep this task bounded; no literature search or new studies.`);
        entry.steps.originalPrompt = originalPrompt;
        await writeFile(path.join(out, "result-revisions.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
        const originalRun = await completed(originalPrompt); const initial = await capturedFor(originalRun, captured => captured.some(value => value.path === `${directory}/${journey.target}`) && captured.some(value => value.code?.id === "meta.dl" && value.machineValues?.length));
        const original = initial.find(value => value.path === `${directory}/${journey.target}`);
        const before = initial.find(value => value.code?.id === "meta.dl" && value.machineValues?.length);
        assert.ok(original && before, "native original file or actual calculation capture is missing");
        assert.equal(before.inputs.find(input => input.kind === "data")?.digest, sha(JSON.stringify({ studies: STUDIES })), "initial calculation did not use the supplied aggregate bytes");
        const source = JSON.parse((await workspaceBytes(`${directory}/source-evidence.json`)).toString());
        assert.match(source.sha256, /^[a-f0-9]{64}$/); assert.ok(typeof source.quote === "string" && source.quote.length >= 20);
        const sourceBytes = await workspaceBytes(source.path); assert.equal(sha(sourceBytes), source.sha256);
        assert.ok(source.path.startsWith(".evimed-sources/web-pages/") && sourceBytes.toString().includes(PUBLIC_SOURCE), "source is not the preserved public page");
        assert.ok(sourceBytes.toString().includes(source.quote), "the supporting quotation is absent from the preserved public source");
        const originalBytes = await raw(original);
        entry.steps.original = { versionId: original.versionId, digest: original.digest, prompt: originalPrompt, runId: originalRun.id, numericalVersionId: before.versionId, machineValues: before.machineValues };
        await writeFile(path.join(out, `${journey.id}-original-${journey.target}`), originalBytes, { mode: 0o600 });
        entry.steps.source = { ...source, originalPreserved: true };
        entry.steps.originalFormats = await formats(directory, "ORIGINAL", before.machineValues.filter(item => ["values.pooled_effect", "values.tau_squared"].includes(item.key)).map(item => item.value), source);
        await page.goto(`${base}/app/runs/${originalRun.id}/files/${original.path}?version=${original.versionId}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("combobox", { name: "结果版本", exact: true }).waitFor();
        if (journey.selection === "figure") await page.getByRole("button", { name: "选择此图修改" }).click();
        else {
          const selected = journey.selection === "table-cell" ? page.locator("td[data-result-kind='table-cell']").first() : page.locator("[data-result-rendered]").getByText("Clinical trials always prove that a treatment works.", { exact: false }).last();
          await selected.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange")); });
        }
        await page.getByRole("button", { name: "在对话中修改所选内容" }).waitFor();
        await page.screenshot({ path: path.join(out, `${journey.id}-original.png`), fullPage: true });
        const stagedResponse = page.waitForResponse(response => response.request().method() === "POST" && /\/results\/[^/]+\/revisions$/.test(new URL(response.url()).pathname));
        await page.getByRole("button", { name: "在对话中修改所选内容" }).click();
        const response = await stagedResponse;
        const stagingInput = response.request().postDataJSON();
        const staged = (await response.json()).data;
        assertStaging(response.status(), stagingInput, staged, original, projectId, journey.selection);
        const revisedPrompt = await submit(`${journey.instruction} Render pooled_effect and tau_squared to six decimals in every report format. Preserve the prior source path and hash in all formats. Read the preserved source, not a new citation.`, staged.draft);
        assert.equal(revisedPrompt.referenceId, staged.referenceId, "native prompt omitted staged immutable reference");
        entry.steps.revisionPrompt = revisedPrompt;
        await writeFile(path.join(out, "result-revisions.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
        const revisedRun = await completed(revisedPrompt); const revised = await capturedFor(revisedRun, captured => captured.some(value => value.supersedesVersionId === original.versionId && value.path.endsWith(`/${journey.target}`)) && captured.some(value => value.code?.id === "meta.dl" && value.machineValues?.length));
        const related = await api(`/api/results?${new URLSearchParams({ projectId, relatedTo: original.versionId })}`);
        const successor = related.items.find(value => value.producer.runId === revisedRun.id && value.path.endsWith(`/${journey.target}`));
        assert.ok(successor, "no actual directly linked successor result"); assertSuccessor(original, successor, revisedRun, revisedPrompt);
        assert.deepEqual(await raw(original), originalBytes, "original bytes changed"); const successorBytes = await raw(successor);
        assert.notEqual(successorBytes.toString(), originalBytes.toString(), "selected output was not revised");
        await writeFile(path.join(out, `${journey.id}-successor-${journey.target}`), successorBytes, { mode: 0o600 });
        const after = revised.find(value => value.code?.id === "meta.dl" && value.machineValues?.length); assert.ok(after, "no actual successor deterministic calculation");
        assertNumerical(before, after, journey.numerical);
        assert.deepEqual(await workspaceBytes(source.path), sourceBytes, "preserved public source was overwritten");
        const dataInput = version => version.inputs.find(input => input.kind === "data" && input.versionId);
        if (journey.numerical === "identical") assert.equal(dataInput(before)?.digest, dataInput(after)?.digest, "style/prose revision changed aggregate input");
        else { const data = dataInput(after); assert.ok(data); const input = await api(`/api/results/${data.versionId}?projectId=${projectId}`); const aggregate = JSON.parse((await raw(input)).toString()); assert.equal(aggregate.studies.length, 4); assert.deepEqual(aggregate.studies.filter(study => study.id !== "D"), STUDIES); const added = aggregate.studies.find(study => study.id === "D"); assert.ok(added); assert.equal(added.yi, 2); assert.equal(added.vi, 0.1); }
        const output = `artifacts/result-revisions/${staged.referenceId}/output`;
        entry.steps.revisedFormats = await formats(output, { "forest-restyle": "STYLE-ONLY", "add-study": "ADD-STUDY", "correct-conclusion": "CORRECT-CLAIM" }[journey.id], after.machineValues.filter(item => ["values.pooled_effect", "values.tau_squared"].includes(item.key)).map(item => item.value), source);
        const exported = await context.request.get(`${base}/api/results/${successor.versionId}/export?projectId=${projectId}`, { headers, timeout: 30_000 }); assert.equal(exported.status(), 200);
        const archive = await exported.body(); const { unzipSync } = require("../../apps/server/node_modules/fflate"); const zip = unzipSync(archive);
        const exportManifest = JSON.parse(Buffer.from(zip["manifest.json"]).toString());
        assert.equal(exportManifest.selectedVersionId, successor.versionId);
        for (const file of exportManifest.files) { assert.ok(zip[file.archivePath]); assert.equal(zip[file.archivePath].length, file.bytes); assert.equal(sha(zip[file.archivePath]), file.sha256); }
        await writeFile(path.join(out, `${journey.id}.evimed.zip`), archive, { mode: 0o600 });
        await page.goto(`${base}/app/runs/${revisedRun.id}/files/${successor.path.split("/").map(encodeURIComponent).join("/")}?version=${successor.versionId}`, { waitUntil: "domcontentloaded" });
        const comparison = page.getByRole("combobox", { name: "比较版本", exact: true });
        await comparison.waitFor(); await comparison.locator(`option[value="${original.versionId}"]`).waitFor({ state: "attached" }); await comparison.selectOption(original.versionId);
        await page.getByRole("region", { name: "版本差异" }).waitFor();
        await page.screenshot({ path: path.join(out, `${journey.id}.png`), fullPage: true });
        entry.steps.successor = { versionId: successor.versionId, digest: successor.digest, prompt: revisedPrompt, runId: revisedRun.id,
          numericalVersionId: after.versionId, machineValues: after.machineValues, exportDigest: sha(archive), exportCompleteness: exportManifest.completeness };
        entry.status = "passed";
      } catch (error) { entry.status = "failed"; entry.error = String(error.message).slice(0, 400); break; }
      finally { await writeFile(path.join(out, "result-revisions.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); }
    }
    report.accepted = report.journeys.length === 3 && report.journeys.every(entry => entry.status === "passed");
    assert.ok(report.accepted, "three actual native revision journeys did not all pass; inspect result-revisions.json");
    return report;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(out, "result-revisions.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    await context?.close(); await browser.close();
  }
}
