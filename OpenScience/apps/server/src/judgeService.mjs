import { randomBytes } from "node:crypto";
import { recordJudgeDrift, judgeDriftSummary } from "./judgePersistence.mjs";
/** Shared Jev decisions; uncertainty always returns control to the caller. */
import { callJev, requestRefusalCode } from "./jevModel.mjs";
import {
  JUDGE_SITES,
  buildJudgeRequest,
  validateJudgeAnswer,
  decodeJudgeValue,
  judgePromptFingerprint,
} from "./judgeSites.mjs";

/** @param {string} site @param {any} input @param {any} answers @param {any} [options] */
export function decodeJudgeAnswers(
  site,
  input,
  answers,
  { threshold = JUDGE_SITES[site]?.threshold ?? 1, model = "jev-1.13.0" } = {},
) {
  const request = buildJudgeRequest(site, input),
    decisions = {};
  for (const [id, question] of Object.entries(request.questions)) {
    try {
      decisions[id] = validateJudgeAnswer(answers?.[id], question);
    } catch (error) {
      if (!["J1", "J8"].includes(site)) throw error;
      decisions[id] = {
        choice: site === "J1" ? "related" : "other",
        confidence: 0,
        probabilities: Object.fromEntries(
          Object.keys(question.criteria).map((key) => [key, 0]),
        ),
      };
    }
  }
  if (site === "J1" || site === "J8")
    for (const decision of Object.values(decisions))
      if (decision.confidence < threshold)
        decision.choice = site === "J1" ? "related" : "other";
  const confidence =
    site === "J9"
      ? Object.values(decisions).sort(
          (a, b) => b.probabilities.related - a.probabilities.related,
        )[0].confidence
      : ["J1", "J8"].includes(site)
        ? Math.max(...Object.values(decisions).map((value) => value.confidence))
        : Math.min(
            ...Object.values(decisions).map((value) => value.confidence),
          );
  const value = decodeJudgeValue(site, request.state, decisions);
  // A batch of independent items is sure item by item: the batch's confidence above stays the minimum
  // (it settles whole only when every item does), and what the sure items decided travels with an
  // escalated answer for a caller that can adopt part of a batch (J-5).
  const sure =
    site === "J5"
      ? request.state.items.map((_, i) =>
          ["medical", "news", "category", "roundup", "specialties"].every(
            (question) => decisions[`${question}${i}`].confidence >= threshold,
          ),
        )
      : null;
  const partial =
    sure && sure.some(Boolean) && !sure.every(Boolean)
      ? {
          items: value.items.filter((_, i) => sure[i]),
          unsettledIds: request.state.items
            .filter((_, i) => !sure[i])
            .map((item) => item.id),
        }
      : null;
  return {
    value,
    decisions,
    confidence,
    outcome: confidence >= threshold ? "settled" : "escalated",
    ...(partial ? { partial } : {}),
    ...(sure ? { itemsSettled: sure.filter(Boolean).length, itemsTotal: sure.length } : {}),
    promptFingerprint: judgePromptFingerprint(
      site,
      request.questions,
      threshold,
      model,
    ),
  };
}

