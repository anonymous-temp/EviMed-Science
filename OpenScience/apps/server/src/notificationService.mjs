import { createHash, randomUUID } from "node:crypto";
import { NOTICE_PRIORITY, NOTICE_TYPES, connectorCredentialSpec, errorCodeMessage, runOutcomeKind, summarizeGateNotices } from "@evimed/domain";
import { describedQualityNotices } from "./runNotices.mjs";
import { HttpError } from "./security.mjs";
import { migrateNotifications } from "./notificationPersistence.mjs";
import { productId, productInteger } from "./productPersistence.mjs";

/**
 * How much an inbox item may interrupt (contract C1, 2026-09-18). `safety` is
 * a clinical-safety finding and the only class allowed to interrupt; a person
 * has something to do on `attention`; `info` records something that happened.
 */
export const INBOX_SEVERITIES = Object.freeze(["safety", "attention", "info"]);
const severityRank = Object.freeze({ info: 0, attention: 1, safety: 2 });

/**
 * How long a read item is kept, counted from when it was read (C1). Unread
 * items are never swept: the reader has not seen them. Neither is a question
 * or review that is read but unresolved, because it is still asking.
 */
export const INBOX_READ_RETENTION_DAYS = 90;

/** @param {unknown} value @param {string} name @param {number} max */
function text(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new HttpError(400, "notification_payload_invalid", `Invalid ${name}.`);
  }
  return value.trim();
}

/** @param {unknown} value @param {string} name */
function timestamp(value, name) {
  if (value == null) return null;
  const time = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(time.getTime())) throw new HttpError(400, "notification_payload_invalid", `Invalid ${name}.`);
  return time.toISOString();
}

/** @param {unknown} value */
function actions(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8) throw new HttpError(400, "notification_payload_invalid", "Invalid actions.");
  const ids = new Set();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["id", "label", "style"].includes(key))) {
      throw new HttpError(400, "notification_payload_invalid", "Invalid action.");
    }
    const id = productId(item.id, "action");
    if (ids.has(id)) throw new HttpError(400, "notification_payload_invalid", "Duplicate action.");
    ids.add(id);
    const style = item.style ?? "neutral";
    if (!["neutral", "primary", "danger"].includes(style)) throw new HttpError(400, "notification_payload_invalid", "Invalid action style.");
    return { id, label: text(item.label, "action label", 80), style };
  });
}

/** @param {unknown} value */
function source(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "notification_payload_invalid", "Invalid source.");
  }
  const item = /** @type {Record<string, any>} */ (value);
  // `memory` arrived 2026-09-16: a notice about a memory that named no memory
  // left the inbox saying a record had changed and offering no way to reach it
  // (review, M4①).
  if (Object.keys(item).sort().join(",") !== "id,type" || !["run", "thread", "share", "system", "digest", "memory"].includes(item.type)) {
    throw new HttpError(400, "notification_payload_invalid", "Invalid source.");
  }
  return { type: item.type, id: productId(item.id, "source") };
}

/** @param {any} row */
function record(row) {
  return row ? {
    id: row.id, userId: row.user_id, projectId: row.project_id, noticeType: row.notice_type,
    priority: Number(row.priority), title: row.title, body: row.body, actions: row.actions,
    source: row.source, groupKey: row.group_key, count: Number(row.event_count),
    dueAt: row.due_at == null ? null : new Date(row.due_at).toISOString(), defaultAction: row.default_action,
    readAt: row.read_at == null ? null : new Date(row.read_at).toISOString(),
    resolvedAt: row.resolved_at == null ? null : new Date(row.resolved_at).toISOString(),
    resolution: row.resolution, channelsSent: row.channels_sent, revision: Number(row.revision),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    // A row written before this column existed reads as the quiet default,
    // which is what it was.
    severity: INBOX_SEVERITIES.includes(row.severity) ? row.severity : "info",
  } : null;
}

/** @param {unknown} value @returns {string | null} */
function inboxProjectScope(value) {
  if (value == null || value === "") return null;
  return productId(value, "project");
}

/**
 * The notification switches a preferences row may be saved with: the three
 * the inbox began with, and those three plus `frontier` — the 「前沿动态」
 * daily (build spec D.3, on unless turned off).
 */
export const NOTIFICATION_SWITCH_KEY_SETS = Object.freeze(["notify,question,review", "frontier,notify,question,review"]);

/**
 * An account's switches as every reader of them sees them: a row written
 * before `frontier` existed has none, and reads as on — the default the
 * daily push and the Feishu push both apply.
 * @param {unknown} value @returns {Record<string, boolean>}
 */
export function notificationSwitches(value) {
  const switches = value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {};
  return { ...switches, frontier: switches.frontier !== false };
}

function validTime(value, name) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new HttpError(400, "notification_preferences_invalid", `Invalid ${name}.`);
  }
  return value;
}

