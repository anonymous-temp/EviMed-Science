import { createHash, randomUUID } from "node:crypto";
import { AUTOPILOT_TASK_TYPES, digestPlacement, directionVerdict, tierRaiseAllowed, validateAgendaClaim } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/** @param {unknown} value @param {string} field @param {number} max */
function text(value, field, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new HttpError(400, "autopilot_payload_invalid", `${field} is invalid.`);
  }
  return value.trim();
}

function budget(value, field, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < (allowZero ? 0 : 0.01) || number > 1_000_000) {
    throw new HttpError(400, "autopilot_budget_invalid", `${field} is invalid.`);
  }
  return Math.round(number * 100) / 100;
}

function listOfText(value, field, allowed = null) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new HttpError(400, "autopilot_payload_invalid", `${field} is invalid.`);
  const values = [...new Set(value.map((item) => text(item, field, 200)))];
  if (allowed && values.some((item) => !allowed.includes(item))) throw new HttpError(400, "autopilot_payload_invalid", `${field} contains an unsupported value.`);
  return values;
}

function isConflict(error) { return error?.code === "product_revision_conflict"; }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }

function daysWithoutActivity(agenda, now) {
  const createdAt = Number.isFinite(Date.parse(agenda.payload.createdAt)) ? agenda.payload.createdAt : agenda.createdAt;
  const timestamps = [agenda.payload.lastDigestOpenedAt, agenda.payload.lastStartedAt,
    createdAt].map((value) => Date.parse(value)).filter(Number.isFinite);
  return timestamps.length ? Math.max(0, Math.floor((now.getTime() - Math.max(...timestamps)) / 86_400_000)) : Infinity;
}

/** Persistent proactive-research policy and decision ledger. Episodes remain
 * ordinary ProductJobs and are dispatched through the ordinary AgentRun path. */
export class AutopilotService {
  /** @param {{documents:any,jobs:any,usage?:any,notifications?:any,now?:()=>Date,id?:(prefix:string)=>string}} dependencies */
  constructor({ documents, jobs, usage = null, notifications = null, now = () => new Date(), id = (prefix) => `${prefix}${randomUUID()}` }) {
    if (!documents || !jobs) throw new TypeError("AutopilotService requires product documents and jobs.");
    this.documents = documents;
    this.jobs = jobs;
    this.usage = usage;
    this.notifications = notifications;
    this.now = now;
    this.id = id;
  }

