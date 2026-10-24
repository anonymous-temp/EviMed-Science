import { createHash } from "node:crypto";
import { HttpError } from "./security.mjs";
import { observedResultPath } from "./resultProducerCapture.mjs";
import { readVerifiedRunTranscript } from "./runTranscripts.mjs";
import { geoSignalValueRunPaths, geoStructuredRunPaths } from "./geoDeliveryImport.mjs";

const unavailable = () => new HttpError(409, "geo_plan_output_unavailable", "The producing run's preserved output is unavailable; retain the files and refresh after its original capture is restored.");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

/** Native completed tool witnesses, bounded to the original run's accepted root turn.
 * An edit witnesses an event, never a digest; an observed capture for that event remains usable with its existing label.
 * @param {any} project @param {any} run @param {any} transcript @param {string} relative */
function witnesses(project, run, transcript, relative) {
  const messages = transcript?.messages ?? [];
  const start = Date.parse(run.startedAt), end = Date.parse(run.finishedAt);
  const turns = new Set(messages.filter(message => message.sessionId === run.sessionId && message.role === "user"
    && message.source === "user" && (run.kernelRequestIds ?? []).includes(message.sourceRequestId)).map(message => message.turnStartSeq));
  if (run.nativeTurn?.startSeq != null) turns.add(run.nativeTurn.startSeq);
  return messages.filter(message => message.sessionId === run.sessionId && turns.has(message.turnStartSeq)
    && message.time >= start && message.time <= end).flatMap(message => (message.parts ?? []).flatMap(part => {
    if (part.type !== "tool" || part.status !== "completed" || !["write", "edit", "file_write", "file_edit"].includes(part.tool)
      || !Number.isSafeInteger(part.completedSeq) || !part.callId || (part.completedAt != null && part.completedAt > end)) return [];
    let path;
    try { path = observedResultPath(project, part.input?.file_path ?? part.input?.filePath ?? part.input?.path); } catch { return []; }
    if (path !== relative) return [];
    const content = ["write", "file_write"].includes(part.tool) && typeof part.input?.content === "string" ? part.input.content : null;
    return [{ eventId: String(part.completedSeq), callId: part.callId, order: part.completedSeq, digest: content === null ? null : sha(content) }];
  })).sort((a, b) => b.order - a.order);
}

/** Pin only versions that existed before the refresh. Workspace inventory, mutable files and capture timestamps have no authority.
 * @param {{results:any,project:any,run:any,context:any,transcript?:any,paths?:string[]}} input */
export async function pinGeoRunOutputs({ results, project, run, context, transcript = null, paths = [...geoStructuredRunPaths(run, context), ...geoSignalValueRunPaths(run, context)] }) {
  const pinned = new Map();
  const folders = new Set(paths.map(file => file.split("/")[1]));
  const handed = ["outputFiles", "presentedFiles", "artifacts", "unverifiedArtifacts"].flatMap(key => Array.isArray(run[key]) ? run[key] : [])
    .map(file => typeof file === "string" ? file : file?.path)
    .filter(file => typeof file === "string" && /^deliverables\/[A-Za-z0-9_-]{1,160}\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(file)
      && !file.split("/").some(part => part === "." || part === "..") && folders.has(file.split("/")[1]));
  for (const relative of [...new Set([...paths, ...handed])].slice(0, 128)) {
    const candidates = [];
    let cursor = null;
    if (results) do {
      const page = await results.list(project.userId, { projectId: project.id, path: relative, runId: run.id, limit: 100, cursor });
      candidates.push(...page.items.filter(version => version.path === relative && version.producer?.runId === run.id
        && version.producer?.sessionId === run.sessionId && version.producer?.kind !== "workspace" && version.coverage?.snapshot === "complete"));
      cursor = page.nextCursor;
    } while (cursor);
    const events = transcript ? witnesses(project, run, transcript, relative) : candidates.filter(version => version.producer.kind === "tool"
      && /^\d+$/.test(version.producer.eventId ?? "") && version.producer.callId).map(version => ({
      eventId: version.producer.eventId, callId: version.producer.callId, order: Number(version.producer.eventId), digest: null,
    })).sort((a, b) => b.order - a.order);
    const final = events[0];
    let eligible = final ? candidates.filter(version => version.producer.kind === "tool" && version.producer.eventId === final.eventId
      && version.producer.callId === final.callId && (!final.digest || version.digest === final.digest)) : [];
    // A receipt-bound delivery is an independent byte witness when no direct write capture was retained.
    if (!eligible.length && !final) eligible = candidates.filter(version => version.producer.kind === "deliverable" && version.coverage.producer === "bound");
    const digests = new Set(eligible.map(version => version.digest));
    pinned.set(relative, digests.size === 1 ? { version: eligible.sort((a, b) => a.versionId.localeCompare(b.versionId))[0] }
      : { code: digests.size > 1 ? "geo_plan_output_ambiguous" : "geo_plan_output_unavailable" });
  }
  const identity = sha(JSON.stringify([project.userId, project.id, run.id, run.sessionId, [...pinned].map(([relative, selected]) =>
    [relative, selected.version?.versionId ?? null, selected.version?.digest ?? null, selected.code ?? null]).sort((a, b) => a[0].localeCompare(b[0]))]));
  return {
    identity,
    /** Internal closure: neither an API caller nor refreshed inventory can replace this pinned selection.
     * @param {any} owner @param {any} actual @param {string} relative */
    async readFile(owner, actual, relative) {
      if (owner.userId !== project.userId || owner.id !== project.id || actual.id !== run.id || actual.sessionId !== run.sessionId) throw unavailable();
      const selected = pinned.get(relative);
      if (!selected?.version) throw new HttpError(409, selected?.code ?? "geo_plan_output_unavailable", "The original producing event has no unambiguous preserved output; retain the files.");
      const bytes = (await results.raw(project.userId, project.id, selected.version.versionId)).bytes;
      if (sha(bytes) !== selected.version.digest) throw unavailable();
      return bytes;
    },
  };
}

/** Existing owned refresh operation plus narrowly scoped business reconciliation. No capture or run-completion callback is replayed.
 * @param {{runs:any,results:any,geo:any,contexts:any,readTranscript?:typeof readVerifiedRunTranscript}} deps */
export function createGeoArtifactRefresh({ runs, results, geo, contexts, readTranscript = readVerifiedRunTranscript }) {
  return async (/** @type {any} */ project, /** @type {string} */ runId, /** @type {{expectedTranscriptSha256:string}} */ options) => {
    const original = (await runs.list(project)).find(run => run.id === runId);
    if (!original) throw new HttpError(404, "agent_run_not_found", "Agent run not found.");
    if (original.status === "running") throw new HttpError(409, "agent_run_not_finished", "The run is still working.");
    const transcript = await readTranscript(project, original, options.expectedTranscriptSha256);
    const geoProject = await geo?.store.projectByControlProject(project.userId, project.id);
    const context = geoProject ? await contexts?.forRun(geoProject, original) : null;
    const pinned = context ? await pinGeoRunOutputs({ results, project, run: original, context, transcript }) : null;
    const refreshed = await runs.refreshArtifacts(project, runId, options);
    if (!context || !pinned) return refreshed;
    const geoImport = await geo.importDelivery(project, original, { recovery: true, readRunFile: pinned.readFile, candidateIdentity: pinned.identity });
    return { ...refreshed, geoImport };
  };
}
