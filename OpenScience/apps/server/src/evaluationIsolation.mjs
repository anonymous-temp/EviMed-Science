import { HttpError } from "./security.mjs";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import path from "node:path";

/** @param {any} value */
export function evaluationFingerprint(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
/** Policies are control-plane owned; no policy is accepted from a tool request. @param {any} options */
export function createEvaluationIsolation({ dataDir, resolveRunId = identity => identity.runId, report = () => {} }) {
  const directory = path.join(dataDir, "evaluation-isolation");
  const policies = new Map();
  const events = new Map();
  const pending = new Map();
  const bindings = new Map();
  const file = runId => path.join(directory, `${createHash("sha256").update(String(runId)).digest("hex")}.json`);
  const policyFor = async identity => {
    let runId = await resolveRunId(identity);
    const projectKey = `${identity.userId}\0${identity.projectId}`;
    if (!pending.has(projectKey)) {
      try { const scope = JSON.parse(await readFile(file(`scope:${projectKey}`), "utf8")); pending.set(projectKey, scope); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (!bindings.has(projectKey)) {
      try { bindings.set(projectKey, JSON.parse(await readFile(file(`binding:${projectKey}`), "utf8"))); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const binding = bindings.get(projectKey);
    if (binding) {
      if (runId && runId !== binding.runId) throw new Error("Evaluation project is bound to another run.");
      runId = binding.runId;
    }
    if (!runId) return pending.has(projectKey) ? { runId: pending.get(projectKey).id, policy: pending.get(projectKey).policy } : null;
    if (!policies.has(runId)) {
      try { policies.set(runId, JSON.parse(await readFile(file(runId), "utf8"))); }
      catch (error) { if (error.code !== "ENOENT") throw error; return pending.has(projectKey) ? { runId: pending.get(projectKey).id, policy: pending.get(projectKey).policy } : null; }
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
    async register(runId, policy) {
      if (!runId || !Array.isArray(policy.aliases) || !Array.isArray(policy.titles)) throw new Error("An evaluation policy needs run identity, aliases and titles.");
      if (policy.cutoff && !Number.isFinite(Date.parse(policy.cutoff))) throw new Error("Invalid evaluation cutoff.");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { await writeFile(file(runId), JSON.stringify(policy), { mode: 0o600, flag: "wx" }); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = JSON.parse(await readFile(file(runId), "utf8"));
        if (JSON.stringify(existing) !== JSON.stringify(policy)) throw new Error("Evaluation exclusion policy is immutable.");
      }
      policies.set(runId, structuredClone(policy));
    },
    async registerPending(identity, policy) {
      if (!/^eval-paper-/.test(String(identity.projectId))) throw new Error("Evaluation policies require a dedicated internal project.");
      const id = `pending:${identity.userId}:${identity.projectId}`;
      await this.register(id, policy);
      const scope = { id, policy: structuredClone(policy) };
      try { await writeFile(file(`scope:${identity.userId}\0${identity.projectId}`), JSON.stringify(scope), { mode: 0o600, flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST") throw error; const existing = JSON.parse(await readFile(file(`scope:${identity.userId}\0${identity.projectId}`), "utf8")); if (JSON.stringify(existing) !== JSON.stringify(scope)) throw new Error("Evaluation project policy is immutable."); }
      pending.set(`${identity.userId}\0${identity.projectId}`, scope);
      return id;
    },
    async bindRun(identity, runId) {
      const key = `${identity.userId}\0${identity.projectId}`;
      let entry = pending.get(key);
      if (!entry) { try { entry = JSON.parse(await readFile(file(`scope:${key}`), "utf8")); pending.set(key, entry); } catch (error) { if (error.code !== "ENOENT") throw error; } }
      if (!entry) throw new Error("No protected policy was registered before dispatch.");
      await this.register(runId, entry.policy);
      const binding = { runId, pendingId: entry.id, userId: identity.userId, projectId: identity.projectId };
      const bindingBytes = JSON.stringify(binding);
      const persist = async name => { try { await writeFile(file(name), bindingBytes, { mode: 0o600, flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; if (await readFile(file(name), "utf8") !== bindingBytes) throw new Error("Evaluation project run binding is immutable."); } };
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