  /** @param {string} userId @param {Record<string,any>} input */
  async create(userId, input) {
    const projectId = text(input.projectId, "project id", 160);
    const dailyBudgetCny = budget(input.dailyBudgetCny, "daily budget");
    const weeklyBudgetCny = budget(input.weeklyBudgetCny, "weekly budget");
    const maxEpisodeCny = budget(input.maxEpisodeCny, "episode budget");
    if (maxEpisodeCny > dailyBudgetCny || dailyBudgetCny > weeklyBudgetCny) {
      throw new HttpError(400, "autopilot_budget_invalid", "Episode, daily and weekly budgets must be ordered.");
    }
    const scheduleHour = Number(input.scheduleHour);
    if (!Number.isSafeInteger(scheduleHour) || scheduleHour < 0 || scheduleHour > 23) throw new HttpError(400, "autopilot_payload_invalid", "Schedule hour is invalid.");
    const now = this.now().toISOString();
    const payload = {
      schemaVersion: 1,
      title: text(input.title, "agenda title", 200),
      topics: listOfText(input.topics, "agenda topics"),
      taskTypes: listOfText(input.taskTypes, "task types", AUTOPILOT_TASK_TYPES),
      dailyBudgetCny, weeklyBudgetCny, maxEpisodeCny,
      scheduleHour,
      timeZone: text(input.timeZone, "time zone", 80),
      enabled: false,
      status: "paused",
      pauseReason: "Waiting for the researcher to start proactive research.",
      consecutiveFailures: 0,
      episodesWithoutGatedClaim: 0,
      lastDigestOpenedAt: null,
      lastScheduledDate: null,
      outcomes: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.documents.put(userId, "agenda", this.id("agenda-"), payload, { expectedRevision: 0, projectId });
  }

  /** @param {string} userId @param {string} agendaId */
  async get(userId, agendaId) {
    const agenda = await this.documents.get(userId, "agenda", text(agendaId, "agenda id", 160));
    if (!agenda) throw new HttpError(404, "autopilot_agenda_not_found", "Research agenda is unavailable.");
    return agenda;
  }

  /** @param {string} userId @param {{projectId:string}} options */
  async list(userId, { projectId }) { return this.documents.list(userId, "agenda", { projectId, limit: 100 }); }

  /** @param {string} userId @param {{projectId:string}} options */
  async listDigests(userId, { projectId }) { return this.documents.list(userId, "digest", { projectId, limit: 100 }); }

  /** @param {string} userId @param {string} digestId */
  async getDigest(userId, digestId) {
    const digest = await this.documents.get(userId, "digest", text(digestId, "digest id", 160));
    if (!digest) throw new HttpError(404, "autopilot_digest_not_found", "Research digest is unavailable.");
    return digest;
  }

  /** Record an actual digest view. Reads and list requests never extend activity.
   * Both optimistic writes are replayable if the second write is interrupted. */
  async markDigestOpened(userId, digestId) {
    const at = this.now().toISOString();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let digest = await this.getDigest(userId, digestId);
      const agenda = await this.get(userId, digest.payload.agendaId);
      if (agenda.projectId !== digest.projectId) throw new HttpError(409, "autopilot_digest_conflict", "Digest and agenda belong to different projects.");
      try {
        if (!(Date.parse(digest.payload.openedAt) >= Date.parse(at))) {
          digest = await this.documents.put(userId, "digest", digest.id, {
            ...digest.payload, openedAt: at, updatedAt: at,
          }, { expectedRevision: digest.revision, projectId: digest.projectId });
        }
        if (!(Date.parse(agenda.payload.lastDigestOpenedAt) >= Date.parse(at))) {
          await this.documents.put(userId, "agenda", agenda.id, {
            ...agenda.payload, lastDigestOpenedAt: at, updatedAt: at,
          }, { expectedRevision: agenda.revision, projectId: agenda.projectId });
        }
        return digest;
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    throw new HttpError(409, "autopilot_activity_conflict", "Research activity changed repeatedly; reopen the digest to retry.");
  }

  /** The same inactivity guard runs before enqueueing and immediately before dispatch. */
  async checkInactivity(userId, agendaId) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const agenda = await this.get(userId, agendaId);
      if (!agenda.payload.enabled || agenda.payload.status !== "active") return agenda;
      const verdict = directionVerdict({ episodesWithoutGatedClaim: 0, consecutiveFailures: 0,
        daysSinceDigestOpened: daysWithoutActivity(agenda, this.now()), userRejected: false });
      if (verdict.action !== "pause-thread") return agenda;
      try {
        return await this.documents.put(userId, "agenda", agenda.id, {
          ...agenda.payload, enabled: false, status: "paused", pauseReason: verdict.reason,
          updatedAt: this.now().toISOString(),
        }, { expectedRevision: agenda.revision, projectId: agenda.projectId });
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    throw new HttpError(409, "autopilot_activity_conflict", "Research activity changed repeatedly before dispatch.");
  }

  /** @param {string} userId @param {string} episodeId */
  async getEpisode(userId, episodeId) {
    const episode = await this.documents.get(userId, "episode", text(episodeId, "episode id", 160));
    if (!episode) throw new HttpError(404, "autopilot_episode_not_found", "Research episode is unavailable.");
    return episode;
  }

  async episodeForRun(userId, projectId, runId) {
    const page = await this.documents.list(userId, "episode", { projectId, filter: { runId }, limit: 2 });
    return page.items[0] ?? null;
  }

  /** @param {string} userId @param {string} episodeId @param {{runId:string,sessionId:string}} input */
  async markEpisodeDispatched(userId, episodeId, input) {
    const episode = await this.getEpisode(userId, episodeId);
    if (episode.payload.status === "running" && episode.payload.runId === input.runId) return episode;
    if (!["queued", "failed"].includes(episode.payload.status)) throw new HttpError(409, "autopilot_episode_state_conflict", "Research episode is no longer dispatchable.");
    if (episode.payload.status === "failed" && (episode.payload.runId || episode.payload.digestId || episode.payload.completion)) {
      throw new HttpError(409, "autopilot_episode_state_conflict", "A completed episode cannot be rebound to another dispatch.");
    }
    const agenda = await this.get(userId, episode.payload.agendaId);
    if (!agenda.payload.enabled || agenda.payload.status !== "active") {
      throw new HttpError(409, agenda.payload.status === "stopped" ? "autopilot_stopped" : "autopilot_paused", "This research agenda is no longer active.");
    }
    return this.documents.put(userId, "episode", episode.id, {
      ...episode.payload, status: "running", runId: text(input.runId, "run id", 160),
      sessionId: text(input.sessionId, "session id", 160), updatedAt: this.now().toISOString(),
    }, { expectedRevision: episode.revision, projectId: episode.projectId });
  }

  /** @param {string} userId @param {string} episodeId @param {{code:string}} input */
  async markEpisodeFailed(userId, episodeId, input) {
    const episode = await this.getEpisode(userId, episodeId);
    if (["merged", "canceled"].includes(episode.payload.status)) return episode;
    return this.documents.put(userId, "episode", episode.id, {
      ...episode.payload, status: "failed", error: { code: text(input.code, "episode error", 100) }, updatedAt: this.now().toISOString(),
    }, { expectedRevision: episode.revision, projectId: episode.projectId });
  }

  /** @param {string} userId @param {string} episodeId */
  async markEpisodeCanceled(userId, episodeId) {
    const episode = await this.getEpisode(userId, episodeId);
    if (["merged", "canceled"].includes(episode.payload.status)) return episode;
    return this.documents.put(userId, "episode", episode.id, {
      ...episode.payload, status: "canceled", updatedAt: this.now().toISOString(),
    }, { expectedRevision: episode.revision, projectId: episode.projectId });
  }

  async queueDispatchedCancellation(userId, episodeId, input) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const episode = await this.getEpisode(userId, episodeId);
      if (episode.payload.cancellation?.status === "completed" && episode.payload.cancellation?.runId === input.runId) return episode;
      let canceled;
      try {
        canceled = await this.documents.put(userId, "episode", episode.id, {
          ...episode.payload,
          status: "canceled",
          runId: text(input.runId, "run id", 160),
          sessionId: text(input.sessionId, "session id", 160),
          cancellation: { status: "queued", runId: input.runId, sessionId: input.sessionId },
          updatedAt: this.now().toISOString(),
        }, { expectedRevision: episode.revision, projectId: episode.projectId });
      } catch (error) {
        if (isConflict(error)) continue;
        throw error;
      }
      await this.enqueueCancellation(userId, canceled).catch(() => null);
      return canceled;
    }
    throw new HttpError(409, "autopilot_cancellation_conflict", "Episode changed repeatedly while queuing cancellation.");
  }

