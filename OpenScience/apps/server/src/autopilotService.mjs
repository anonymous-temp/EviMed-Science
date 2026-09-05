import { createHash, randomUUID } from "node:crypto";
import { AUTOPILOT_TASK_TYPES, digestPlacement, directionVerdict } from "@evimed/domain";
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
      lastDigestOpenedAt: now,
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

  /** @param {string} userId @param {string} agendaId @param {{expectedRevision:number}} input */
  async start(userId, agendaId, input) {
    const agenda = await this.get(userId, agendaId);
    this.revision(agenda, input.expectedRevision);
    return this.documents.put(userId, "agenda", agenda.id, {
      ...agenda.payload, enabled: true, status: "active", pauseReason: null,
      consecutiveFailures: 0, updatedAt: this.now().toISOString(),
    }, { expectedRevision: agenda.revision, projectId: agenda.projectId });
  }

  /** @param {string} userId @param {string} agendaId @param {{expectedRevision:number}} input */
  async stop(userId, agendaId, input) {
    const agenda = await this.get(userId, agendaId);
    this.revision(agenda, input.expectedRevision);
    return this.documents.put(userId, "agenda", agenda.id, {
      ...agenda.payload, enabled: false, status: "stopped", pauseReason: "Stopped by the researcher.", updatedAt: this.now().toISOString(),
    }, { expectedRevision: agenda.revision, projectId: agenda.projectId });
  }

  /** @param {string} userId @param {string} agendaId @param {{date:string}} input */
  async schedule(userId, agendaId, input) {
    const agenda = await this.get(userId, agendaId);
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
      idempotencyKey: `episode:${agenda.id}:${date}`, projectId: agenda.projectId, maxAttempts: 3,
    });
    if (agenda.payload.lastScheduledDate !== date) {
      await this.documents.put(userId, "agenda", agenda.id, { ...agenda.payload, lastScheduledDate: date, updatedAt: this.now().toISOString() },
        { expectedRevision: agenda.revision, projectId: agenda.projectId }).catch((error) => { if (!isConflict(error)) throw error; });
    }
    return { episode, job };
  }

  /** @param {string} userId @param {string} agendaId @param {Record<string,any>} input */
  async recordOutcome(userId, agendaId, input) {
    const agenda = await this.get(userId, agendaId);
    this.revision(agenda, input.expectedRevision);
    const status = text(input.status, "episode status", 32);
    if (!["succeeded", "failed", "canceled"].includes(status)) throw new HttpError(400, "autopilot_payload_invalid", "Episode outcome is invalid.");
    const gatedClaims = Number(input.gatedClaims);
    if (!Number.isSafeInteger(gatedClaims) || gatedClaims < 0 || gatedClaims > 100_000) throw new HttpError(400, "autopilot_payload_invalid", "Gated claim count is invalid.");
    const failures = status === "failed" ? Number(agenda.payload.consecutiveFailures ?? 0) + 1 : 0;
    const without = gatedClaims === 0 ? Number(agenda.payload.episodesWithoutGatedClaim ?? 0) + 1 : 0;
    const daysSinceDigestOpened = Math.max(0, Math.floor((this.now().getTime() - Date.parse(agenda.payload.lastDigestOpenedAt)) / 86_400_000));
    const verdict = directionVerdict({ episodesWithoutGatedClaim: without, consecutiveFailures: failures, daysSinceDigestOpened, userRejected: false });
    const paused = ["pause-type", "pause-thread", "park"].includes(verdict.action);
    return this.documents.put(userId, "agenda", agenda.id, {
      ...agenda.payload,
      enabled: paused ? false : agenda.payload.enabled,
      status: paused ? "paused" : "active",
      pauseReason: paused ? verdict.reason : null,
      consecutiveFailures: failures,
      episodesWithoutGatedClaim: without,
      outcomes: [...(agenda.payload.outcomes ?? []), {
        episodeId: text(input.episodeId, "episode id", 160), status, gatedClaims, at: this.now().toISOString(),
      }].slice(-100),
      updatedAt: this.now().toISOString(),
    }, { expectedRevision: agenda.revision, projectId: agenda.projectId });
  }

  /** @param {string} userId @param {string} agendaId @param {Record<string,any>} input */
  async createDigest(userId, agendaId, input) {
    const agenda = await this.get(userId, agendaId);
    const claims = Array.isArray(input.claims) ? input.claims.slice(0, 500) : [];
    const headlines = [];
    const leads = [];
    for (const claim of claims) (digestPlacement(claim).headline ? headlines : leads).push(claim);
    const digest = await this.documents.put(userId, "digest", this.id("digest-"), {
      schemaVersion: 1, agendaId: agenda.id, date: text(input.date, "digest date", 10),
      episodeIds: listOfText(input.episodeIds, "episode ids"), costCny: budget(input.costCny, "digest cost", { allowZero: true }),
      headlines, leads, decisions: [], openedAt: null, createdAt: this.now().toISOString(), updatedAt: this.now().toISOString(),
    }, { expectedRevision: 0, projectId: agenda.projectId });
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
