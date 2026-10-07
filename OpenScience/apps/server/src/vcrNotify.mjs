/**
 * 「虚拟临研」's notices (build plan 2026-09-28 §10.4). Exactly six kinds
 * reach a person; every other thing a study does is only shown on its page.
 *
 *   1. 研究包完成            info       — a study package finished
 *   2. 不可估计 / 假设冲突    attention  — the method's own diagnosis, or two assumptions that cannot both hold
 *   3. 计算预算需要确认       attention  — the second of the three human stops (§10.1)
 *   4. 有新的匹配候选         info       — pushed to the coordinators, not to everyone
 *   5. 实际入组偏离预测       attention  — the registered forecast and the actual have parted
 *   6. 假设卡有了新证据       info       — the frontier feed or a source-change record bears on a card (flywheel F24, 2026-10-06)
 *
 * Hidden knowledge:
 *
 * - **The title states the fact, in the study's own words** (the GEO rule):
 *   「方案 B 成功把握 71%，高于方案 A」, not 「一个作业完成了」. Never a code, an
 *   id, or a count of internal things.
 * - **Every notice is idempotent** by a key naming its event (the export, the
 *   result, the job, the assessment batch, the forecast comparison), through
 *   the inbox's own idempotency. A key the inbox finds holding different
 *   content is taken as already sent, never as a failure that would stop a
 *   tick.
 * - **Role-scoped delivery is the point of notice 4** (§10.4: 按角色推送给协调员).
 *   New candidates go to the study's recruiters and its lead — a statistician
 *   on the same study does not want a message every time a patient matches.
 *   With no recruiter named, the owner hears it, because a notice nobody gets
 *   is a notice that did not happen.
 * - **「不可估计」 is a finished result, not an error** (plan §3.6). Its notice
 *   says what is missing and what the study can still answer; its severity is
 *   `attention` because a person has to decide, not `safety`, because nothing
 *   is wrong.
 * - A notice opens the page it is about: its source is `{type:'vcr',
 *   id:'<studyId>/<tab>'}`, which the web inbox and the IM link builder turn
 *   into `/app/virtual-research/…` (`vcrNoticeHref`).
 *
 * @module vcrNotify
 */

import {
  VCR_NOTIFICATION_KINDS, VCR_NOT_ESTIMABLE_RULE_LABELS_ZH, VCR_TAB_LABELS_ZH,
} from "@evimed/domain";

/** The five kinds, by the key each notice is counted under. */
export const VCR_NOTICE_KINDS = VCR_NOTIFICATION_KINDS;

const SOURCE_PATH = /^[A-Za-z0-9_-]{1,80}(?:\/[A-Za-z0-9_-]{1,80})?$/;

/**
 * Where a 「虚拟临研」 notice opens, as an app path, or null for a source id
 * this module does not write.
 * @param {unknown} sourceId
 */
export function vcrNoticeHref(sourceId) {
  const id = String(sourceId ?? "");
  return SOURCE_PATH.test(id) ? `/app/virtual-research/${id}` : null;
}

/** @param {unknown} value @param {number} max */
function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;
}

/** What a study is called in a notice. @param {any} study */
export function vcrStudyName(study) {
  return clip(study?.name || study?.question || "虚拟临研研究", 30);
}

/** The inbox refuses a replay whose content moved; that event was sent. @param {unknown} error */
const alreadySent = (error) => /** @type {any} */ (error)?.code === "notification_idempotency_conflict";

/** A tab label as a reader reads it. @param {string} tab */
const tabLabel = (tab) => /** @type {Record<string, string>} */ (VCR_TAB_LABELS_ZH)[tab] ?? tab;

/**
 * @param {{ notifications: { create: (userId: string, input: Record<string, any>) => Promise<any> } | null,
 *   store: { members?: (studyId: string) => Promise<Array<{ userId: string, role: string }>> },
 *   config?: Record<string, any>, now?: () => Date,
 *   audit?: (event: string, status: string, details: Record<string, any>) => Promise<unknown> | unknown }} dependencies
 */