  /** Fold an ordinary AgentRun terminal result back into the proactive ledger.
   * @param {string} userId @param {{projectId:string,runId:string,episodeId?:string|null,sessionId?:string|null,status:string,deltaSchemaVersion?:number|null,deltaErrorCode?:string|null,claims?:any[],artifacts?:string[],costCny?:number}} input */
  async completeRun(userId, input) {
    let episode = await this.episodeForRun(userId, input.projectId, input.runId);
    if (!episode && input.episodeId) {
      episode = await this.getEpisode(userId, input.episodeId).catch(() => null);
      if (episode && episode.projectId === input.projectId && !episode.payload.runId && episode.payload.status !== "canceled") {
        episode = await this.documents.put(userId, "episode", episode.id, {
          ...episode.payload, runId: input.runId, sessionId: input.sessionId ?? null,
          status: "running", updatedAt: this.now().toISOString(),
        }, { expectedRevision: episode.revision, projectId: episode.projectId });
      }
    }
    if (!episode || episode.payload.status === "canceled") return null;
    if (["merged", "failed"].includes(episode.payload.status) && episode.payload.digestId) {
      return this.getDigest(userId, episode.payload.digestId);
    }
    let completion = episode.payload.completion;
    if (episode.payload.status !== "verifying") {
      const succeeded = input.status === "succeeded";
      const artifacts = new Set(Array.isArray(input.artifacts) ? input.artifacts : []);
      const acceptedClaims = [];
      const rejectedClaims = [];
      if (succeeded && input.deltaSchemaVersion === 1 && Array.isArray(input.claims)) {
        for (const claim of input.claims.slice(0, 500)) {
          const verdict = validateAgendaClaim(claim);
          const provenance = claim?.provenance;
          const provenanceMatches = provenance?.episodeId === episode.id
            && typeof provenance?.artifact === "string"
            && !provenance.artifact.endsWith("agenda-delta.json")
            && artifacts.has(provenance.artifact);
          if (!verdict.ok || !provenanceMatches) {
            rejectedClaims.push({ id: typeof claim?.id === "string" ? claim.id.slice(0, 160) : null,
              issues: [...verdict.issues.map((issue) => issue.code), ...(provenanceMatches ? [] : ["agenda_claim_provenance_unaccepted"])] });
            continue;
          }
          const raise = tierRaiseAllowed({ from: "unverified", to: "gated", gatePassed: true });
          if (raise.ok) acceptedClaims.push({ ...claim, tier: "gated", gate: { runId: input.runId, passedAt: this.now().toISOString() } });
        }
      }
      const outcomeStatus = succeeded ? "succeeded" : input.status === "canceled" ? "canceled" : "failed";
      completion = {
        runId: input.runId,
        outcomeStatus,
        digestId: `digest-${hash(`${episode.id}:${input.runId}`).slice(0, 32)}`,
        date: this.now().toISOString().slice(0, 10),
        claims: acceptedClaims,
        rejectedClaims,
        deltaErrorCode: input.deltaErrorCode ?? (succeeded && input.deltaSchemaVersion !== 1 ? "agenda_delta_schema_invalid" : null),
        costCny: Number(input.costCny) || 0,
      };
      episode = await this.documents.put(userId, "episode", episode.id, {
        ...episode.payload, status: "verifying", completion, updatedAt: this.now().toISOString(),
      }, { expectedRevision: episode.revision, projectId: episode.projectId });
    } else if (!completion || completion.runId !== input.runId) {
      throw new HttpError(409, "autopilot_completion_conflict", "This episode is folding another run result.");
    }
    return this.finishCompletion(userId, episode);
  }