function sameSemantics(item, values) {
  const dueAt = item.dueAt == null ? null : new Date(item.dueAt).toISOString();
  const expectedActions = JSON.parse(values.actions);
  const expectedSource = JSON.parse(values.source);
  const actionsMatch = item.actions.length === expectedActions.length && item.actions.every((action, index) => {
    const expected = expectedActions[index];
    return action.id === expected.id && action.label === expected.label && action.style === expected.style;
  });
  const sourceMatches = item.source == null ? expectedSource == null
    : expectedSource != null && item.source.id === expectedSource.id && item.source.type === expectedSource.type;
  return item.projectId === values.projectId && item.noticeType === values.noticeType
    && item.priority === values.priority && item.title === values.title && item.body === values.body
    && actionsMatch && sourceMatches
    && item.groupKey === values.groupKey && dueAt === values.dueAt && item.defaultAction === values.defaultAction;
}

/** Durable in-app notification, question and review inbox. */

/**
 * The words a finished run's notice may end its title with, and nothing else
 * (plan 2026-09-23 §5.8): 已完成, 待核对 — finished, and something in it is
 * marked for the reader to check — 未完成 and 已停止. 「研究已交付」 beside
 * 「研究已完成」 was a distinction only the delivery gate could read.
 */
export const RUN_NOTICE_STATUS_WORDS = Object.freeze(["已完成", "待核对", "未完成", "已停止"]);

/** The word for each outcome class of the domain registry (`RUN_OUTCOME_KINDS`). */
const STATUS_BY_OUTCOME = Object.freeze({
  delivered: "已完成", qualified: "已完成",
  // The platform ended it — a timer, a cancel, an outage. Never a statement
  // about the work, so never 未完成 either.
  stopped: "已停止",
  gated: "未完成", capped: "未完成", upstream: "未完成", unknown: "未完成",
});

/**
 * What the inbox says about a finished run: the research's own name and one
 * status word as the title, and as the body the result and where to look.
 *
 * 「研究结果已准备好，报告与文件都在这条对话里。本次运行产出 6 个文件，仍在工作区
 * 里，可以直接打开。」 became 「〈研究标题〉 已完成」 · 「报告和 6 个文件已在对话里」:
 * nothing about the workspace, the files' custody or how checks work — the
 * one fact a reader acts on is whether something is marked for them to check.
 *
 * 待核对 counts what the reader finds marked ⚠ in the report's 「依据」: the
 * claims whose quotation was not found in the source they name — the run's own
 * count (`claimSummary.unverified`), the same number the conversation shows. A
 * run that counted no claims falls back to the delivery check's must-fix
 * findings, which are that defect seen from the gate.
 *
 * Clinical safety is the one exception, and the only class allowed to
 * interrupt (C1): the title states the fact, 「〈研究标题〉：有 1 处用药安全提示」.
 *
 * A pure function over the run record, so the mapping is testable and there is
 * exactly one of it. Why a run did not finish comes from the domain registry
 * (`errorCodeMessage`) rather than a table here, because a second table is how
 * the frontend ended up with three; no finding's own sentence ever reaches the
 * body — the gate's English repair instructions once did (2026-09-18 review,
 * E §9.7).
 * @param {{status?: string, errorCode?: string|null, verification?: string|null, missingCredential?: string|null,
 *          title?: string|null, question?: string|null,
 *          artifacts?: string[], unverifiedArtifacts?: string[], qualityNotices?: (string | Record<string, any>)[],
 *          claimSummary?: { total?: number, verified?: number, unverified?: number } | null,
 *          artifactCounts?: { deliverable?: number, revisionNotes?: number, work?: number, superseded?: number }}} run
 * @returns {{ outcome: string, status: string, title: string, body: string, severity: 'safety'|'attention'|'info',
 *   pending: number, counts: { safety: number, mustFix: number, advice: number } }}
 */
export function runFinishedNotice(run) {
  const outcome = runOutcomeKind(run);
  const finished = outcome === "delivered" || outcome === "qualified";
  // A source the researcher can open themselves (`missingCredential`, set only
  // for a known connector): said as the one thing to do, not as a failure.
  const credential = run?.missingCredential ? connectorCredentialSpec(run.missingCredential) : null;
  const summary = summarizeGateNotices(describedQualityNotices(run?.qualityNotices ?? []));
  const claims = run?.claimSummary;
  const pending = !finished ? 0
    : claims && Number(claims.total) > 0 && Number.isFinite(Number(claims.unverified))
      ? Math.max(0, Math.trunc(Number(claims.unverified)))
      : summary.mustFix;
  const status = credential ? "未完成"
    : finished && pending > 0 ? "待核对" : STATUS_BY_OUTCOME[/** @type {keyof typeof STATUS_BY_OUTCOME} */ (outcome)] ?? "未完成";
  const label = runLabel(run);
  const title = summary.safety > 0 ? `${label}：有 ${summary.safety} 处用药安全提示` : `${label} ${status}`;
  let body;
  if (credential) {
    body = `缺少 ${credential.title} 的访问凭据。可在「设置 → 数据源」填入后重新发起。`;
  } else if (!finished) {
    body = errorCodeMessage(run?.errorCode ?? "");
  } else {
    // What was delivered, apart from what the run wrote for itself on the way
    // (`artifactCounts`, runArtifacts.mjs): the aspirin run of 2026-09-19 left
    // five deliverable files, one revision note and 24 scratch scripts, and
    // 「产出 30 个文件」 counted the scripts as products.
    const counts = run?.artifactCounts;
    const files = counts && Number.isFinite(counts.deliverable)
      ? Number(counts.deliverable) + (Number(counts.revisionNotes) || 0)
      : [...(run?.artifacts ?? []), ...(run?.unverifiedArtifacts ?? [])].length;
    const where = files > 0 ? `报告和 ${files} 个文件已在对话里` : "结果已在对话里";
    body = pending > 0 ? `${where}，${pending} 处引用待核对` : where;
  }
  // Only clinical safety may interrupt (C1); something the reader must check,
  // or a run that did not finish, is attention; a clean delivery is
  // information.
  const severity = summary.safety > 0 ? "safety" : !finished || credential || pending > 0 ? "attention" : "info";
  return {
    outcome, status: summary.safety > 0 ? `有 ${summary.safety} 处用药安全提示` : status, title, body, severity, pending,
    counts: { safety: summary.safety, mustFix: summary.mustFix, advice: summary.advice },
  };
}