/** @param {{config:any,usageLedger?:any,fetchImpl?:typeof fetch,callImpl?:any,database?:any,random?:()=>number,now?:()=>number,calibrationMode?:boolean}} deps */
export function createJudgeService({
  config,
  usageLedger = null,
  fetchImpl,
  callImpl = callJev,
  database = null,
  random = Math.random,
  now = Date.now,
  calibrationMode = false,
}) {
  const requests = new Map(),
    counters = new Map(),
    circuits = new Map(),
    // Why a decision fell back, by site and code: the outcome counter says that it did.
    reasons = new Map(),
    // Calibrated sites whose prompt no longer matches what was measured, since when.
    blocked = new Map(),
    pending = new Set(),
    controllers = new Set();
  let backgroundActive = 0,
    closed = false;
  const disabled = new Set(config.jevDisabledSites ?? []);
  const comparisons = new Map();
  const pruneComparisons = () => {
    for (const [receipt, row] of comparisons)
      if (row.expires <= now()) {
        comparisons.delete(receipt);
        count(row.site, "drift_expired");
      }
  };
  let comparisonCleanup;
  const scope = (context) =>
    canonical({
      userId: context.userId,
      projectId: context.projectId,
      runId: context.runId ?? null,
      taskId: context.taskId,
      module: context.module,
    });
  function mintEngineComparison(site, request, result, context) {
    if (
      !database ||
      !context.engineAuthenticated ||
      !["J8", "J9"].includes(site) ||
      random() >= 0.02
    )
      return;
    pruneComparisons();
    if (comparisons.size >= 256) {
      count(site, "drift_busy");
      return;
    }
    const receipt = randomBytes(24).toString("base64url");
    const ids = (
      site === "J8" ? request.state.criteria : request.state.candidates
    ).map((row) => row.id);
    const expected =
      site === "J8"
        ? result.value.items
            .filter((row) => row.decision === "pass" && row.confidence >= 0.9)
            .map((row) => row.id)
        : result.value.candidates
            .slice()
            .sort((a, b) => b.relevance - a.relevance)
            .filter((row) => row.relevance >= 0.9)
            .slice(0, 1)
            .map((row) => row.id);
    if (!expected.length) return;
    if(!comparisonCleanup){comparisonCleanup=setInterval(pruneComparisons,60000);comparisonCleanup.unref();}
    comparisons.set(receipt, {
      site,
      scope: scope(context),
      ids,
      expected,
      model: result.model,
      promptFingerprint: result.promptFingerprint,
      expires: now() + 1800000,
    });
    result.comparisonReceipt = receipt;
  }
  async function compareEngine(input, context) {
    if (closed)
      return { outcome: "fallback", code: "judge_disabled", value: null };
    const invalid = {
      outcome: "fallback",
      code: "judge_comparison_invalid",
      value: null,
    };
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some(
        (key) => !["receipt", "value", "failed"].includes(key),
      ) ||
      typeof input.receipt !== "string"
    )
      return invalid;
    const row = comparisons.get(input.receipt);
    if (!row || row.scope !== scope(context) || !context.engineAuthenticated)
      return invalid;
    comparisons.delete(input.receipt);
    if (row.expires <= now()) {
      count(row.site, "drift_expired");
      return invalid;
    }
    if (input.failed === true) {
      count(row.site, "drift_failed");
      return {
        outcome: "settled",
        code: "judge_comparison_failed",
        value: null,
      };
    }
    let agreement;
    if (row.site === "J8") {
      const items = input.value?.items;
      if (
        !input.value ||
        Object.keys(input.value).some((key) => key !== "items") ||
        !Array.isArray(items) ||
        items.length !== row.ids.length ||
        new Set(items.map((item) => item?.id)).size !== row.ids.length ||
        items.some(
          (item) =>
            !item ||
            Object.keys(item).some(
              (key) => !["id", "decision"].includes(key),
            ) ||
            !row.ids.includes(item.id) ||
            !["pass", "other"].includes(item.decision),
        )
      ) {
        count(row.site, "drift_failed");
        return invalid;
      }
      agreement = row.expected.every(
        (id) => items.find((item) => item.id === id).decision === "pass",
      );
    } else {
      const ids = input.value?.selectedIds;
      if (
        !Array.isArray(ids) ||
        ids.length > 50 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !row.ids.includes(id)) ||
        Object.keys(input.value).some((key) => key !== "selectedIds")
      ) {
        count(row.site, "drift_failed");
        return invalid;
      }
      agreement = row.expected[0] === ids[0];
    }
    try {
      await recordJudgeDrift(database, {
        site: row.site,
        model: row.model,
        promptFingerprint: row.promptFingerprint,
        agreement,
      });
      count(row.site, "drift_compared");
      return {
        outcome: "settled",
        code: "judge_comparison_recorded",
        value: null,
      };
    } catch {
      count(row.site, "drift_failed");
      return {
        outcome: "fallback",
        code: "judge_comparison_unavailable",
        value: null,
      };
    }
  }

  const count = (site, outcome, by = 1) => {
    const key = `${site}:${outcome}`;
    counters.set(key, (counters.get(key) ?? 0) + by);
  };
  const canonical = (value) =>
    JSON.stringify(value, (_, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    );
  const status = () => ({
    model: config.reviewJevModel ?? null,
    configured: Boolean(config.typesafeApiKey),
    // The master switch: false is every site standing down to its original path.
    enabled: config.jevEnabled !== false,
    sites: Object.fromEntries(
      Object.entries(JUDGE_SITES).map(([id, p]) => [
        id,
        {
          enabled:
            Boolean(config.typesafeApiKey) &&
            config.jevEnabled !== false &&
            (id === "reply-check"
              ? config.reviewJevEnabled === true
              : calibrationMode ||
                (config.jevSites?.[id]?.calibration === "calibrated" &&
                  typeof config.jevSites?.[id]?.promptFingerprint ===
                    "string")) &&
            !disabled.has(id),
          calibration: config.jevSites?.[id]?.calibration ?? p.calibration,
          calibrated:
            id === "reply-check" ||
            (config.jevSites?.[id]?.calibration === "calibrated" &&
              typeof config.jevSites?.[id]?.promptFingerprint === "string"),
          threshold: config.jevSites?.[id]?.threshold ?? p.threshold,
          ...(blocked.has(id)
            ? { blockedBy: "judge_calibration_mismatch", blockedSince: new Date(blocked.get(id)).toISOString() }
            : {}),
        },
      ]),
    ),
  });
  const metrics = () =>
    [...counters].map(([key, value]) => {
      const [site, outcome] = key.split(":");
      return { site, outcome, value };
    });
  /**
   * Work a caller chose not to send to `site`, by reason: a run outside the
   * site's scope, lines past a per-run bound. The caller owns the bound; this
   * only makes it visible, so a cap that binds shows as a count instead of as
   * judgements that quietly never happened.
   * @param {string} site @param {string} reason @param {number} [by]
   */
  const skipped = (site, reason, by = 1) => {
    if (Object.hasOwn(JUDGE_SITES, site) && /^[a-z_]{1,40}$/.test(reason) && Number.isSafeInteger(by) && by > 0)
      count(site, `skip_${reason}`, by);
  };
  const drift = async (site, result, context) => {
    const regex =
      ["J4", "J7"].includes(site) && context.regexBaseline !== undefined;
    if (
      !database ||
      (!regex &&
        (typeof context.baseline !== "function" ||
          !["J1", "J2", "J3", "J5", "J6", "J8", "J9"].includes(site) ||
          random() >= 0.02))
    )
      return;
    if (backgroundActive >= Number(config.jevBackgroundConcurrency ?? 4)) {
      count(site, "drift_busy");
      return;
    }
    backgroundActive++;
    let deadline, baselineWork;
    const controller = new AbortController();
    controllers.add(controller);
    try {
      baselineWork = Promise.resolve().then(async () =>
        regex
          ? {
              value:
                typeof context.regexBaseline === "function"
                  ? await context.regexBaseline()
                  : context.regexBaseline,
            }
          : context.baseline({ signal: controller.signal }),
      );
      pending.add(baselineWork);
      const completed = () => {
        pending.delete(baselineWork);
        controllers.delete(controller);
        backgroundActive--;
      };
      void baselineWork.then(completed, completed);
      const baseline = await Promise.race([
        baselineWork,
        new Promise((_, reject) => {
          deadline = setTimeout(() => {
            controller.abort();
            reject(new Error("judge_baseline_timeout"));
          }, 15000);
        }),
      ]);
      const agreement = canonical(result.value) === canonical(baseline?.value);
      await recordJudgeDrift(database, {
        site,
        model: result.model,
        promptFingerprint: result.promptFingerprint,
        agreement,
      });
      count(site, "drift_compared");
    } catch {
      count(site, "drift_failed");
    } finally {
      clearTimeout(deadline);
    }
  };
  /** @param {string} site @param {any} input @param {any} [context] */
  async function judge(site, input, context = {}) {
    const policy = Object.hasOwn(JUDGE_SITES, site) ? JUDGE_SITES[site] : null;
    const finish = (outcome, code, extra = {}) => {
      count(Object.hasOwn(JUDGE_SITES, site) ? site : "unknown", outcome);
      if (outcome === "fallback") {
        const key = `${Object.hasOwn(JUDGE_SITES, site) ? site : "unknown"}:${code}`;
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
      return {
        outcome,
        value: null,
        code,
        cost: 0,
        model: config.reviewJevModel ?? null,
        confidence: 0,
        calibration:
          config.jevSites?.[site]?.calibration ??
          policy?.calibration ??
          "uncalibrated",
        ...extra,
      };
    };
    if (!policy) return finish("fallback", "judge_unknown_site");
    // The master switch (config.jevEnabled, OPEN_SCIENCE_JEV_ENABLED) stands every site down, the reply check's too;
    // that site has its own narrower lever beside it, and no other site does.
    if (
      closed ||
      config.jevEnabled === false ||
      (site === "reply-check" && config.reviewJevEnabled !== true) ||
      disabled.has(site)
    )
      return finish("fallback", "judge_disabled");
    if (!config.typesafeApiKey) return finish("fallback", "judge_unconfigured");
    const circuit = circuits.get(site) ?? { failures: 0, until: 0 };
    if (circuit.until > now()) return finish("fallback", "judge_circuit_open");
    if (
      !policy.interactive &&
      backgroundActive >= Number(config.jevBackgroundConcurrency ?? 4)
    )
      return finish("fallback", "judge_background_busy");
    let request;
    try {
      request = buildJudgeRequest(site, input);
    } catch {
      return finish("fallback", "judge_invalid_input");
    }
    if (site !== "reply-check") {
      const strings = (value) =>
        typeof value === "string"
          ? [value]
          : value && typeof value === "object"
            ? Object.values(value).flatMap(strings)
            : [];
      const privateUrl = strings(request.state).some((value) =>
        [...value.matchAll(/https?:\/\/[^\s<>"']+/gi)].some((match) => {
          try {
            const url = new URL(match[0]);
            return (
              Boolean(url.username || url.password) ||
              /^\/internal(?:\/|$)/i.test(url.pathname) ||
              /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^198\.(?:18|19)\.|^(?:22[4-9]|23\d|24\d|25[0-5])\./.test(
                url.hostname,
              )
            );
          } catch {
            return true;
          }
        }),
      );
      if (privateUrl) return finish("fallback", "judge_invalid_input");
    }
    const threshold = Number(
      config.jevSites?.[site]?.threshold ??
        (site === "reply-check"
          ? config.reviewJevSupportConfidence
          : policy.threshold) ??
        policy.threshold,
    );
    const fingerprint = judgePromptFingerprint(
      site,
      request.questions,
      threshold,
      config.reviewJevModel,
    );
    if (site !== "reply-check" && !calibrationMode) {
      if (config.jevSites?.[site]?.calibration !== "calibrated")
        return finish("fallback", "judge_uncalibrated");
      // The calibration is bound to the prompt, capability ids and all (J3's options are the catalogue's), so
      // a changed prompt stands the site down. That has to be seen: it is marked here and shows in status().
      if (config.jevSites?.[site]?.promptFingerprint !== fingerprint) {
        if (!blocked.has(site)) blocked.set(site, now());
        return finish("fallback", "judge_calibration_mismatch", {
          promptFingerprint: fingerprint,
        });
      }
      blocked.delete(site);
    }
    const configuredTimeout = policy.interactive
      ? Number(config.jevOnlineTimeoutMs ?? 3000)
      : Number(config.reviewJevTimeoutMs ?? 15000);
    // A trusted server workflow may shorten its total budget. Gateway request
    // bodies cannot supply context, and this never changes calibrated prompts.
    const remaining = Number.isFinite(context.deadlineMs) ? context.deadlineMs - Date.now() : configuredTimeout;
    if (remaining <= 0) return finish("fallback", "judge_timeout");
    const controller = new AbortController(), timeout = Math.min(configuredTimeout, remaining);
    let observedCost = 0;
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("judge_timeout"));
      }, timeout);
    });
    controllers.add(controller);
    if (!policy.interactive) backgroundActive++;
    try {
      const work = async () => {
        const ask = async (req) => {
          try {
            const result = await callImpl(
              {
                config,
                usageLedger,
                ...(fetchImpl ? { fetchImpl } : {}),
                retryDelayMs: Math.min(200, timeout / 4),
              },
              {
                userId: context.userId,
                projectId: context.projectId,
                runId: context.runId,
                purpose: policy.purpose,
                operation: site,
                taskId: context.taskId,
                module: context.module,
                limits: context.limits,
                state: req.state,
                questions: req.questions,
                timeoutMs: timeout,
                signal: controller.signal,
              },
            );
            const key = `${site}:answered`;
            requests.set(key, (requests.get(key) ?? 0) + 1);
            return result;
          } catch (error) {
            // A refusal of this request or this account is not the provider failing: it
            // stays out of the series the JevFailing alert reads (`requestRefusalCode`).
            const key = `${site}:${requestRefusalCode(error) ? "refused" : "failed"}`;
            requests.set(key, (requests.get(key) ?? 0) + 1);
            throw error;
          }
        };
        const first = await ask(request);
        let answers = first.answers,
          cost = first.cost ?? 0;
        observedCost = cost;
        if (site === "reply-check")
          return {
            answers,
            cost,
            confidence: 1,
            value: null,
            model: first.model,
            promptFingerprint: fingerprint,
          };
        const decisions = decodeJudgeAnswers(site, input, answers, {
          threshold,
          model: first.model,
        }).decisions;
        if (policy.pairwise) {
          if (controller.signal.aborted) throw new Error("judge_timeout");
          const second = await ask(
            buildJudgeRequest(site, input, { reverse: true }),
          );
          cost += second.cost ?? 0;
          observedCost = cost;
          const averaged = {};
          for (const [key, question] of Object.entries(request.questions)) {
            let reversed;
            try {
              reversed = validateJudgeAnswer(second.answers?.[key], question);
            } catch (error) {
              if (site !== "J1") throw error;
              reversed = {
                choice: "related",
                confidence: 0,
                probabilities: { unrelated: 0, related: 0 },
              };
            }
            const probabilities = {};
            if (
              site === "J1" &&
              (decisions[key].confidence === 0 || reversed.confidence === 0)
            ) {
              averaged[key] = {
                type: "choice",
                choice: "related",
                confidence: 0,
                probabilities: { unrelated: 0, related: 1 },
              };
              continue;
            }
            for (const option of Object.keys(question.criteria))
              probabilities[option] =
                (decisions[key].probabilities[option] +
                  reversed.probabilities[option]) /
                2;
            const choices = Object.keys(probabilities).sort(
              (a, b) => probabilities[b] - probabilities[a],
            );
            if (
              site !== "J1" &&
              probabilities[choices[0]] === probabilities[choices[1]]
            )
              return {
                answers,
                cost,
                confidence: 0,
                value: null,
                model: first.model,
                promptFingerprint: fingerprint,
              };
            const confidence =
              (choices.length * probabilities[choices[0]] - 1) /
              (choices.length - 1);
            averaged[key] = {
              type: "choice",
              choice: choices[0],
              probabilities,
              confidence: Math.min(
                confidence,
                decisions[key].confidence,
                reversed.confidence,
              ),
            };
            try {
              decisions[key] = validateJudgeAnswer(averaged[key], question);
            } catch (error) {
              if (site !== "J1") throw error;
              averaged[key] = {
                type: "choice",
                choice: "related",
                confidence: 0,
                probabilities: { unrelated: 0, related: 1 },
              };
            }
          }
          answers = averaged;
        }
        const decoded = decodeJudgeAnswers(site, input, answers, {
          threshold,
          model: first.model,
        });
        return {
          answers,
          cost,
          confidence: decoded.confidence,
          value: decoded.value,
          model: first.model,
          promptFingerprint: fingerprint,
          ...(decoded.partial ? { partial: decoded.partial } : {}),
          ...(decoded.itemsTotal ? { itemsSettled: decoded.itemsSettled, itemsTotal: decoded.itemsTotal } : {}),
        };
      };
      const active = work();
      pending.add(active);
      const completed = () => {
        pending.delete(active);
        controllers.delete(controller);
        if (!policy.interactive) backgroundActive--;
      };
      void active.then(completed, completed);
      const result = await Promise.race([active, expired]);
      circuits.set(site, { failures: 0, until: 0 });
      // How many items of a batch were sure, settled batch or not: the batch counter alone reads 0 of 9.
      if (result.itemsTotal) {
        if (result.itemsSettled) count(site, "item_settled", result.itemsSettled);
        if (result.itemsTotal > result.itemsSettled) count(site, "item_escalated", result.itemsTotal - result.itemsSettled);
      }
      if (result.confidence < threshold)
        return finish("escalated", "judge_uncertain", {
          ...result,
          value: null,
        });
      const settled = finish("settled", "judge_settled", result);
      mintEngineComparison(site, request, settled, context);
      const sample = drift(site, settled, context);
      pending.add(sample);
      void sample.finally(() => pending.delete(sample));
      return settled;
    } catch (error) {
      // The Jev client's own code (`jev_payment_required`, `jev_auth_failed`, ...),
      // for a caller that reports why: a code only, never a message.
      const cause = /^[a-z0-9_]{1,64}$/.test(String(error?.code ?? "")) ? { cause: String(error.code) } : {};
      const refusal = requestRefusalCode(error);
      if (refusal)
        return finish("fallback", refusal, { promptFingerprint: fingerprint, cost: observedCost, ...cause });
      const failures = (circuits.get(site)?.failures ?? 0) + 1;
      circuits.set(site, {
        failures,
        until: failures >= 3 ? now() + 300000 : 0,
      });
      return finish(
        "fallback",
        error?.message === "judge_timeout" || controller.signal.aborted
          ? "judge_timeout"
          : "judge_provider_failure",
        { promptFingerprint: fingerprint, cost: observedCost, ...cause },
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    judge,
    compareEngine,
    status,
    metrics,
    requestMetrics: () =>
      [...requests].map(([key, value]) => {
        const [site, outcome] = key.split(":");
        return { site, outcome, value };
      }),
    driftMetrics: () => judgeDriftSummary(database, config),
    skipped,
    /** The families `/api/ops/metrics` serves for the judge sites. */
    async metricFamilies() {
      const rows = metrics();
      const observed = await judgeDriftSummary(database, config).catch(() => []);
      return [
        { name: "open_science_jev_decisions_total", help: "Registered Jev decisions by site.", type: "counter",
          series: rows.filter((row) => ["settled", "escalated", "fallback"].includes(row.outcome)).map((row) => ({ value: row.value, labels: { site: row.site, outcome: row.outcome } })) },
        { name: "open_science_jev_requests_total", help: "Registered Jev calls by site.", type: "counter",
          series: [...requests].map(([key, value]) => { const [site, outcome] = key.split(":"); return { value, labels: { site, outcome } }; }) },
        { name: "open_science_jev_fallback_reasons_total", type: "counter",
          help: "Why Jev decisions fell back to the original path, by site and the service's own code (judge_calibration_mismatch: a calibrated site's prompt no longer matches what was measured).",
          series: [...reasons].map(([key, value]) => { const [site, code] = key.split(":"); return { value, labels: { site, code } }; }) },
        { name: "open_science_jev_items_total", type: "counter",
          help: "Items of a batch of independent items (J5) by whether each was sure on its own: settled, or escalated to the original path; a batch is settled only when all of its items are.",
          series: rows.filter((row) => row.outcome.startsWith("item_")).map((row) => ({ value: row.value, labels: { site: row.site, outcome: row.outcome.slice(5) } })) },
        { name: "open_science_jev_skipped_total", type: "counter",
          help: "Work a registered Jev site was not asked to do, by reason: run_out_of_scope counts runs; lines_over_cap and lines_after_notice_limit count report lines.",
          series: rows.filter((row) => row.outcome.startsWith("skip_")).map((row) => ({ value: row.value, labels: { site: row.site, reason: row.outcome.slice(5) } })) },
        { name: "open_science_jev_drift_observations_total", type: "counter",
          help: "Drift comparisons by site: compared (an observation was recorded), failed (the original path or the record failed), expired (an engine's receipt came back too late), busy (no room to sample).",
          series: rows.filter((row) => row.outcome.startsWith("drift_")).map((row) => ({ value: row.value, labels: { site: row.site, outcome: row.outcome.slice(6) } })) },
        { name: "open_science_jev_drift_below_baseline_seven_days", help: "Seven consecutive observed UTC days below calibrated baseline.", type: "gauge",
          series: observed.map((row) => ({ value: row.belowBaselineSevenDays ? 1 : 0, labels: { site: row.site } })) },
        { name: "open_science_jev_drift_baseline_configured", type: "gauge",
          help: "Whether a site's pin carries the baseline agreement its drift alert compares with; 0 means JevCalibrationDrift cannot fire for that site.",
          series: observed.map((row) => ({ value: row.baselineConfigured ? 1 : 0, labels: { site: row.site } })) },
        { name: "open_science_jev_baseline_agreement", help: "Observed agreement against trusted baseline; absent samples are omitted.", type: "gauge",
          series: observed.filter((row) => row.agreement !== null).map((row) => ({ value: row.agreement, labels: { site: row.site } })) },
      ];
    },
    async close() {
      closed = true;
      clearInterval(comparisonCleanup);
      comparisons.clear();
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