  async finishCompletion(userId, episode) {
    const completion = episode.payload.completion;
    if (episode.payload.status !== "verifying" || !completion) {
      if (episode.payload.digestId) return this.getDigest(userId, episode.payload.digestId);
      return null;
    }
    const agenda = await this.get(userId, episode.payload.agendaId);
    await this.recordOutcome(userId, agenda.id, {
      expectedRevision: agenda.revision, episodeId: episode.id, status: completion.outcomeStatus,
      gatedClaims: completion.outcomeStatus === "succeeded" ? completion.claims.length : 0,
    });
    const digest = await this.createDigest(userId, agenda.id, {
      digestId: completion.digestId, date: completion.date, episodeIds: [episode.id],
      costCny: completion.costCny, claims: completion.claims,
    });
    const latest = await this.getEpisode(userId, episode.id);
    if (latest.payload.status === "verifying") {
      await this.documents.put(userId, "episode", latest.id, {
        ...latest.payload,
        status: completion.outcomeStatus === "succeeded" ? "merged" : completion.outcomeStatus,
        claims: completion.claims, rejectedClaims: completion.rejectedClaims,
        deltaErrorCode: completion.deltaErrorCode, costCny: completion.costCny,
        digestId: digest.id, completion: null, updatedAt: this.now().toISOString(),
      }, { expectedRevision: latest.revision, projectId: latest.projectId }).catch((error) => {
        if (!isConflict(error)) throw error;
      });
    }
    return digest;
  }

  /** @param {string} userId @param {string} agendaId @param {{expectedRevision:number}} input */
  async start(userId, agendaId, input) {
    const agenda = await this.get(userId, agendaId);
    this.revision(agenda, input.expectedRevision);
    return this.documents.put(userId, "agenda", agenda.id, {
      ...agenda.payload, enabled: true, status: "active", pauseReason: null,
      consecutiveFailures: 0, lastStartedAt: this.now().toISOString(), updatedAt: this.now().toISOString(),
    }, { expectedRevision: agenda.revision, projectId: agenda.projectId });
  }

  /** @param {string} userId @param {string} agendaId @param {{expectedRevision:number}} input */
  async stop(userId, agendaId, input) {
    const agenda = await this.get(userId, agendaId);
    this.revision(agenda, input.expectedRevision);
    const stopped = await this.documents.put(userId, "agenda", agenda.id, {
      ...agenda.payload, enabled: false, status: "stopped", pauseReason: "Stopped by the researcher.",
      stopSweep: { status: "queued", requestedAt: this.now().toISOString() }, updatedAt: this.now().toISOString(),
    }, { expectedRevision: agenda.revision, projectId: agenda.projectId });
    await this.sweepStop(userId, stopped.id).catch(() => null);
    return this.get(userId, stopped.id);
  }