// China Standard Time has kept one offset since 1991, so a fixed +8 h is exact
// and needs no time-zone database — the control-plane container is UTC and
// carries none (memory note "Node reads TZ without tzdata").
const shanghaiOffsetMs = 8 * 3_600_000;

/**
 * The calendar day a moment falls on for a researcher in China, `YYYY-MM-DD`.
 * @param {unknown} value @returns {string | null}
 */
export function shanghaiDay(value) {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? new Date(time + shanghaiOffsetMs).toISOString().slice(0, 10) : null;
}

/**
 * What a run is called in an inbox line: its title, else what was asked,
 * cut to fit one line. The researcher's own words or the platform's title for
 * them — never anything a validator wrote.
 * @param {Record<string, any>} run
 */
function runLabel(run) {
  const label = [run?.title, run?.question].find((value) => typeof value === "string" && value.trim());
  if (!label) return "一项研究";
  const characters = [...label.replace(/\s+/g, " ").trim()];
  return characters.length > 24 ? `${characters.slice(0, 23).join("")}…` : characters.join("");
}

/**
 * Whether a finished run is one of the moments the inbox tells a person about
 * (C1: 完成 / 需要你 / 结论变了).
 *
 * Two endings are not: a dispatch refused before it started was already
 * answered by the request that made it, and a run the researcher stopped is
 * not news to them. One the platform stopped is, and says so
 * (「〈研究标题〉 已停止」). A stop the kernel reported without saying who
 * asked is counted as the person's: the platform's own stops are recorded as
 * its own.
 * @param {Record<string, any>} run
 */
export function runFinishedNotifies(run) {
  if (run?.dispatchStatus === "rejected") return false;
  if (run?.status === "canceled" && run?.canceledBy !== "platform") return false;
  // A conversation turn the reader watched finish: answered in the chat, no
  // file, in under two minutes. Its notice said 「研究结果已准备好，可以查看运行
  // 记录和交付物」 about a two-sentence answer already on screen, with nothing
  // to open (2026-09-19 live walk: a 3-second question lit the bell). A run
  // that took longer may have been left to work, and one with a clinical
  // safety finding interrupts whatever its length.
  if (run?.status === "succeeded" && !run?.errorCode && Number(run?.durationMs) < WATCHED_TURN_MS
    && [...(run?.artifacts ?? []), ...(run?.unverifiedArtifacts ?? [])].length === 0
    && runFinishedNotice(run).severity !== "safety") return false;
  return true;
}

/** How long a turn may take and still count as one the reader watched. */
const WATCHED_TURN_MS = 120_000;

/**
 * Whether a finished run produces an inbox item at all.
 *
 * Only a person's own research does. An evaluation, and the platform's own
 * background work — a lesson, a document being read — leave no item, not even
 * one recorded quietly: those used to arrive already read and folded under
 * 「自动运行 N 条（评测与主动科研，不计入未读）」, a backstage count in the
 * reader's inbox (plan 2026-09-23 §5.8). An autopilot episode, or the
 * verification of one of its claims, reports through its digest, which is an
 * ordinary notice (`AutopilotService.createDigest`).
 *
 * @param {Record<string, any>} run
 * @param {{ internalProject?: boolean, evaluation?: boolean, automated?: boolean, autopilotOwned?: boolean }} [origin]
 *   `internalProject` — the run is in one of the account's own background
 *   projects (`isInternalProject`); `evaluation` — its runtime is an
 *   evaluation cell's; `automated` — a harness or autopilot dispatched it
 *   (`automatedRun`); `autopilotOwned` — an autopilot episode owns it.
 */
export function runFinishedReachesInbox(run, { internalProject = false, evaluation = false, automated = false, autopilotOwned = false } = {}) {
  if (internalProject || evaluation || automated || autopilotOwned) return false;
  return runFinishedNotifies(run);
}

/** @param {{ outcome: string, severity: string }} notice */
function routineCompletion(notice) {
  return (notice.outcome === "delivered" || notice.outcome === "qualified") && notice.severity !== "safety";
}