export function createVcrNotifier({ notifications, store, config = {}, now = () => new Date(), audit = () => {} }) {
  if (!store) throw new TypeError("The VCR notifier needs the VCR store.");
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries([...VCR_NOTICE_KINDS, "skipped", "failed"].map((kind) => [kind, 0]));

  /** @param {any} study @param {string} kind @param {Record<string, any>} input @param {readonly string[]} [recipients] */
  async function send(study, kind, input, recipients) {
    if (!notifications) { counts.skipped += 1; return null; }
    const targets = [...new Set([...(recipients ?? [String(study.userId)])].map(String).filter(Boolean))];
    if (!targets.length) { counts.skipped += 1; return null; }
    /** @type {any} */
    let first = null;
    for (const target of targets) {
      try {
        const item = await notifications.create(target, {
          noticeType: "notify",
          actions: [{ id: "open", label: "打开", style: "primary" }],
          projectId: study.projectId,
          ...input,
          // One event, many readers: the key carries the reader so the inbox's
          // idempotency does not fold a coordinator's copy into the lead's.
          idempotencyKey: `${input.idempotencyKey}:${target}`,
        });
        counts[kind] = (counts[kind] ?? 0) + 1;
        first = first ?? item;
      } catch (error) {
        if (alreadySent(error)) { first = first ?? true; continue; }
        counts.failed += 1;
        await audit("vcr.notice", "failed", {
          userId: target, projectId: study.projectId, detail: kind,
          code: typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "notification_unavailable",
        });
      }
    }
    return first;
  }

  /** @param {string} studyId @param {string} tab @param {string} [item] */
  const source = (studyId, tab, item) => ({ type: "vcr", id: item ? `${studyId}/${tab}/${item}` : `${studyId}/${tab}` });

  /** Who hears about a new candidate: the coordinators and the lead (§10.4). @param {any} study */
  async function recruiters(study) {
    const members = (await store.members?.(String(study.id))) ?? [];
    const named = members.filter((member) => ["recruiter", "site", "lead"].includes(String(member.role))).map((member) => String(member.userId));
    return named.length ? named : [String(study.userId)];
  }

  const notifier = {
    counts,

    /**
     * 1. 研究包完成. The headline is the study's own finding, handed in by the
     * orchestrator from what the package actually says.
     * @param {any} study @param {{ exportId: string, kind?: string, headline?: string | null, gaps?: number }} facts
     */
    packageReady(study, { exportId, kind = "study_package", headline = null, gaps = 0 }) {
      const missing = gaps > 0 ? `；还有 ${gaps} 项缺口写在缺口清单里` : "";
      return send(study, "package_ready", {
        title: `${vcrStudyName(study)}：研究包完成`,
        body: `${headline ? `${clip(headline, 120)}${missing}。` : `${tabLabel("overview")}页可以下载研究包${missing}。`}`,
        severity: "info", source: source(String(study.id), "overview"),
        idempotencyKey: `vcr:${study.id}:package:${kind}:${exportId}`,
      });
    },

    /**
     * 2. 「不可估计」 or two assumptions that cannot both hold. A finished
     * result, said plainly, with what it would take to change it.
     * @param {any} study @param {{ resultId: string, rule?: string | null, what?: string, gaps?: readonly string[] }} facts
     */
    notEstimable(study, { resultId, rule = null, what = "对照分析", gaps = [] }) {
      const reason = rule ? /** @type {Record<string, string>} */ (VCR_NOT_ESTIMABLE_RULE_LABELS_ZH)[rule] ?? rule : null;
      const list = gaps.length ? `缺：${gaps.slice(0, 3).map((gap) => clip(gap, 20)).join("、")}。` : "";
      return send(study, "not_estimable", {
        title: `${vcrStudyName(study)}：${what}判定为不可估计`,
        body: `${reason ? `${clip(reason, 90)}。` : ""}${list}结果和缺口清单都在研究页上，其余步骤照常。`,
        severity: "attention", source: source(String(study.id), "comparator"),
        idempotencyKey: `vcr:${study.id}:not-estimable:${resultId}`,
      });
    },

    /**
     * 3. 计算预算需要确认 — the second human stop. It says what is waiting and
     * what it would cost, because that is the decision being asked for.
     * @param {any} study @param {{ id: string, kind?: string, cpuSecondsLimit?: number | null }} job
     */
    budgetConfirm(study, job) {
      const minutes = Math.max(1, Math.round(Number(job?.cpuSecondsLimit ?? 0) / 60));
      return send(study, "budget_confirm", {
        title: `${vcrStudyName(study)}：计算预算需要确认`,
        body: `还有一项计算排在预算之外（约 ${minutes} 分钟机时）。在研究页确认一次，后面的计算就继续；不确认不影响已经算完的结果。`,
        severity: "attention", source: source(String(study.id), "overview"),
        idempotencyKey: `vcr:${study.id}:budget:${job?.id ?? "unknown"}`,
      });
    },

    /**
     * 4. 有新的匹配候选 — to the coordinators, not to everyone.
     * @param {any} study @param {{ batchKey: string, candidates: number, needsEvidence?: number }} facts
     */
    async newCandidates(study, { batchKey, candidates, needsEvidence = 0 }) {
      const pending = needsEvidence > 0 ? `，其中 ${needsEvidence} 人还缺证据` : "";
      return send(study, "new_candidates", {
        title: `${vcrStudyName(study)}：有 ${candidates} 位新的匹配候选${pending}`,
        body: "逐人看过之后再决定是否联系；联系之前需要协调员逐人确认。",
        severity: "info", source: source(String(study.id), "matching"),
        idempotencyKey: `vcr:${study.id}:candidates:${batchKey}`,
      }, await recruiters(study));
    },

    /**
     * 5. 实际入组偏离预测 — the registered forecast and the actual have parted
     * by more than the study set.
     * @param {any} study @param {{ forecastId: string, predicted: number, actual: number, byMonth?: string | null }} facts
     */
    accrualOffForecast(study, { forecastId, predicted, actual, byMonth = null }) {
      const when = byMonth ? `到 ${clip(byMonth, 20)}` : "到目前";
      return send(study, "accrual_off_forecast", {
        title: `${vcrStudyName(study)}：实际入组偏离预测`,
        body: `${when}预测 ${Math.round(predicted)} 例，实际 ${Math.round(actual)} 例。入组模型会用实际数据重新校准，预测与实际对照在试验页上。`,
        severity: "attention", source: source(String(study.id), "trial"),
        idempotencyKey: `vcr:${study.id}:accrual:${forecastId}`,
      });
    },

    /**
     * 6. 假设卡有了新证据 — a new results item of the frontier feed names a work a card stands on, or one of its sources was
     * retracted, corrected or replaced. To the study's lead: whether a new version follows is told in the sentence, from what
     * the study allows, never promised.
     * @param {any} study @param {{ batchKey: string, cards: readonly string[], afterFreeze?: boolean, refreshing?: boolean }} facts
     */
    newEvidence(study, { batchKey, cards, afterFreeze = false, refreshing = false }) {
      const named = cards.slice(0, 3).map((card) => clip(card, 20)).join("、");
      const tail = afterFreeze ? "分析计划已经冻结：新版本会放在冻结的版本旁边，计划本身不动。"
        : refreshing ? "AI 会读入新证据并生成新版本；旧版本保留。" : "旧版本保留；定义与证据页上能看到是哪些新证据。";
      return send(study, "new_evidence", {
        title: `${vcrStudyName(study)}：${named}有了新证据`,
        body: tail, severity: "info", source: source(String(study.id), "data"),
        idempotencyKey: `vcr:${study.id}:new-evidence:${batchKey}`,
      });
    },

    /** What readiness shows about the notifier. */
    status() {
      return { wired: Boolean(notifications), counts: { ...counts }, kinds: [...VCR_NOTICE_KINDS] };
    },
  };
  // `config` and `now` are part of the shape every notifier of this platform
  // takes; this one needs neither yet, and taking them keeps the composition
  // in `server.mjs` identical to GEO's and the frontier's.
  void config;
  void now;
  return notifier;
}
