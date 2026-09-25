import { GEO_ENGINE_LABELS_ZH, GEO_URGENT_SEVERITIES } from "@evimed/domain";

/**
 * 「循证 GEO」's notices (build spec 2026-09-25 §5; plan §5.7): exactly five
 * kinds reach a person, and everything else a project does is only shown on
 * its page.
 *
 *   1. 诊断完成            info     — the baseline (or a single step's round) is measured
 *   2. 三档目标出来了       info     — the strategy run wrote its three tiers
 *   3. 首批稿件可发布       info     — the first article passed the gate with no open safety finding
 *   4. 第一次被 AI 引用     info     — an engine cited one of the project's published articles for the first time
 *   5. 讲错我方 / 安全问题  safety   — an engine said something wrong about our product, an article is
 *                                     held by a clinical-safety finding, or an outlet changed a published text
 *
 * Hidden knowledge:
 *
 * - **The title states the fact** (plan §5.7): 「DeepSeek 把玛仕度肽说成每天注射一次」,
 *   composed from the error row the measurement wrote — the engine's name,
 *   then the wrong statement as the judge recorded it. Never a code, an id or
 *   a count of internal things.
 * - **Every notice is idempotent** by a key naming its event (the round, the
 *   targets version, the error, the article), through the inbox's own
 *   idempotency: a tick that sends the same event again reads back the item it
 *   already made. A key the inbox finds holding different content (a replay
 *   after an edit to a sentence here) is taken as already sent, never as a
 *   failure that would stop the tick.
 * - **Many small errors are one line a day.** A severity S3/S4 error stands
 *   alone and at once; lower severities of one project and one day fold into
 *   one item whose title is the most severe of them (the inbox's `groupKey`).
 *   A baseline finding twenty errors is one line, not twenty.
 * - **Operators hear about money and machinery, users never do** (plan §3.8:
 *   「余额、对账、熔断只发管理员」). `alertOperator` writes to every operator
 *   account's inbox with severity `attention`, keyed by the event's own key;
 *   with no operator configured it only audits.
 * - A notice opens the GEO page it is about: its source is `{type:'geo',
 *   id:'<geoId>/<tab>'}` (or `<geoId>/answers/<snapshotId>`), which the web
 *   inbox and the IM link builder turn into `/app/geo/…` (`geoNoticeHref`).
 *
 * @module geoNotify
 */

/** The five user-facing kinds, by the key each notice is counted under. */
export const GEO_NOTICE_KINDS = Object.freeze(["diagnosis_done", "targets_ready", "first_publishable", "first_cited", "wrong_or_safety"]);

const SOURCE_PATH = /^[A-Za-z0-9_-]{1,80}(?:\/[A-Za-z0-9_-]{1,80}){0,2}$/;

/**
 * Where a GEO notice opens, as an app path, or null for a source id that is
 * not one this module writes.
 * @param {unknown} sourceId
 */
export function geoNoticeHref(sourceId) {
  const id = String(sourceId ?? "");
  return SOURCE_PATH.test(id) ? `/app/geo/${id}` : null;
}

/** @param {string} engine */
export const geoEngineLabel = (engine) => /** @type {Record<string, string>} */ (GEO_ENGINE_LABELS_ZH)[engine] ?? engine;

/** An engine's name followed by a space when it ends in a Latin letter (「DeepSeek 把…」, 「豆包把…」). @param {string} engine */
const spacedEngine = (engine) => {
  const label = geoEngineLabel(engine);
  return /[A-Za-z0-9]$/.test(label) ? `${label} ` : label;
};

/** @param {unknown} value @param {number} max */
function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;
}

/** What a project is called in a notice: its brand, else its generic name. @param {any} project */
export function geoProductName(project) {
  const product = project?.product && typeof project.product === "object" ? project.product : {};
  return clip(product.brandName || product.genericName || "循证 GEO 项目", 30);
}

/**
 * The title of a 讲错我方 notice: the fact, in the engine's name.
 * 「DeepSeek 把玛仕度肽说成每天注射一次」 when the statement is phrased as the
 * judge phrases a misstatement (「把…说成…」) or begins with the product's
 * name; otherwise 「豆包讲错玛仕度肽：…」.
 * @param {any} project @param {{ engine?: string | null, statement?: string | null }} error
 */