  async sweepStop(userId, agendaId) {
    const agenda = await this.get(userId, agendaId);
    if (agenda.payload.status !== "stopped") return agenda;
    for (const status of ["queued", "failed", "running", "verifying"]) {
      let remaining = true;
      while (remaining) {
        const page = await this.documents.list(userId, "episode", {
          projectId: agenda.projectId, filter: { agendaId: agenda.id, status }, limit: 100,
        });
        remaining = page.items.length > 0;
        if (!remaining) continue;
        for (const item of page.items) {
          const needsRuntimeCancel = status === "running" && typeof item.payload.sessionId === "string" && item.payload.sessionId;
          let canceled;
          try {
            canceled = await this.documents.put(userId, "episode", item.id, {
              ...item.payload,
              status: "canceled",
              ...(needsRuntimeCancel ? { cancellation: { status: "queued", sessionId: item.payload.sessionId, runId: item.payload.runId } } : {}),
              updatedAt: this.now().toISOString(),
            }, { expectedRevision: item.revision, projectId: item.projectId });
          } catch (error) {
            if (!isConflict(error)) throw error;
            continue;
          }
          if (needsRuntimeCancel) await this.enqueueCancellation(userId, canceled).catch(() => null);
        }
      }
    }
    const latest = await this.get(userId, agenda.id);
    if (latest.payload.stopSweep?.status === "completed") return latest;
    return this.documents.put(userId, "agenda", latest.id, {
      ...latest.payload, stopSweep: { ...latest.payload.stopSweep, status: "completed", completedAt: this.now().toISOString() },
      updatedAt: this.now().toISOString(),
    }, { expectedRevision: latest.revision, projectId: latest.projectId });
  }

  async enqueueCancellation(userId, episode) {
    const cancellation = episode.payload.cancellation;
    if (!cancellation || cancellation.status !== "queued") return null;
    return this.jobs.enqueue(userId, "episode", {
      action: "cancel", episodeId: episode.id, sessionId: cancellation.sessionId, runId: cancellation.runId,
    }, { idempotencyKey: `episode-cancel:${episode.id}:${cancellation.runId}`, projectId: episode.projectId,
      maxAttempts: 10, rearmFailed: true });
  }

  async reconcileStopWork() {
    const database = this.documents.database;
    if (!database) return { scanned: 0, enqueued: 0 };
    const completions = await database.query(`SELECT user_id,id,project_id,payload,revision FROM evimed_product.documents
      WHERE kind='episode' AND deleted_at IS NULL AND payload->>'status'='verifying'
      AND payload->'completion' IS NOT NULL ORDER BY updated_at,id LIMIT 100`);
    for (const row of completions.rows) {
      await this.finishCompletion(row.user_id, { id: row.id, projectId: row.project_id, revision: row.revision, payload: row.payload }).catch(() => null);
    }
    const stopped = await database.query(`SELECT user_id,id FROM evimed_product.documents
      WHERE kind='agenda' AND deleted_at IS NULL AND payload->>'status'='stopped'
      AND payload->'stopSweep'->>'status'='queued' ORDER BY updated_at,id LIMIT 100`);
    for (const row of stopped.rows) await this.sweepStop(row.user_id, row.id).catch(() => null);
    const result = await database.query(`SELECT user_id,id,project_id,payload,revision FROM evimed_product.documents d
      WHERE kind='episode' AND deleted_at IS NULL AND payload->'cancellation'->>'status'='queued'
      AND NOT EXISTS (SELECT 1 FROM evimed_product.jobs j WHERE j.user_id=d.user_id AND j.kind='episode'
        AND j.payload->>'action'='cancel' AND j.payload->>'episodeId'=d.id
        AND j.status IN ('queued','running','succeeded'))
      ORDER BY updated_at,id LIMIT 100`);
    let enqueued = 0;
    for (const row of result.rows) {
      await this.enqueueCancellation(row.user_id, { id: row.id, projectId: row.project_id, revision: row.revision, payload: row.payload });
      enqueued += 1;
    }
    return { scanned: completions.rows.length + stopped.rows.length + result.rows.length, enqueued };
  }

