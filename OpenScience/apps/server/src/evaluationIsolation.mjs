import { HttpError } from "./security.mjs";
import { isEvolutionProject } from "./internalProjects.mjs";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import path from "node:path";

/** @param {any} value */
export function evaluationFingerprint(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
/**
 * Whose requests an evaluation policy can touch. A policy exists only for a run
 * of the platform's own evaluation projects (`registerPending` refuses any
 * other, and `eval-paper-*` is what the evolution module names them), so a
 * request from any other project is not asked about at all: no run lookup, no
 * file read, nothing that can fail. That is what keeps an ordinary
 * researcher's literature fetch, web search or capsule recall exactly what it
 * was before this module existed — the gateways run this on every request, and
 * a request of a run nobody registered as an evaluation must never be refused
 * for a reason that lives in this module's store.
 *  - `evaluation`: an `eval-paper-*` project. Every run of it is an evaluation
 *    run, so a policy that cannot be read refuses the request by name.
 *  - `platform`: the evolution module's other projects. Their runs are not
 *    evaluations; a lookup problem is counted and ignored.
 *  - `audit`: no project named — the evaluator reading its own record by run id.
 *  - `tenant`: everything else.
 * @param {any} identity @returns {"evaluation" | "platform" | "audit" | "tenant"}
 */
function scopeOf(identity) {
  const projectId = identity?.projectId;
  if (projectId == null) return "audit";
  if (/^eval-paper-/.test(String(projectId))) return "evaluation";
  return isEvolutionProject(projectId) ? "platform" : "tenant";
}

/** Policies are control-plane owned; no policy is accepted from a tool request.
 * `report` takes an exclusion event; `reportFailure` takes the code of a lookup that
 * went wrong and was not allowed to cost a request (counted in `counters` too).
 * @param {any} options */
export function createEvaluationIsolation({ dataDir, resolveRunId = identity => identity.runId, report = () => {}, reportFailure = () => {} }) {
  const directory = path.join(dataDir, "evaluation-isolation");
  const policies = new Map();
  const events = new Map();
  const pending = new Map();
  const bindings = new Map();
  /** What the lookups could not do, by what the request was allowed to be. `refused` is a request an
   * evaluation run was refused for an unreadable policy; the other two never cost a request. */
  const counters = { runLookupFailed: 0, platformLookupFailed: 0, refused: 0 };
  const file = runId => path.join(directory, `${createHash("sha256").update(String(runId)).digest("hex")}.json`);
  /** One stored JSON by name: null when it was never written, an error for anything else. */
  const stored = async name => {
    try { return JSON.parse(await readFile(file(name), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const policyFor = async identity => {
    const scope = scopeOf(identity);
    if (scope === "tenant") return null;
    try { return await lookup(identity); }
    catch (error) {
      if (scope === "audit") throw error;
      if (scope === "platform") { counters.platformLookupFailed += 1; reportFailure("evaluation_policy_lookup_failed"); return null; }
      counters.refused += 1;
      reportFailure("evaluation_policy_unreadable");
      throw new HttpError(503, "evaluation_policy_unreadable", "The evaluation's exclusion policy could not be read, so this request was not served.");
    }
  };
  const lookup = async identity => {
    let runId = null;
    // The run ledger is a file that can be unreadable. Not knowing the run is not knowing
    // nothing: the project's own scope and binding below still apply.
    try { runId = await resolveRunId(identity); }
    catch { counters.runLookupFailed += 1; reportFailure("evaluation_run_lookup_failed"); }
    const projectKey = `${identity.userId}\0${identity.projectId}`;
    if (!pending.has(projectKey)) {
      const scope = await stored(`scope:${projectKey}`);
      if (scope) pending.set(projectKey, scope);
    }
    if (!bindings.has(projectKey)) {
      const binding = await stored(`binding:${projectKey}`);
      if (binding) bindings.set(projectKey, binding);
    }
    const binding = bindings.get(projectKey);
    if (binding) {
      if (runId && runId !== binding.runId) throw new Error("Evaluation project is bound to another run.");
      runId = binding.runId;
    }
    if (!runId) return pending.has(projectKey) ? { runId: pending.get(projectKey).id, policy: pending.get(projectKey).policy } : null;
    if (!policies.has(runId)) {
      const policy = await stored(runId);
      if (!policy) return pending.has(projectKey) ? { runId: pending.get(projectKey).id, policy: pending.get(projectKey).policy } : null;
      policies.set(runId, policy);
    }
    return { runId, policy: policies.get(runId) };
  };
  const record = async (runId, gateway, tier, reason) => {
    const event = { at: new Date().toISOString(), runId, gateway, tier, reason };
    events.set(runId, [...(events.get(runId) ?? []), event]);
    await appendFile(`${file(runId)}.jsonl`, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    report(event);
  };
  const matched = (policy, value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const lower = text.toLowerCase();
    for (const alias of policy.aliases ?? []) {
      const normalized = String(alias).toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
      if (normalized && lower.includes(normalized)) return "identifier";
      const pmid = /^(?:pmid:?)?(\d+)$/i.exec(normalized)?.[1];
      if (pmid && new RegExp(`(?:pmid["\\s:=>/]*|pubmed\\.ncbi\\.nlm\\.nih\\.gov/|article/med/|id["\\s:=>]+)${pmid}(?:[^0-9]|$)`, "i").test(text)) return "identifier";
    }
    const fingerprint = evaluationFingerprint(text);
    if ((policy.titles ?? []).some(title => {
      const key = evaluationFingerprint(title); return key.length >= 16 && fingerprint.includes(key);
    })) return "title";
    return null;
  };
  const cutoffReason = (policy, value) => {
    if (!policy.cutoff || !value || typeof value !== "object") return null;
    const date = value.published ?? value.publication_date ?? value.publicationDate ?? value.pubdate ?? value.date ?? value.published_at ?? value.year ?? value.pubYear ?? value.firstPublicationDate;
    const parts = date?.["date-parts"]?.[0];
    const text = parts ? `${parts[0]}-${String(parts[1] ?? 12).padStart(2, "0")}-${String(parts[2] ?? 28).padStart(2, "0")}` : String(date ?? "");
    const time = Date.parse(/^\d{4}$/.test(text) ? `${text}-12-31` : text);
    if (Number.isFinite(time)) return time > Date.parse(policy.cutoff) ? "after_cutoff" : null;
    // Undated bibliographic hits cannot establish that they existed at the frozen search cutoff.
    return ["doi", "pmid", "pmcid", "title", "publication_date", "publicationDate", "pubdate"].some(key => typeof value[key] === "string") ? "cutoff_date_unknown" : null;
  };
  return {
    counters,
    async register(runId, policy) {
      if (!runId || !Array.isArray(policy.aliases) || !Array.isArray(policy.titles)) throw new HttpError(400, "evolution_evaluation_invalid", "An evaluation policy needs run identity, aliases and titles.");
      if (policy.cutoff && !Number.isFinite(Date.parse(policy.cutoff))) throw new HttpError(400, "evolution_evaluation_invalid", "Invalid evaluation cutoff.");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { await writeFile(file(runId), JSON.stringify(policy), { mode: 0o600, flag: "wx" }); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = JSON.parse(await readFile(file(runId), "utf8"));
        if (JSON.stringify(existing) !== JSON.stringify(policy)) throw new HttpError(409, "evolution_evaluation_invalid", "Evaluation exclusion policy is immutable.");
      }
      policies.set(runId, structuredClone(policy));
    },
    async registerPending(identity, policy) {
      if (!/^eval-paper-/.test(String(identity.projectId))) throw new HttpError(400, "evolution_evaluation_invalid", "Evaluation policies require a dedicated internal project.");
      const id = `pending:${identity.userId}:${identity.projectId}`;
      await this.register(id, policy);
      const scope = { id, policy: structuredClone(policy) };
      try { await writeFile(file(`scope:${identity.userId}\0${identity.projectId}`), JSON.stringify(scope), { mode: 0o600, flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST") throw error; const existing = JSON.parse(await readFile(file(`scope:${identity.userId}\0${identity.projectId}`), "utf8")); if (JSON.stringify(existing) !== JSON.stringify(scope)) throw new HttpError(409, "evolution_evaluation_invalid", "Evaluation project policy is immutable."); }
      pending.set(`${identity.userId}\0${identity.projectId}`, scope);
      return id;
    },
    async bindRun(identity, runId) {
      const key = `${identity.userId}\0${identity.projectId}`;
      let entry = pending.get(key);
      if (!entry) { try { entry = JSON.parse(await readFile(file(`scope:${key}`), "utf8")); pending.set(key, entry); } catch (error) { if (error.code !== "ENOENT") throw error; } }
      if (!entry) throw new HttpError(409, "evolution_evaluation_invalid", "No protected policy was registered before dispatch.");
      await this.register(runId, entry.policy);
      const binding = { runId, pendingId: entry.id, userId: identity.userId, projectId: identity.projectId };
      const bindingBytes = JSON.stringify(binding);
      const persist = async name => { try { await writeFile(file(name), bindingBytes, { mode: 0o600, flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; if (await readFile(file(name), "utf8") !== bindingBytes) throw new HttpError(409, "evolution_evaluation_invalid", "Evaluation project run binding is immutable."); } };
      await persist(`binding:${key}`);
      await persist(`attribution:${runId}`);
      bindings.set(key, binding);
      // Original pending events stay in their original log; audit references their exact provenance.
    },
    async filterRaw(identity, gateway, text, contentType) {
      const context = await policyFor(identity); if (!context) return text;
      if (contentType.includes("xml")) {
        const chunks = text.match(/<PubmedArticle\b[\s\S]*?<\/PubmedArticle>|<article\b[\s\S]*?<\/article>|<result\b[\s\S]*?<\/result>/gi);
        if (chunks?.length) {
          let result = text;
          for (const chunk of chunks) {
            const year = /<(?:pubYear|firstPublicationDate|pubDate)[^>]*>(\d{4}(?:-\d{2}-\d{2})?)/i.exec(chunk)?.[1]
              ?? /<PubDate[^>]*>[\s\S]*?<Year>(\d{4})<\/Year>/i.exec(chunk)?.[1];
            const reason = matched(context.policy, chunk) ?? (context.policy.cutoff && (!year || Date.parse(year.length === 4 ? `${year}-12-31` : year) > Date.parse(context.policy.cutoff)) ? "cutoff_unknown_or_late" : null);
            if (reason) { await record(context.runId, gateway, "blocked", reason); result = result.replace(chunk, ""); }
          }
          return result;
        }
      }
      const reason = matched(context.policy, text) ?? (context.policy.cutoff ? "cutoff_unknown" : null);
      if (reason) { await record(context.runId, gateway, "blocked", reason); throw new HttpError(403, "evaluation_source_excluded", "Unverifiable source is excluded from this evaluation."); }
      return text;
    },
    async recordCitations(runId, value) { return this.auditExposure({ runId }, "deliverable", value, true); },
    async isEvaluation(identity) { return Boolean(await policyFor(identity)); },
    async assertRequest(identity, gateway, value) {
      const context = await policyFor(identity); if (!context) return;
      const reason = matched(context.policy, value);
      if (reason) { await record(context.runId, gateway, "blocked", reason); throw new HttpError(403, "evaluation_source_excluded", "The source is excluded from this evaluation."); }
    },
    async filter(identity, gateway, value) {
      const context = await policyFor(identity); if (!context) return value;
      const walk = async node => {
        if (Array.isArray(node)) return (await Promise.all(node.map(walk))).filter(item => item !== undefined);
        if (node && typeof node === "object") {
          // Match scalar metadata at this level, so one excluded row does not remove its siblings.
          const scalar = Object.fromEntries(Object.entries(node).filter(([, item]) => item === null || typeof item !== "object"));
          const reason = matched(context.policy, scalar) ?? cutoffReason(context.policy, node);
          if (reason) { await record(context.runId, gateway, "blocked", reason); return undefined; }
          const result = {};
          for (const [key, item] of Object.entries(node)) { const filtered = await walk(item); if (filtered !== undefined) result[key] = filtered; }
          return result;
        }
        if (typeof node === "string" && (node.trimStart().startsWith("{") || node.trimStart().startsWith("["))) {
          let decoded;
          try { decoded = JSON.parse(node); } catch { decoded = null; }
          if (decoded && typeof decoded === "object") {
            const filtered = await walk(decoded);
            return filtered === undefined ? undefined : JSON.stringify(filtered);
          }
        }
        if (typeof node === "string" && /<(?:PubmedArticle|article|result)\b/i.test(node)) {
          try { return await this.filterRaw(identity, gateway, node, "application/xml"); }
          catch (error) { if (error.code !== "evaluation_source_excluded") throw error; return undefined; }
        }
        const reason = matched(context.policy, node);
        if (reason) { await record(context.runId, gateway, "blocked", reason); return undefined; }
        return node;
      };
      return (await walk(value)) ?? { excluded: true };
    },
    async auditExposure(identity, gateway, value, cited = false) {
      const context = await policyFor(identity); if (!context) return false;
      const reason = matched(context.policy, value);
      if (reason) await record(context.runId, gateway, cited ? "cited" : "exposed", reason);
      return Boolean(reason);
    },
    async audit(runId) {
      let rows;
      try { rows = (await readFile(`${file(runId)}.jsonl`, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code !== "ENOENT") throw error; rows = []; }
      let attribution;
      try { attribution = JSON.parse(await readFile(file(`attribution:${runId}`), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (attribution) {
        let pendingRows = [];
        try { pendingRows = (await readFile(`${file(attribution.pendingId)}.jsonl`, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code !== "ENOENT") throw error; }
        rows = [...pendingRows.map(event => ({ ...event, attributedRunId: runId, attribution: { pendingId: attribution.pendingId, userId: attribution.userId, projectId: attribution.projectId } })), ...rows];
      }
      return { runId, events: rows, tier: rows.some(row => row.tier === "cited") ? "cited" : rows.some(row => row.tier === "exposed") ? "exposed_uncited" : "unexposed" };
    },
  };
}