export function wrongOursTitle(project, error) {
  const engine = geoEngineLabel(String(error.engine ?? ""));
  const statement = clip(error.statement, 90).replace(/[。．.!！]+$/, "");
  const gap = /[A-Za-z0-9]$/.test(engine) ? " " : "";
  if (!statement) return `${engine}${gap}讲错了${geoProductName(project)}`;
  if (statement.startsWith("把")) return `${engine}${gap}${statement}`;
  const product = project?.product && typeof project.product === "object" ? project.product : {};
  for (const name of [product.brandName, product.genericName, ...(Array.isArray(product.aliases) ? product.aliases : [])]) {
    const word = typeof name === "string" ? name.trim() : "";
    if (word && statement.startsWith(word) && statement.length > word.length) {
      const rest = statement.slice(word.length).replace(/^[是为：:，,\s]+/, "");
      if (rest) return `${engine}${gap}把${word}说成${rest}`;
    }
  }
  return `${engine}${gap}讲错${geoProductName(project)}：${statement}`;
}

/** The inbox refuses a replay whose content moved; that event was sent. @param {unknown} error */
const alreadySent = (error) => /** @type {any} */ (error)?.code === "notification_idempotency_conflict";

/** @param {Date} date @param {string} timeZone */
function dayIn(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

const OPERATOR_TITLES = Object.freeze({
  order_unknown: "投放：一笔订单发送结果不明，需要人工核对",
  reconciliation_mismatch: "投放：对账不平，新订单已暂停",
  orders_missing_at_vendor: "投放：有订单在媒介平台查不到",
  topup_requested: "投放：媒介平台余额偏低，请充值",
  refund_not_in_balance: "投放：退款没有到账",
  refund_overdue: "投放：退款超时未到",
  price_above_reserve: "投放：订单结算价高于预留，未自动付款",
  order_unpublished: "投放：订单超时未发布",
  published_off_domain: "投放：发布链接不在媒体自己的域名上",
  market_unauthorized: "投放：媒介平台拒绝了接口密钥",
  diagnosis_empty: "测量：一轮诊断没有测到任何有效回答",
  metrics_missing: "测量：一轮测量结束已过半小时，指标还没有算出来",
  geo_probe_suspect: "测量：出现可疑回答（登录页或空白页）",
  geo_probe_engine_paused: "测量：一家 AI 引擎暂停探测",
  geo_probe_host_down: "测量：探测机连不上",
  geo_probe_busy: "测量：探测机持续繁忙，开始消耗重试次数",
  geo_probe_misconfigured: "测量：探测通道配置有误",
  geo_probe_unconfigured: "测量：探测通道没有配置，测量在排队",
});

/**
 * @param {{ notifications: { create: (userId: string, input: Record<string, any>) => Promise<any> } | null,
 *   store: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> },
 *   config?: Record<string, any>, now?: () => Date,
 *   audit?: (event: string, status: string, details: Record<string, any>) => Promise<unknown> | unknown }} dependencies
 */
export function createGeoNotifier({ notifications, store, config = {}, now = () => new Date(), audit = () => {} }) {
  if (!store) throw new TypeError("The GEO notifier needs the GEO store.");
  const timeZone = String(config.geoTimeZone || "Asia/Shanghai");
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries([...GEO_NOTICE_KINDS, "operator", "skipped", "failed"].map((kind) => [kind, 0]));

  /** @param {any} project @param {string} kind @param {Record<string, any>} input */
  async function send(project, kind, input) {
    if (!notifications) { counts.skipped += 1; return null; }
    try {
      const item = await notifications.create(String(project.userId), {
        noticeType: "notify",
        actions: [{ id: "open", label: "打开", style: "primary" }],
        projectId: project.projectId,
        ...input,
      });
      counts[kind] = (counts[kind] ?? 0) + 1;
      return item;
    } catch (error) {
      if (alreadySent(error)) return true;
      counts.failed += 1;
      await audit("geo.notice", "failed", { userId: project.userId, projectId: project.projectId,
        code: typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "notification_unavailable", detail: kind });
      return null;
    }
  }

  /** @param {string} geoId @param {string} tab @param {string} [item] */
  const source = (geoId, tab, item) => ({ type: "geo", id: item ? `${geoId}/${tab}/${item}` : `${geoId}/${tab}` });

  const notifier = {
    counts,

    /** 1. 诊断完成. @param {any} project @param {{ roundId: string, engines: number, answers: number, wrongOurs: number }} facts */
    diagnosisDone(project, { roundId, engines, answers, wrongOurs }) {
      const wrong = wrongOurs > 0 ? `，发现 ${wrongOurs} 处讲错我方` : "";
      return send(project, "diagnosis_done", {
        title: `${geoProductName(project)}：诊断完成`,
        body: `${engines} 家 AI 引擎、${answers} 次回答已经测完${wrong}。`,
        severity: "info", source: source(project.id, "diagnosis"), idempotencyKey: `geo:${project.id}:diagnosis:${roundId}`,
      });
    },

    /**
     * 1'. The diagnosis measured nothing — said plainly instead of 「诊断完成」,
     * with what the user can do once operators have looked.
     * @param {any} project @param {{ roundId: string }} facts
     */
    diagnosisEmpty(project, { roundId }) {
      return send(project, "diagnosis_done", {
        title: `${geoProductName(project)}：诊断没有测到回答`,
        body: "这一轮没有从任何 AI 引擎拿到有效回答，已通知管理员检查探测通道。处理好后，在诊断页点「让 AI 做」重新测。",
        severity: "attention", source: source(project.id, "diagnosis"), idempotencyKey: `geo:${project.id}:diagnosis-empty:${roundId}`,
      });
    },

    /** 2. 三档目标出来了. @param {any} project @param {{ version: number, suggestedBudgetCny: number | null }} facts */
    targetsReady(project, { version, suggestedBudgetCny }) {
      const budget = suggestedBudgetCny ? `，档${project.tier}建议投放预算 ¥${Math.round(suggestedBudgetCny).toLocaleString("zh-CN")}` : "";
      return send(project, "targets_ready", {
        title: `${geoProductName(project)}：三档目标出来了`,
        body: `信源分析、每个引擎的预期和三档目标已经写好${budget}。`,
        severity: "info", source: source(project.id, "sources"), idempotencyKey: `geo:${project.id}:targets:${version}`,
      });
    },

    /** 3. 首批稿件可发布. @param {any} project @param {{ count: number, budgetSet: boolean }} facts */
    firstPublishable(project, { count, budgetSet }) {
      return send(project, "first_publishable", {
        title: `${geoProductName(project)}：首批稿件可发布`,
        body: `${count} 篇稿件过了交付闸门，${budgetSet ? "会在预算内自动投放。" : "设置投放预算后自动投放。"}`,
        severity: "info", source: source(project.id, budgetSet ? "content" : "distribution"), idempotencyKey: `geo:${project.id}:first-publishable`,
      });
    },

    /** 4. 第一次被 AI 引用. @param {any} project @param {{ engine: string, title: string | null }} facts */
    firstCited(project, { engine, title }) {
      return send(project, "first_cited", {
        title: `${spacedEngine(engine)}第一次引用了${title ? `《${clip(title, 40)}》` : "投放的稿件"}`,
        body: `${geoProductName(project)}：投放的稿件出现在 AI 回答的引用里。`,
        severity: "info", source: source(project.id, "monitoring"), idempotencyKey: `geo:${project.id}:first-cited`,
      });
    },

    /**
     * 5a. 讲错我方, from the error row. S3/S4 alone; lower severities of one
     * project and day fold into one item led by the most severe.
     * @param {any} project @param {any} error a row of `evimed_geo.errors` (snake or camel case)
     * @param {{ key?: string | null }} [options] the event's own key (the measurement's
     *   `geo:wrong_ours:<id>:first`, or `…:seen:<snapshot>` for an error back after it closed)
     */
    async wrongOurs(project, error, { key = null } = {}) {
      const row = normalizedError(error);
      const idempotencyKey = key || `geo:wrong_ours:${row.id}:first`;
      const target = row.snapshotId ? source(project.id, "answers", row.snapshotId) : source(project.id, "diagnosis");
      const body = row.evidenceQuote ? `依据：「${clip(row.evidenceQuote, 200)}」` : "点开看这条回答和依据。";
      if (GEO_URGENT_SEVERITIES.includes(String(row.severity))) {
        return send(project, "wrong_or_safety", {
          title: wrongOursTitle(project, row), body, severity: "safety", source: target, idempotencyKey,
        });
      }
      const day = dayIn(row.createdAt ? new Date(row.createdAt) : now(), timeZone);
      const same = await store.query(`SELECT id, engine, statement, severity FROM evimed_geo.errors
        WHERE geo_project_id = $1 AND status <> 'closed' AND (severity IS NULL OR severity <> ALL($2::text[]))
          AND created_at >= $3::timestamptz AND created_at < $3::timestamptz + interval '1 day'
        ORDER BY severity DESC NULLS LAST, created_at, id LIMIT 50`, [project.id, [...GEO_URGENT_SEVERITIES], zonedMidnight(day, timeZone)])
        .then((result) => result.rows).catch(() => []);
      const lead = same[0] ?? row;
      const others = Math.max(0, same.length - 1);
      return send(project, "wrong_or_safety", {
        title: `${wrongOursTitle(project, normalizedError(lead))}${others ? `（另有 ${others} 处）` : ""}`,
        body, severity: "safety", source: others ? source(project.id, "diagnosis") : target,
        groupKey: `geo-wrong:${project.id}:${day}`, idempotencyKey,
      });
    },

    /** 5b. An article held by a clinical-safety finding (the second human stop). @param {any} project @param {{ id: string, title?: string | null }} article */
    articleSafety(project, article) {
      return send(project, "wrong_or_safety", {
        title: `${article.title ? `《${clip(article.title, 40)}》` : "一篇稿件"}有临床安全问题，暂不投放`,
        body: "看过之后，改稿或在内容页放行。",
        severity: "safety", source: source(project.id, "content"), idempotencyKey: `geo:article-safety:${article.id}`,
      });
    },

    /**
     * 5c. An outlet changed a published text (the market's `notify`,
     * `published_text_changed`). The project is read by its id.
     * @param {{ userId?: string, geoProjectId?: string, orderId?: string, articleId?: string, mediaName?: string, changed?: string[], idempotencyKey?: string }} event
     */
    async textChanged(event) {
      const project = await projectRow(store, event.geoProjectId, event.userId);
      if (!project) return null;
      const article = event.articleId
        ? (await store.query(`SELECT title FROM evimed_geo.articles WHERE geo_project_id = $1 AND id = $2`, [project.id, event.articleId])).rows[0] : null;
      const changed = (Array.isArray(event.changed) ? event.changed : []).map((text) => clip(text, 30)).filter(Boolean).slice(0, 5);
      return send(project, "wrong_or_safety", {
        title: `${clip(event.mediaName || "媒体", 20)}改动了已发布的${article?.title ? `《${clip(article.title, 40)}》` : "稿件"}`,
        body: changed.length ? `和交稿不一致：${changed.join("、")}。已要求媒体改回。` : "和交稿不一致，已要求媒体改回。",
        severity: "safety", source: source(project.id, "distribution"),
        idempotencyKey: String(event.idempotencyKey || `geo:order:${event.orderId}:text_changed`),
      });
    },

    /**
     * The measurement package's `notify` hook. An event naming an error is a
     * 讲错我方 notice read from the error row; the market's text change is
     * 5c; an event about the machinery (an engine paused, the probe host
     * down) goes to operators only.
     * @param {Record<string, any>} event
     */
    async measurement(event) {
      if (event?.type === "published_text_changed") return notifier.textChanged(event);
      const errorId = typeof event?.errorId === "string" ? event.errorId : null;
      if (errorId) {
        const row = (await store.query(`SELECT * FROM evimed_geo.errors WHERE id = $1`, [errorId])).rows[0];
        if (!row) return null;
        const project = await projectRow(store, row.geo_project_id, row.user_id);
        return project ? notifier.wrongOurs(project, row, { key: typeof event.idempotencyKey === "string" ? event.idempotencyKey : null }) : null;
      }
      return notifier.alertOperator(event ?? {});
    },

    /**
     * Money and machinery, for operators only (the market's and the
     * measurement's alerts).
     * @param {Record<string, any>} event
     */
    async alertOperator(event) {
      const type = String(event?.type ?? event?.kind ?? "");
      const title = /** @type {Record<string, string>} */ (OPERATOR_TITLES)[type] ?? "循证 GEO 后台需要人工处理";
      const key = String(event?.idempotencyKey || `geo-op:${type}:${dayIn(now(), timeZone)}`);
      const operators = (config.operatorUsers ?? []).map(String).filter(Boolean);
      await audit("geo.operator.alert", "reported", { code: type || "unknown", detail: key });
      if (!notifications || !operators.length) { counts.skipped += 1; return null; }
      for (const operatorId of operators) {
        try {
          await notifications.create(operatorId, {
            noticeType: "notify", title, body: operatorBody(event), severity: "attention",
            source: { type: "system", id: `geo-operator:${type || "alert"}` }, idempotencyKey: `geo-op:${key}`,
          });
          counts.operator += 1;
        } catch (error) {
          if (!alreadySent(error)) counts.failed += 1;
        }
      }
      return null;
    },
  };
  return notifier;
}

/** The midnight that begins a zoned day, as an ISO instant. @param {string} day YYYY-MM-DD @param {string} timeZone */
function zonedMidnight(day, timeZone) {
  const [year, month, date] = day.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, date);
  // The zone's offset at that moment, read back from the formatter.
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(utc)).map((part) => [part.type, part.value]));
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(utc - (shown - utc)).toISOString();
}