  async markCancellationCompleted(userId, episodeId, runId) {
    const episode = await this.getEpisode(userId, episodeId);
    const cancellation = episode.payload.cancellation;
    if (!cancellation || cancellation.status === "completed") return episode;
    if (cancellation.runId !== runId) throw new HttpError(409, "autopilot_cancellation_conflict", "Cancellation belongs to another run.");
    return this.documents.put(userId, "episode", episode.id, {
      ...episode.payload, cancellation: { ...cancellation, status: "completed", completedAt: this.now().toISOString() },
      updatedAt: this.now().toISOString(),
    }, { expectedRevision: episode.revision, projectId: episode.projectId });
  }

  /** @param {string} userId @param {string} agendaId @param {{date:string}} input */
  async schedule(userId, agendaId, input) {
    const agenda = await this.checkInactivity(userId, agendaId);
    if (agenda.payload.status === "stopped") throw new HttpError(409, "autopilot_stopped", "This research agenda has been stopped.");
    if (!agenda.payload.enabled || agenda.payload.status !== "active") throw new HttpError(409, "autopilot_paused", "This research agenda is paused.");
    const date = text(input.date, "episode date", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) throw new HttpError(400, "autopilot_payload_invalid", "Episode date is invalid.");
    if (this.usage) await this.usage.assertWithinLimits(userId, { dailyLimit: agenda.payload.dailyBudgetCny, weeklyLimit: agenda.payload.weeklyBudgetCny, now: this.now() });
    const episodeId = `episode-${hash(`${userId}:${agenda.id}:${date}`).slice(0, 32)}`;
    const index = Number.parseInt(hash(`${agenda.id}:${date}`).slice(0, 8), 16) % agenda.payload.taskTypes.length;
    const taskType = agenda.payload.taskTypes[index];
    const budgetCny = Math.min(agenda.payload.maxEpisodeCny, agenda.payload.dailyBudgetCny);
    const prompt = [
      `Run the ${taskType} proactive research episode for agenda "${agenda.payload.title}".`,
      `Episode ID: ${episodeId}. Use this exact value as provenance.episodeId in agenda-delta.json.`,
      `Topics: ${agenda.payload.topics.join(", ")}.`,
      `Maximum episode budget: CNY ${budgetCny.toFixed(2)}.`,
      "Use the ordinary capability contract and delivery gate. Do not send anything externally. Stop when the budget or two-hour wall clock limit is reached.",
    ].join("\n");
    let episode;
    try {
      episode = await this.documents.put(userId, "episode", episodeId, {
        schemaVersion: 1, agendaId: agenda.id, taskType, date, budgetCny, prompt, status: "queued",
        runId: null, claims: [], createdAt: this.now().toISOString(), updatedAt: this.now().toISOString(),
      }, { expectedRevision: 0, projectId: agenda.projectId });
    } catch (error) {
      if (!isConflict(error)) throw error;
      episode = await this.documents.get(userId, "episode", episodeId);
      if (!episode) throw error;
    }
    const job = await this.jobs.enqueue(userId, "episode", { agendaId: agenda.id, episodeId, taskType, budgetCny, prompt }, {
      idempotencyKey: `episode:${agenda.id}:${date}`, projectId: agenda.projectId, maxAttempts: 10,
    });
    if (agenda.payload.lastScheduledDate !== date) {
      await this.documents.put(userId, "agenda", agenda.id, { ...agenda.payload, lastScheduledDate: date, updatedAt: this.now().toISOString() },
        { expectedRevision: agenda.revision, projectId: agenda.projectId }).catch((error) => { if (!isConflict(error)) throw error; });
    }
    return { episode, job };
  }