/**
 * The inbox item a finished run produces, grouped by project and day.
 *
 * Routine completions — finished, with nothing touching clinical safety —
 * share one item per project per day
 * (`run-finished:<project>:<YYYY-MM-DD, Asia/Shanghai>`), so an afternoon of
 * ten runs is one line saying ten instead of ten lines (2026-09-18 plan §8.5):
 * 「8 项研究已完成，其中 1 项有 1 处引用待核对」, and the body only names them,
 * the ones with something to check first. A safety finding and every run that
 * did not finish stand alone: they are the 「需要你」 moment and must not be
 * folded under a count.
 *
 * `peers` are the project's other finished runs a person asked for, and the
 * group is recomposed from them each time, so the item always says what the
 * ledger says.
 *
 * @param {{ id: string }} project
 * @param {Record<string, any>} run
 * @param {{ peers?: readonly Record<string, any>[] }} [options]
 */
export function runFinishedInboxItem(project, run, { peers = [] } = {}) {
  const notice = runFinishedNotice(run);
  const base = {
    noticeType: "notify",
    // Without an action the card renders no control at all, so a notice that
    // names a run could not open it. The frontend turns this id into the
    // run's conversation; resolving it here would mean knowing its routes.
    // One label for it everywhere (plan 2026-09-23 C §1.14).
    actions: [{ id: "open", label: "打开对话", style: "primary" }],
    projectId: project.id,
    source: { type: "run", id: run.id },
    idempotencyKey: `run-finished:${run.id}`,
    severity: notice.severity,
  };
  const day = shanghaiDay(run.finishedAt ?? run.startedAt);
  if (!routineCompletion(notice) || !day) return { ...base, title: notice.title, body: notice.body };
  const groupKey = `run-finished:${project.id}:${day}`;
  const seen = new Set([run.id]);
  const members = [{ run, notice }];
  for (const peer of peers) {
    if (!peer?.id || seen.has(peer.id) || peer.status === "running" || shanghaiDay(peer.finishedAt) !== day) continue;
    const peerNotice = runFinishedNotice(peer);
    if (!routineCompletion(peerNotice)) continue;
    seen.add(peer.id);
    members.push({ run: peer, notice: peerNotice });
  }
  if (members.length === 1) return { ...base, groupKey, title: notice.title, body: notice.body };
  // The ones with something to check first, so the names the body leads with
  // are the ones the title counts; newest first within each.
  members.sort((left, right) => Number(right.notice.pending > 0) - Number(left.notice.pending > 0)
    || String(right.run.finishedAt ?? "").localeCompare(String(left.run.finishedAt ?? "")));
  const checking = members.filter((member) => member.notice.pending > 0);
  const pending = checking.reduce((sum, member) => sum + member.notice.pending, 0);
  const named = members.slice(0, 3).map((member) => runLabel(member.run));
  return {
    ...base,
    groupKey,
    title: `${members.length} 项研究已完成${checking.length ? `，其中 ${checking.length} 项有 ${pending} 处引用待核对` : ""}`,
    body: `${named.join("、")}${members.length > named.length ? ` 等 ${members.length} 项` : ""}`,
    severity: checking.length ? "attention" : "info",
  };
}

export class NotificationService {
  /** @param {any} database */
  constructor(database) {
    this.database = database;
    // Set by the IM module when it is composed (X6): the channel registry the
    // preferences are validated against, the hook that tells it an item
    // changed, and the one that carries out an action it put on its own
    // notice. Absent, the inbox is exactly what it was — in-app only.
    /** @type {{ registry: any, onChange: (item: any) => void, onAction?: (item: any, actionId: string) => Promise<void> } | null} */
    this.channels = null;
  }

  /**
   * Attach the channel registry and the push hook. Other modules never import
   * a channel adapter; they create inbox items, and this is where an item
   * becomes a push.
   * @param {{ registry: any, onChange: (item: any) => void, onAction?: (item: any, actionId: string) => Promise<void> }} channels
   */
  attachChannels(channels) {
    this.channels = channels;
  }

  async health() {
    await migrateNotifications(this.database);
    const result = await this.database.query("SELECT count(*)::integer AS unresolved FROM evimed_inbox.notifications WHERE resolved_at IS NULL");
    return {
      connected: true, unresolved: Number(result.rows[0]?.unresolved ?? 0), channel: "in-app",
      channels: ["in-app", ...(this.channels?.registry?.enabledIds() ?? [])],
    };
  }

