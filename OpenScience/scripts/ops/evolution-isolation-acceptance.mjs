// Live engineering controls only: excluded from paper scores and promotion evidence.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { socketToolResult } from "../../apps/server/src/dshRuntimeAdapter.mjs";
import { readRunTranscript } from "../../apps/server/src/runTranscripts.mjs";

const target = {
  aliases: ["10.1136/bmj.n71", "PMC8005924", "PMID:33782057"],
  titles: ["The PRISMA 2020 statement: an updated guideline for reporting systematic reviews"],
};
const url = "https://pmc.ncbi.nlm.nih.gov/articles/PMC8005924/";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Parse actual MCP and socket result envelopes; an assistant's prose is never a tool result. */
export function sourceToolResult(output) {
  if (typeof output === "string") {
    if (output.startsWith("Error: ")) {
      const parsed = sourceToolResult(output.slice(7));
      return parsed ? { ...parsed, ok: false } : { ok: false, data: null };
    }
    const socket = socketToolResult(output);
    if (socket) return socket;
    try { return sourceToolResult(JSON.parse(output)); } catch { return null; }
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  if (typeof output.ok === "boolean") return output;
  if (["ok", "success", "warning", "error"].includes(output.status)) return { ok: output.status !== "error", data: output.data, artifacts: output.artifacts };
  if (Array.isArray(output.content)) {
    const parsed = output.content.filter(part => part.type === "text").map(part => sourceToolResult(part.text)).filter(Boolean);
    if (output.isError === true) return { ok: false, data: parsed };
    if (parsed.length === 1) return parsed[0];
  }
  return null;
}
export function isTargetBody(text) {
  return typeof text === "string" && text.length > 1000 && /PRISMA/i.test(text) && /systematic reviews/i.test(text)
    && /introduction|methods|discussion/i.test(text) && !/evaluation_source_excluded|checking your browser|recaptcha/i.test(text);
}
/** Confirm bytes actually preserved by the full-text tool, not merely the request or metadata. */
export async function captureFullTextBody(project, result) {
  const data = result.data;
  if (!/^full_text_/.test(data?.contentLevel ?? "") || data.pmcid !== "PMC8005924" || typeof data.markdownPath !== "string") return null;
  const workspace = await fs.realpath(project.workspaceDir);
  const file = await fs.realpath(path.resolve(workspace, data.markdownPath));
  if (!file.startsWith(`${workspace}${path.sep}`) || (await fs.stat(file)).size > 2 * 1024 * 1024) throw new Error("Source body escaped bounded workspace capture.");
  const bytes = await fs.readFile(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (data.artifactSha256s?.[data.markdownPath] !== digest) throw new Error("Retrieved full-text bytes changed after tool preservation.");
  const text = bytes.toString("utf8");
  return isTargetBody(text) ? { sourcePath: data.markdownPath, sourceHash: digest, contentLevel: data.contentLevel, body: text } : null;
}
export function completedOutputs(transcript) {
  return (transcript.messages ?? []).flatMap(message => message.parts ?? [])
    .filter(part => part.type === "tool" && part.status === "completed" && /web_read|web_search|open_access_full_text|literature_search|public_source|pubmed|europe/i.test(part.tool ?? ""))
    .map(part => ({ tool: part.tool, output: part.output, result: sourceToolResult(part.output) }));
}
/** Call only on an already listening isolated acceptance app; uses its actual runtime and gateways.
 * @param {any} dependencies */
export async function runEvolutionIsolationAcceptance({ app, userId = "evolution-acceptance", probeId = "live-v2", signal, timeoutMs = 900000 }) {
  if (!/^[a-z0-9_-]{1,40}$/.test(probeId)) throw new Error("Invalid isolation probe identity.");
  if (!app.evolution?.runs || !app.evaluationIsolation) throw new Error("Actual evolution dispatch and isolation services are required.");
  const receipt = [];
  for (const blocked of [false, true]) {
    signal?.throwIfAborted();
    const projectId = `eval-paper-isolation-${probeId}-${blocked ? "blocked" : "leak"}`;
    const dispatchId = `evolution_isolation_${probeId}_${blocked ? "blocked" : "leak"}`;
    const started = await app.evolution.runs.dispatch({ userId, projectId, dispatchId, capabilityId: "evolution-scout",
      evaluationPolicy: blocked ? target : null,
      brief: `Engineering source-isolation control, excluded from scientific evaluation. First call the actual open_access_full_text tool with identifier PMC8005924, supplements=false, intake=false. Read its preserved markdownPath to inspect the actual article body. Also attempt web_read on ${url} (HTML, not the unsupported fullTextXML endpoint). If an upstream blocks or challenges HTML, preserve that failure and rely only on genuine full text from open_access_full_text. Also attempt web search for the exact title "${target.titles[0]}". If access succeeds, quote a sentence from the retrieved body and cite the source; if excluded, state the actual tool result. Write a short engineering-control.json artifact. Do not invent source content or tool observations.` });
    const project = await app.store.projectFor(await app.store.userById(userId), projectId);
    const deadline = Date.now() + timeoutMs;
    let run, transcript;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      run = (await app.agentRuns.list(project)).find(item => item.id === started.id);
      if (run && !["queued", "dispatching", "running"].includes(run.status)) {
        transcript = await readRunTranscript(project, run.id);
        if (transcript?.header?.completeness === "complete") break;
      }
      await delay(2000, undefined, { signal });
    }
    if (!transcript || transcript.header?.completeness !== "complete") throw new Error("Isolation control lacks a complete durable transcript.");
    const outputs = completedOutputs(transcript);
    if (!blocked) {
      // Inspect actual completed tool outputs, never the requested URL in the user prompt.
      const body = [];
      for (const row of outputs) {
        const result = row.result;
        if (result?.ok !== true) continue;
        if (/open_access_full_text/.test(row.tool)) {
          const captured = await captureFullTextBody(project, result);
          if (captured) body.push({ tool: row.tool, ...captured });
        } else if (/web_read/.test(row.tool)) {
          const text = [result.data?.text, result.data?.markdown, result.data?.content].find(value => typeof value === "string") ?? "";
          if (String(result.data?.url ?? "").includes("PMC8005924") && isTargetBody(text)) body.push({ tool: row.tool, body: text });
        }
      }
      if (!body.length) {
        const failure = { kind: "live-isolation-engineering-control", probeId, projectId, runId: run.id, runStatus: run.status,
          completeTranscript: true, transcriptHash: hash(transcript), scored: false, passed: false,
          failure: "target_full_text_not_retrieved", toolObservations: outputs.map(row => ({ tool: row.tool, ok: row.result?.ok ?? null, outputHash: hash(row.output), contentLevel: row.result?.data?.contentLevel ?? null })) };
        const directory = path.join(project.metaDir, "isolation-probes"); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(directory, `${probeId}-${run.id}-failure.json`), JSON.stringify(failure), { mode: 0o444, flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
        throw new Error("Intentional leak control did not actually retrieve the target body. Failed evidence preserved; explicitly select a fresh probeId after correcting the fetch contract.");
      }
      await app.evaluationIsolation.register(run.id, target);
      if (!await app.evaluationIsolation.auditExposure({ runId: run.id }, "intentional-live-source-output", body)) throw new Error("Actual target exposure was not detected.");
      const replies = (transcript.messages ?? []).filter(message => message.role === "assistant")
        .flatMap(message => message.parts ?? []).filter(part => part.type === "text").map(part => part.text);
      await app.evaluationIsolation.recordCitations(run.id, replies);
    }
    const audit = await app.evaluationIsolation.audit(run.id);
    const filtered = audit.events.filter(event => event.tier === "blocked");
    if (blocked && !filtered.length) throw new Error("Blocked control produced no actual gateway exclusion event.");
    if (!blocked && !["cited", "exposed_uncited"].includes(audit.tier)) throw new Error("Intentional target exposure was not classified.");
    receipt.push({ projectId, runId: run.id, runStatus: run.status, blocked, exposureTier: audit.tier,
      blockedEvents: filtered.length, completedSourceOutputs: outputs.length,
      observedTools: [...new Set(outputs.map(row => row.tool))],
      observedGateways: [...new Set(audit.events.map(event => event.gateway))],
      gatewayObservations: [...new Set(audit.events.map(event => event.gateway))].map(gateway => ({ gateway,
        blocked: audit.events.filter(event => event.gateway === gateway && event.tier === "blocked").length,
        exposed: audit.events.filter(event => event.gateway === gateway && event.tier === "exposed").length,
        cited: audit.events.filter(event => event.gateway === gateway && event.tier === "cited").length })),
      transcriptHash: hash(transcript), auditHash: hash(audit), scored: false });
  }
  return { kind: "live-isolation-engineering-control", scored: false, controls: receipt };
}