  /** @param {string} userId @param {string} agendaId @param {Record<string,any>} input */
  async recordOutcome(userId, agendaId, input) {
    const episodeId = text(input.episodeId, "episode id", 160);
    const status = text(input.status, "episode status", 32);
    if (!["succeeded", "failed", "canceled"].includes(status)) throw new HttpError(400, "autopilot_payload_invalid", "Episode outcome is invalid.");
    const gatedClaims = Number(input.gatedClaims);
    if (!Number.isSafeInteger(gatedClaims) || gatedClaims < 0 || gatedClaims > 100_000) throw new HttpError(400, "autopilot_payload_invalid", "Gated claim count is invalid.");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const agenda = await this.get(userId, agendaId);
      if ((agenda.payload.outcomes ?? []).some((outcome) => outcome.episodeId === episodeId)) return agenda;
      if (attempt === 0) this.revision(agenda, input.expectedRevision);
      const failures = status === "failed" ? Number(agenda.payload.consecutiveFailures ?? 0) + 1 : 0;
      const without = gatedClaims === 0 ? Number(agenda.payload.episodesWithoutGatedClaim ?? 0) + 1 : 0;
      const daysSinceDigestOpened = daysWithoutActivity(agenda, this.now());
      const verdict = directionVerdict({ episodesWithoutGatedClaim: without, consecutiveFailures: failures, daysSinceDigestOpened, userRejected: false });
      const paused = ["pause-type", "pause-thread", "park"].includes(verdict.action);
      try {
        return await this.documents.put(userId, "agenda", agenda.id, {
          ...agenda.payload,
          enabled: paused ? false : agenda.payload.enabled,
          status: paused ? "paused" : "active",
          pauseReason: paused ? verdict.reason : null,
          consecutiveFailures: failures,
          episodesWithoutGatedClaim: without,
          outcomes: [...(agenda.payload.outcomes ?? []), {
            episodeId, status, gatedClaims, at: this.now().toISOString(),
          }].slice(-100),
          updatedAt: this.now().toISOString(),
        }, { expectedRevision: agenda.revision, projectId: agenda.projectId });
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    throw new HttpError(409, "autopilot_outcome_conflict", "The research agenda changed repeatedly while recording its outcome.");
  }

  /** @param {string} userId @param {string} agendaId @param {Record<string,any>} input */
  async createDigest(userId, agendaId, input) {
    const agenda = await this.get(userId, agendaId);
    const claims = Array.isArray(input.claims) ? input.claims.slice(0, 500) : [];
    const headlines = [];
    const leads = [];
    for (const claim of claims) (digestPlacement(claim).headline ? headlines : leads).push(claim);
    const digestId = input.digestId == null ? this.id("digest-") : text(input.digestId, "digest id", 160);
    let digest;
    try {
      digest = await this.documents.put(userId, "digest", digestId, {
        schemaVersion: 1, agendaId: agenda.id, date: text(input.date, "digest date", 10),
        episodeIds: listOfText(input.episodeIds, "episode ids"), costCny: budget(input.costCny, "digest cost", { allowZero: true }),
        headlines, leads, decisions: [], openedAt: null, createdAt: this.now().toISOString(), updatedAt: this.now().toISOString(),
      }, { expectedRevision: 0, projectId: agenda.projectId });
    } catch (error) {
      if (!isConflict(error)) throw error;
      digest = await this.getDigest(userId, digestId);
      if (digest.projectId !== agenda.projectId || digest.payload.agendaId !== agenda.id) throw new HttpError(409, "autopilot_digest_conflict", "Digest identity belongs to another agenda.");
    }
    if (this.notifications) await this.notifications.create(userId, {
      noticeType: "review", title: `主动科研简报：${agenda.payload.title}`,
      body: `${headlines.length} 条重点发现，${leads.length} 条待验证线索。`, projectId: agenda.projectId,
      source: { type: "digest", id: digest.id }, idempotencyKey: `autopilot-digest:${digest.id}`,
      actions: [{ id: "open", label: "查看简报" }],
    });
    return digest;
  }

  /** @param {string} userId @param {string} digestId @param {{action:string,claimId:string,note?:string}} input */
  async decide(userId, digestId, input) {
    const digest = await this.getDigest(userId, digestId);
    const action = text(input.action, "decision action", 32);
    if (!["adopt", "reject", "question"].includes(action)) throw new HttpError(400, "autopilot_payload_invalid", "Digest action is invalid.");
    const claimId = text(input.claimId, "claim id", 160);
    if (![...(digest.payload.headlines ?? []), ...(digest.payload.leads ?? [])].some((claim) => claim.id === claimId)) {
      throw new HttpError(404, "autopilot_claim_not_found", "Digest claim is unavailable.");
    }
    return this.documents.put(userId, "digest", digest.id, {
      ...digest.payload,
      decisions: [...(digest.payload.decisions ?? []), {
        action, claimId, note: input.note == null ? "" : String(input.note).slice(0, 1000), at: this.now().toISOString(),
      }],
      updatedAt: this.now().toISOString(),
    }, { expectedRevision: digest.revision, projectId: digest.projectId });
  }

  revision(record, expected) {
    if (!Number.isSafeInteger(expected) || expected !== record.revision) throw new HttpError(409, "autopilot_revision_conflict", "The research agenda changed; reload before saving.");
  }
}
