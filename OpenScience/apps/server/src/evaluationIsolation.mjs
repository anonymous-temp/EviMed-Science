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
   * evaluation run was refused for an unreadable policy; the other two never cost a request. `recalled` is not a
   * lookup: development runs whose model named the protected reference from its own memory (`auditTranscript`). */
  const counters = { runLookupFailed: 0, platformLookupFailed: 0, refused: 0, recalled: 0 };
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
      // One run, two names: the ledger's id, and the dispatch id its bounded runtime's gateway token carries
      // (`reserveBoundedRuntimeSession({ runId: dispatchId })`). Any third id is another run.
      if (runId && runId !== binding.runId && runId !== binding.dispatchId) throw new Error("Evaluation project is bound to another run.");
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
  const record = async (runId, gateway, tier, reason, detail = {}) => {
    const event = { at: new Date().toISOString(), runId, gateway, tier, reason, ...detail };
    events.set(runId, [...(events.get(runId) ?? []), event]);
    await appendFile(`${file(runId)}.jsonl`, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    report(event);
  };
  /**
   * What a gateway would make of a request or a body: percent escapes undone, up to three layers deep (`%252F`). A DOI is written
   * into an upstream URL as `10.1136%2Fbmj.315.7114.980` by every client that encodes it, and the plain slash was the only form the
   * match below saw: on release 6 the same request was refused with the slash and served with `%2F`. An escape that does not decode
   * (a stray `%`) is left as it is.
   * @param {string} text
   */
  const percentDecoded = text => {
    let current = text;
    for (let layer = 0; layer < 3 && current.includes("%"); layer += 1) {
      let next;
      try { next = decodeURIComponent(current); } catch { next = current.replace(/%([0-9a-f]{2})/gi, (escape, hex) => parseInt(hex, 16) < 0x80 ? String.fromCharCode(parseInt(hex, 16)) : escape); }
      if (next === current) break;
      current = next;
    }
    return current;
  };
  /** One text against one policy: its identifiers, then its titles. @param {any} policy @param {string} text */
  const matchedIn = (policy, text) => {
    const lower = text.toLowerCase();
    for (const alias of policy.aliases ?? []) {
      const normalized = String(alias).toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
      if (normalized && lower.includes(normalized)) return "identifier";
      const pmid = /^(?:pmid:?)?(\d+)$/i.exec(normalized)?.[1];
      if (pmid && new RegExp(`(?:pmid["\\s:=>/]*|pubmed\\.ncbi\\.nlm\\.nih\\.gov/|article/med/|id["\\s:=>]+)${pmid}(?:[^0-9]|$)`, "i").test(text)) return "identifier";
    }
    // A protected id named as a query parameter value, alone or in a list (`id=30158069,9365295`, `term=9365295[uid]`).
    const bare = bareIdsOf(policy);
    if (bare.size) for (const parameter of text.matchAll(/[?&;]([^=&#;\s"'<>]+)=([^&#;\s"'<>]*)/g)) if (parameter[2].split(/[\s,+[\]()]+/).some(token => bare.has(token))) return "identifier";
    const fingerprint = evaluationFingerprint(text);
    if ((policy.titles ?? []).some(title => {
      const key = evaluationFingerprint(title); return key.length >= 16 && fingerprint.includes(key);
    })) return "title";
    return null;
  };
  const matched = (policy, value) => {
    const text = (typeof value === "string" ? value : JSON.stringify(value)) ?? "";
    const decoded = percentDecoded(text);
    return matchedIn(policy, text) ?? (decoded === text ? null : matchedIn(policy, decoded));
  };
  /**
   * The bare numeric ids a policy protects: its PMIDs and the number of a PMCID. A PubMed or PMC response carries a paper as a
   * bare id wherever it lists papers (`esearchresult.idlist`, `result.uids`, the `links` of a link set, an id keyed result), and a
   * bare id has no `pmid`/`id` beside it for `matched` to read. It is compared whole, never as a substring of a longer number.
   * @param {any} policy
   */
  const bareIdsOf = policy => {
    const ids = new Set();
    for (const alias of policy.aliases ?? []) {
      const digits = /^(?:pmid:?\s*|pmc)?(\d+)$/i.exec(String(alias).trim())?.[1];
      if (digits) ids.add(digits);
    }
    return ids;
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
    /** Binds the project's one evaluation run. `dispatchId` is the name the run's own bounded runtime asks under
     * (its gateway token's `runId`); without it, only requests that name the ledger id or none are the bound run's.
     * @param {any} identity @param {string} runId @param {{ dispatchId?: string | null }} [names] */
    async bindRun(identity, runId, { dispatchId = null } = {}) {
      if (dispatchId !== null && (typeof dispatchId !== "string" || !dispatchId)) throw new HttpError(400, "evolution_evaluation_invalid", "An evaluation run's dispatch id must be a non-empty string.");
      const key = `${identity.userId}\0${identity.projectId}`;
      let entry = pending.get(key);
      if (!entry) { try { entry = JSON.parse(await readFile(file(`scope:${key}`), "utf8")); pending.set(key, entry); } catch (error) { if (error.code !== "ENOENT") throw error; } }
      if (!entry) throw new HttpError(409, "evolution_evaluation_invalid", "No protected policy was registered before dispatch.");
      await this.register(runId, entry.policy);
      const binding = { runId, pendingId: entry.id, userId: identity.userId, projectId: identity.projectId, ...(dispatchId ? { dispatchId } : {}) };
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
      const bare = bareIdsOf(context.policy);
      const isBare = item => typeof item === "string" ? /^\s*\d+\s*$/.test(item) && bare.has(item.trim()) : Number.isSafeInteger(item) && bare.has(String(item));
      /** `listed` marks an array element: an id list holds its papers as bare ids, so a bare id there is a paper. */
      const walk = async (node, listed = false) => {
        if (Array.isArray(node)) return (await Promise.all(node.map(item => walk(item, true)))).filter(item => item !== undefined);
        if (listed && isBare(node)) { await record(context.runId, gateway, "blocked", "identifier"); return undefined; }
        // A list written as one string ("30158069,9365295"): the protected ids leave it, the others stay.
        if (typeof node === "string" && bare.size && /^\s*\d+(?:\s*[,;\s]\s*\d+)+\s*$/.test(node)) {
          const tokens = node.trim().split(/\s*[,;\s]\s*/), kept = tokens.filter(token => !bare.has(token));
          if (kept.length < tokens.length) { await record(context.runId, gateway, "blocked", "identifier"); return kept.length ? kept.join(",") : undefined; }
        }
        if (node && typeof node === "object") {
          // Match scalar metadata at this level, so one excluded row does not remove its siblings.
          const scalar = Object.fromEntries(Object.entries(node).filter(([, item]) => item === null || typeof item !== "object"));
          const reason = matched(context.policy, scalar) ?? cutoffReason(context.policy, node);
          if (reason) { await record(context.runId, gateway, "blocked", reason); return undefined; }
          const result = {};
          for (const [key, item] of Object.entries(node)) {
            // A result keyed by id ("result": { "9365295": {...} }) names the paper in the key even when the record does not.
            if (bare.has(key)) { await record(context.runId, gateway, "blocked", "identifier"); continue; }
            const filtered = await walk(item); if (filtered !== undefined) result[key] = filtered;
          }
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
    /**
     * A development run's transcript, heard in two voices (`transcriptVoices`, evolutionExposureChain.mjs).
     *
     * `served` is everything the run was handed or got back — its brief, injected context, tool calls and their results.
     * A target matched there is an exposure, as it always was. `own` is the model's own reasoning and reply text. A
     * target matched only there, in a run for which no source event served or matched the target (no `blocked`,
     * `exposed` or `cited` event), is `recalled`: the model named a paper it knows from training. The platform did not
     * serve it and no isolation can remove it, so it is recorded with the step it was said at and counted, and it is
     * not an exposure (ruling of 2026-10-05). A mention beside a matched source event keeps the classification it had.
     * What controls for recall is not this audit but the temporal holdout — papers published after the model's cutoff
     * (evolutionTimeHoldout.mjs). Matching is the policy's own: identifiers and registered titles, never open language.
     * @param {any} identity @param {string} gateway @param {{ served: any, own: { step: any, text: string }[] }} voices
     * @returns {Promise<{ tier: "unexposed" } | { tier: "exposed", reason: string } | { tier: "recalled", reason: string, step: any }>}
     */
    async auditTranscript(identity, gateway, { served, own }) {
      const context = await policyFor(identity); if (!context) return { tier: "unexposed" };
      const handed = matched(context.policy, served);
      if (handed) { await record(context.runId, gateway, "exposed", handed); return { tier: "exposed", reason: handed }; }
      let mention = null;
      for (const part of own ?? []) { const reason = matched(context.policy, part.text); if (reason) { mention = { reason, step: part.step ?? null }; break; } }
      if (!mention) return { tier: "unexposed" };
      const logged = (await this.audit(context.runId)).events;
      if (logged.some(event => ["blocked", "exposed", "cited"].includes(event.tier))) { await record(context.runId, gateway, "exposed", mention.reason); return { tier: "exposed", reason: mention.reason }; }
      // The same run is audited again for each later candidate of its branch; the finding is one.
      if (!logged.some(event => event.tier === "recalled" && event.gateway === gateway)) { await record(context.runId, gateway, "recalled", mention.reason, { step: mention.step }); counters.recalled += 1; }
      return { tier: "recalled", ...mention };
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
      // `recalled` ranks under every exposure and is not one: see `auditTranscript`.
      return { runId, events: rows, tier: rows.some(row => row.tier === "cited") ? "cited" : rows.some(row => row.tier === "exposed") ? "exposed_uncited" : rows.some(row => row.tier === "recalled") ? "recalled" : "unexposed" };
    },
  };
}