  /** @param {string} userId @param {Record<string,any>} input @param {{now?:Date}} options */
  async create(userId, input, { now = new Date() } = {}) {
    const user = productId(userId, "user");
    const noticeType = String(input.noticeType ?? "");
    if (!NOTICE_TYPES.includes(noticeType)) throw new HttpError(400, "notification_payload_invalid", "Invalid notice type.");
    const createdAt = timestamp(now, "creation time");
    const actionList = actions(input.actions);
    if (noticeType !== "notify" && actionList.length === 0) throw new HttpError(400, "notification_payload_invalid", "Blocking inbox items require actions.");
    const defaultAction = input.defaultAction == null ? null : productId(input.defaultAction, "default action");
    if (defaultAction && !actionList.some((item) => item.id === defaultAction)) throw new HttpError(400, "notification_action_invalid", "Default action is unavailable.");
    if (defaultAction && input.dueAt == null) throw new HttpError(400, "notification_payload_invalid", "A default action requires a due time.");
    // Blocking items ask a person for something, so they default to
    // attention; a plain notice defaults to information.
    const severity = input.severity == null ? (noticeType === "notify" ? "info" : "attention") : String(input.severity);
    if (!INBOX_SEVERITIES.includes(severity)) throw new HttpError(400, "notification_payload_invalid", "Invalid severity.");
    // There is no quiet record any more (plan 2026-09-23 §5.8). Automated work
    // and platform housekeeping used to be stored already read and shown under
    // 「自动运行 N 条」; now they leave no item at all. A caller that still asks
    // for one is refused, not turned into a notice that lights the bell.
    if (input.silent === true) {
      throw new HttpError(400, "notification_payload_invalid", "Silent inbox records are retired: work nobody asked about leaves no inbox item.");
    }
    const values = {
      id: input.idempotencyKey == null ? randomUUID() : `notification:${createHash("sha256")
        .update(JSON.stringify([user, text(input.idempotencyKey, "idempotency key", 200)])).digest("hex")}`,
      user, projectId: input.projectId == null ? null : productId(input.projectId, "project"),
      noticeType, priority: NOTICE_PRIORITY[noticeType], title: text(input.title, "title", 150), body: text(input.body, "body", 8000),
      actions: JSON.stringify(actionList), source: JSON.stringify(source(input.source)),
      groupKey: input.groupKey == null ? null : text(input.groupKey, "group key", 200),
      dueAt: timestamp(input.dueAt, "due time"), defaultAction, createdAt, severity,
    };
    await migrateNotifications(this.database);
    const saved = await this.database.transaction(async (client) => {
      if (input.idempotencyKey != null) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-inbox-key:${values.id}`]);
        // An event already folded into a grouped item returns that item as it
        // stands now: the group has moved on since, so comparing content with
        // this one event would call every replay a conflict.
        const folded = await client.query(`SELECT n.* FROM evimed_inbox.merged_events e
          JOIN evimed_inbox.notifications n ON n.id=e.notification_id WHERE e.id=$1 AND n.user_id=$2`, [values.id, values.user]);
        if (folded.rowCount) return record(folded.rows[0]);
        const prior = await client.query("SELECT * FROM evimed_inbox.notifications WHERE id=$1 FOR UPDATE", [values.id]);
        if (prior.rowCount) {
          const item = record(prior.rows[0]);
          if (item.userId === values.user && sameSemantics(item, values)) return item;
          throw new HttpError(409, "notification_idempotency_conflict", "The notification key already names different content.");
        }
      }
      if (values.noticeType === "notify" && values.groupKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `evimed-inbox:${JSON.stringify([values.user, values.projectId, values.groupKey])}`,
        ]);
        // One row per key. The key carries its own period — a run-finished
        // key names the project and the day — so there is no time window
        // here, and a row the reader already read or opened is brought back
        // rather than joined by a second one: 「4 项研究已完成」 is one item
        // that says four, not a read one saying three beside a new one saying
        // one.
        const existing = await client.query(`SELECT * FROM evimed_inbox.notifications
          WHERE user_id=$1 AND notice_type='notify' AND group_key=$2 AND project_id IS NOT DISTINCT FROM $3::text
          ORDER BY created_at DESC,id DESC FOR UPDATE LIMIT 1`, [values.user, values.groupKey, values.projectId]);
        if (existing.rowCount) {
          const current = existing.rows[0];
          const strongest = severityRank[values.severity] > (severityRank[current.severity] ?? 0) ? values.severity : current.severity;
          const merged = await client.query(`UPDATE evimed_inbox.notifications SET title=$2,body=$3,actions=$4::jsonb,source=$5::jsonb,
            severity=$6,read_at=NULL,resolved_at=NULL,resolution=NULL,
            event_count=LEAST(event_count+1,10000),revision=revision+1,
            created_at=GREATEST(created_at,$7::timestamptz),updated_at=$7::timestamptz
            WHERE id=$1 RETURNING *`,
          [current.id, values.title, values.body, values.actions, values.source, strongest, values.createdAt]);
          if (input.idempotencyKey != null) {
            await client.query(`INSERT INTO evimed_inbox.merged_events(id,notification_id,created_at) VALUES($1,$2,$3::timestamptz)
              ON CONFLICT(id) DO NOTHING`, [values.id, current.id, values.createdAt]);
          }
          return record(merged.rows[0]);
        }
      }
      const inserted = await client.query(`INSERT INTO evimed_inbox.notifications
        (id,user_id,project_id,notice_type,priority,title,body,actions,source,group_key,due_at,default_action,channels_sent,
         severity,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,jsonb_build_object('in-app',$13::text),
         $14,$13::timestamptz,$13::timestamptz)
        ON CONFLICT(id) DO NOTHING RETURNING *`,
      [values.id, values.user, values.projectId, values.noticeType, values.priority, values.title, values.body,
        values.actions, values.source, values.groupKey, values.dueAt, values.defaultAction, values.createdAt,
        values.severity]);
      if (inserted.rowCount && values.groupKey && input.idempotencyKey != null) {
        // The first event of a group is recorded like every later one, so a
        // replay of it is recognised after the group has changed its content.
        await client.query(`INSERT INTO evimed_inbox.merged_events(id,notification_id,created_at) VALUES($1,$1,$2::timestamptz)
          ON CONFLICT(id) DO NOTHING`, [values.id, values.createdAt]);
      }
      if (inserted.rowCount) return record(inserted.rows[0]);
      const existing = await client.query("SELECT * FROM evimed_inbox.notifications WHERE user_id=$1 AND id=$2", [values.user, values.id]);
      const item = record(existing.rows[0]);
      if (item && item.userId === values.user && sameSemantics(item, values)) return item;
      throw new HttpError(409, "notification_idempotency_conflict", "The notification key already names different content.");
    });
    // After the commit, never inside it: a push is a network call, and the
    // channel's outbox is idempotent per (item, event), so announcing a
    // replayed item costs nothing. The hook never fails the write.
    if (this.channels && saved) {
      try { this.channels.onChange(saved); } catch { /* isolated: evimed_im_events_total{kind="notice_hook_failed"} */ }
    }
    return saved;
  }

  /** @param {string} userId @param {{limit?:number,cursor?:string|null,noticeType?:string|null,unreadOnly?:boolean,unresolvedOnly?:boolean,projectId?:string|null}} options */
  async list(userId, { limit = 50, cursor = null, noticeType = null, unreadOnly = false, unresolvedOnly = false, projectId = null } = {}) {
    productInteger(limit, 1, 100);
    if (noticeType != null && !NOTICE_TYPES.includes(noticeType)) throw new HttpError(400, "notification_filter_invalid", "Invalid notice type.");
    if (typeof unreadOnly !== "boolean" || typeof unresolvedOnly !== "boolean") throw new HttpError(400, "notification_filter_invalid", "Invalid inbox filter.");
    const project = inboxProjectScope(projectId);
    let after = null;
    if (cursor) {
      try {
        after = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(after) || after.length !== 3 || !Number.isInteger(after[0]) || !Number.isFinite(Date.parse(after[1]))) throw new Error();
        productId(after[2]);
      } catch { throw new HttpError(400, "notification_cursor_invalid", "Invalid inbox cursor."); }
    }
    await migrateNotifications(this.database);
    const result = await this.database.query(`SELECT * FROM evimed_inbox.notifications WHERE user_id=$1
      AND ($2::text IS NULL OR notice_type=$2) AND (NOT $3::boolean OR read_at IS NULL)
      AND (NOT $4::boolean OR resolved_at IS NULL)
      AND ($9::text IS NULL OR project_id=$9 OR project_id IS NULL)
      AND ($5::smallint IS NULL OR priority>$5 OR (priority=$5 AND (created_at,id)<($6::timestamptz,$7::text)))
      ORDER BY priority,created_at DESC,id DESC LIMIT $8`,
    [productId(userId, "user"), noticeType, unreadOnly, unresolvedOnly, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, limit + 1, project]);
    const items = result.rows.slice(0, limit).map(record);
    const last = items.at(-1);
    // The count of everything unread in the same scope, not this page's
    // length: the page is capped, and a badge that counted the page could
    // never say more than fifty (B §1c).
    const { unreadTotal } = await this.unreadCount(userId, { projectId: project });
    return { items, nextCursor: result.rows.length > limit && last
      ? Buffer.from(JSON.stringify([last.priority, last.createdAt, last.id])).toString("base64url") : null, unreadTotal };
  }

  /**
   * The bell's whole input: how many items are unread, and how many of those
   * are clinical-safety findings — the one class allowed to interrupt.
   *
   * Scoped like the list: every project of the account unless a project is
   * named, and then that project plus the account-wide items (a user-scoped
   * memory notice belongs to no project and to every one).
   * @param {string} userId @param {{ projectId?: string | null }} [options]
   */
  async unreadCount(userId, { projectId = null } = {}) {
    const project = inboxProjectScope(projectId);
    await migrateNotifications(this.database);
    const result = await this.database.query(`SELECT count(*)::integer AS unread,
      count(*) FILTER (WHERE severity='safety')::integer AS safety
      FROM evimed_inbox.notifications WHERE user_id=$1 AND read_at IS NULL
      AND ($2::text IS NULL OR project_id=$2 OR project_id IS NULL)`, [productId(userId, "user"), project]);
    return { unreadTotal: Number(result.rows[0]?.unread ?? 0), safetyUnread: Number(result.rows[0]?.safety ?? 0) };
  }

  /**
   * Marks every unread item read, whatever actions it carries (C1).
   *
   * No revision precondition, unlike the per-item path: "everything I have
   * not read, I have now seen" is idempotent and does not race with anything
   * a revision would protect. Resolution is untouched — a question marked
   * read is still a question.
   * @param {string} userId @param {{ projectId?: string | null, noticeType?: string | null }} [options]
   */
  async markAllRead(userId, { projectId = null, noticeType = null } = {}) {
    if (noticeType != null && !NOTICE_TYPES.includes(noticeType)) throw new HttpError(400, "notification_filter_invalid", "Invalid notice type.");
    const project = inboxProjectScope(projectId);
    await migrateNotifications(this.database);
    const result = await this.database.query(`UPDATE evimed_inbox.notifications
      SET read_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
      WHERE user_id=$1 AND read_at IS NULL AND ($2::text IS NULL OR project_id=$2 OR project_id IS NULL)
      AND ($3::text IS NULL OR notice_type=$3)`, [productId(userId, "user"), project, noticeType]);
    return { updated: Number(result.rowCount ?? 0) };
  }

  /**
   * Deletes items read more than `INBOX_READ_RETENTION_DAYS` ago (C1).
   *
   * Nothing deleted an inbox row before this; rows left only when their user
   * or project did (B §1d). Bounded per call so a first sweep over a long
   * history is a series of short transactions rather than one long one; the
   * caller runs it again on its next tick.
   * @param {{ now?: Date, retentionDays?: number, limit?: number }} [options]
   * @returns {Promise<number>} how many items were deleted
   */
  async pruneRead({ now = new Date(), retentionDays = INBOX_READ_RETENTION_DAYS, limit = 1000 } = {}) {
    productInteger(limit, 1, 10_000);
    productInteger(retentionDays, 1, 3650);
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    await migrateNotifications(this.database);
    const result = await this.database.query(`WITH doomed AS (
      SELECT id FROM evimed_inbox.notifications
      WHERE read_at < $1::timestamptz AND (notice_type='notify' OR resolved_at IS NOT NULL)
      ORDER BY read_at LIMIT $2 FOR UPDATE SKIP LOCKED
    ) DELETE FROM evimed_inbox.notifications n USING doomed WHERE n.id=doomed.id`, [cutoff, limit]);
    return Number(result.rowCount ?? 0);
  }

  async get(userId, id, client = this.database) {
    await migrateNotifications(this.database);
    const result = await client.query("SELECT * FROM evimed_inbox.notifications WHERE user_id=$1 AND id=$2", [productId(userId, "user"), productId(id)]);
    if (result.rowCount !== 1) throw new HttpError(404, "notification_not_found", "Inbox item not found.");
    return record(result.rows[0]);
  }

  async markRead(userId, id, expectedRevision) {
    return this.#update(userId, id, expectedRevision, `read_at=coalesce(read_at,clock_timestamp())`);
  }

  async resolve(userId, id, { actionId, expectedRevision }) {
    const item = await this.get(userId, id);
    const action = productId(actionId, "action");
    if (!item.actions.some((candidate) => candidate.id === action)) throw new HttpError(400, "notification_action_invalid", "Inbox action is unavailable.");
    // An action the IM module put on its own notice (「解除绑定」) is carried
    // out before the item resolves, so a failure leaves it open to try again;
    // an item already resolved, or read at another revision, is not acted on.
    if (this.channels?.onAction && !item.resolvedAt && item.revision === expectedRevision) {
      await this.channels.onAction(item, action);
    }
    return this.#update(userId, id, expectedRevision,
      `read_at=coalesce(read_at,clock_timestamp()),resolved_at=clock_timestamp(),resolution=jsonb_build_object('actionId',$4::text,'source','user')`, action, true);
  }

  async #update(userId, id, expectedRevision, assignment, extra = null, requireUnresolved = false) {
    productInteger(expectedRevision, 1, 2_147_483_646);
    await migrateNotifications(this.database);
    const parameters = [productId(userId, "user"), productId(id), expectedRevision];
    if (extra != null) parameters.push(extra);
    const result = await this.database.query(`UPDATE evimed_inbox.notifications SET ${assignment},revision=revision+1,updated_at=clock_timestamp()
      WHERE user_id=$1 AND id=$2 AND revision=$3 ${requireUnresolved ? "AND resolved_at IS NULL" : ""} RETURNING *`, parameters);
    if (result.rowCount) return record(result.rows[0]);
    const exists = await this.database.query("SELECT 1 FROM evimed_inbox.notifications WHERE user_id=$1 AND id=$2", [userId, id]);
    if (!exists.rowCount) throw new HttpError(404, "notification_not_found", "Inbox item not found.");
    if (requireUnresolved) {
      const terminal = await this.database.query("SELECT resolved_at FROM evimed_inbox.notifications WHERE user_id=$1 AND id=$2", [userId, id]);
      if (terminal.rows[0]?.resolved_at) throw new HttpError(409, "notification_already_resolved", "Inbox item is already resolved.");
    }
    throw new HttpError(409, "notification_revision_conflict", "Inbox item changed; reload before saving.");
  }

  async applyDueDefaults(now = new Date(), limit = 100) {
    productInteger(limit, 1, 500);
    const at = timestamp(now, "default time");
    await migrateNotifications(this.database);
    const result = await this.database.query(`WITH due AS (
      SELECT id FROM evimed_inbox.notifications WHERE resolved_at IS NULL AND default_action IS NOT NULL AND due_at <= $1
      ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT $2
    ) UPDATE evimed_inbox.notifications n SET read_at=coalesce(n.read_at,$1),resolved_at=$1,
      resolution=jsonb_build_object('actionId',n.default_action,'source','default'),revision=n.revision+1,updated_at=$1
      FROM due WHERE n.id=due.id RETURNING n.*`, [at, limit]);
    return result.rows.map(record);
  }

  async preferences(userId) {
    await migrateNotifications(this.database);
    const result = await this.database.query(`INSERT INTO evimed_inbox.preferences(user_id) VALUES($1)
      ON CONFLICT(user_id) DO UPDATE SET user_id=excluded.user_id
      RETURNING *`, [productId(userId, "user")]);
    return this.#preferences(result.rows[0]);
  }

  async updatePreferences(userId, input, expectedRevision) {
    productInteger(expectedRevision, 1, 2_147_483_646);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "channels,digestTime,quietHours,switches") {
      throw new HttpError(400, "notification_preferences_invalid", "Invalid inbox preferences.");
    }
    if (!input.quietHours || Object.keys(input.quietHours).sort().join(",") !== "end,start") throw new HttpError(400, "notification_preferences_invalid", "Invalid quiet hours.");
    // `frontier` (the 「前沿动态」 daily, 2026-09-22) may be absent: a page
    // written before it existed sends the three it knows, and the stored
    // `frontier` stays as it was rather than being refused or reset.
    const switchKeys = input.switches && typeof input.switches === "object" && !Array.isArray(input.switches) ? Object.keys(input.switches).sort().join(",") : "";
    if (!NOTIFICATION_SWITCH_KEY_SETS.includes(switchKeys)
      || Object.values(input.switches).some((value) => typeof value !== "boolean")) throw new HttpError(400, "notification_preferences_invalid", "Invalid switches.");
    // In-app plus any enabled registered channel (plan §3.6). Without the IM
    // module there is no registry, and the one list that validates is the one
    // that always did.
    const channels = this.channels?.registry
      ? this.channels.registry.preferenceChannels(input.channels)
      : Array.isArray(input.channels) && input.channels.length === 1 && input.channels[0] === "in-app" ? ["in-app"] : null;
    if (!channels) throw new HttpError(400, "notification_preferences_invalid", "This deployment supports in-app delivery only.");
    await migrateNotifications(this.database);
    const result = await this.database.query(`UPDATE evimed_inbox.preferences SET quiet_start=$3,quiet_end=$4,digest_time=$5,
      switches=CASE WHEN $6::jsonb ? 'frontier' THEN $6::jsonb
        ELSE $6::jsonb || jsonb_build_object('frontier', coalesce((switches->>'frontier')::boolean, true)) END,
      channels=$7::jsonb,revision=revision+1,updated_at=clock_timestamp()
      WHERE user_id=$1 AND revision=$2 RETURNING *`, [productId(userId, "user"), expectedRevision,
      validTime(input.quietHours.start, "quiet start"), validTime(input.quietHours.end, "quiet end"),
      validTime(input.digestTime, "digest time"), JSON.stringify(input.switches), JSON.stringify(channels)]);
    if (!result.rowCount) throw new HttpError(409, "notification_revision_conflict", "Inbox preferences changed; reload before saving.");
    return this.#preferences(result.rows[0]);
  }

  /**
   * Add or remove one push channel from an account's preferences without a
   * round trip through the page: binding a bot is the researcher saying they
   * want to hear from it, and unbinding it is saying they do not (the owner's
   * rule — no confirmation step the system could decide for them). The inbox
   * stays first; an unknown channel is refused by the registry's own rule.
   * @param {string} userId @param {string} channel @param {boolean} enabled
   */
  async setPreferenceChannel(userId, channel, enabled) {
    const current = await this.preferences(userId);
    const without = (Array.isArray(current.channels) ? current.channels : ["in-app"]).filter((id) => id !== channel);
    const next = enabled ? [...without, channel] : without;
    if (!next.includes("in-app")) next.unshift("in-app");
    if (enabled && this.channels?.registry) this.channels.registry.preferenceChannels(next);
    const result = await this.database.query(`UPDATE evimed_inbox.preferences SET channels=$2::jsonb,
      revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 RETURNING *`,
    [productId(userId, "user"), JSON.stringify(next)]);
    return this.#preferences(result.rows[0]);
  }

  /**
   * Record that a channel carried an item. Bookkeeping, not an edit: the
   * revision a reader's next action is checked against does not move, so a
   * push landing while the page is open never turns their "mark read" into
   * a conflict.
   * @param {string} userId @param {string} id @param {string} channel @param {Date} [at]
   */
  async recordChannelSent(userId, id, channel, at = new Date()) {
    await migrateNotifications(this.database);
    await this.database.query(`UPDATE evimed_inbox.notifications
      SET channels_sent=channels_sent || jsonb_build_object($3::text, $4::text) WHERE user_id=$1 AND id=$2`,
    [productId(userId, "user"), productId(id), channel, at.toISOString()]);
  }

  #preferences(row) {
    return { quietHours: { start: row.quiet_start, end: row.quiet_end }, digestTime: row.digest_time,
      switches: notificationSwitches(row.switches), channels: row.channels, revision: Number(row.revision), updatedAt: new Date(row.updated_at).toISOString() };
  }
}