/** An error row, whichever case it came in. @param {any} row */
function normalizedError(row) {
  return {
    id: String(row?.id ?? ""),
    engine: row?.engine ?? null,
    statement: row?.statement ?? null,
    severity: row?.severity ?? null,
    evidenceQuote: row?.evidence_quote ?? row?.evidenceQuote ?? null,
    snapshotId: row?.last_snapshot_id ?? row?.lastSnapshotId ?? row?.snapshotId ?? row?.first_snapshot_id ?? null,
    createdAt: row?.created_at ?? row?.createdAt ?? null,
  };
}

/** @param {{ query: Function }} store @param {unknown} geoProjectId @param {unknown} [userId] */
async function projectRow(store, geoProjectId, userId) {
  if (typeof geoProjectId !== "string" || !geoProjectId) return null;
  const row = (await store.query(`SELECT id, user_id, project_id, product, tier FROM evimed_geo.projects WHERE id = $1 AND deleted_at IS NULL`,
    [geoProjectId])).rows[0];
  if (!row || (userId != null && String(row.user_id) !== String(userId))) return null;
  return { id: String(row.id), userId: String(row.user_id), projectId: String(row.project_id), product: row.product ?? {}, tier: String(row.tier) };
}

/** What an operator alert says beyond its title: the amounts and counts it carries, never a key. @param {Record<string, any>} event */
function operatorBody(event) {
  const parts = [];
  if (event.day) parts.push(`日期 ${event.day}`);
  if (Number.isFinite(Number(event.amountCny)) && event.amountCny != null) parts.push(`金额 ¥${Number(event.amountCny).toFixed(2)}`);
  if (Number.isFinite(Number(event.diff)) && event.diff != null) parts.push(`差额 ¥${Number(event.diff).toFixed(2)}`);
  if (Number.isFinite(Number(event.balance)) && event.balance != null) parts.push(`余额 ¥${Number(event.balance).toFixed(2)}`);
  if (Array.isArray(event.orderIds)) parts.push(`${event.orderIds.length} 笔订单`);
  if (event.engine) parts.push(`引擎 ${geoEngineLabel(String(event.engine))}`);
  return parts.length ? `${parts.join("，")}。在「循证 GEO」的投放账户里处理。` : "在「循证 GEO」的投放账户里处理。";
}
