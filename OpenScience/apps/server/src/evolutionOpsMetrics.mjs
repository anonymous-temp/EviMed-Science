/**
 * What the operator can see of 「循证进化」's limits (`/api/ops/metrics`).
 *
 * A limit without an observable counter does not exist for the operator (principle 15). Four of them are
 * counted where they act, and this is where they are scraped:
 *  - the tenant tool gateway's admission: calls admitted and refused, by which question refused (host capacity,
 *    the module's budget, a project's calls in flight, a project's calls per minute);
 *  - the platform-skill supply: selections that failed and were allowed to cost nothing, the last verified
 *    generation used instead, and generations found altered and rebuilt;
 *  - the evaluation exclusion layer: run lookups that failed and were ignored, lookups of the module's own
 *    projects that failed, and evaluation requests refused for an unreadable policy; and, beside them, the
 *    development runs whose model named the reference paper from memory (`recalled`: a label, not a limit);
 *  - the candidate executor's slots and timeout, counted in the runtime controller where they act (it exposes no
 *    metrics of its own) and read through its admission endpoint.
 * `open_science_evolution_enabled` is exported with the module off, and `open_science_evolution_refused` says why a
 * module that was switched on is not running.
 */

/** @typedef {{ name: string, help: string, type: string, series: { value: number, labels?: Record<string, string> }[] }} MetricFamily */

/**
 * @param {{ evolution: any, evaluationIsolation?: any, config?: any }} sources
 * @returns {Promise<{ toolAdmission: any, supply: any, isolation: any, executor: any, integration: any, limits: any } | null>} null when the module is not composed
 */
export async function evolutionOpsSnapshot({ evolution, evaluationIsolation = null }) {
  if (!evolution) return null;
  // The controller is another process; a scrape is never held up by it.
  const executor = typeof evolution.executorCounters === "function"
    ? await Promise.race([evolution.executorCounters().catch(() => null), new Promise((resolve) => { setTimeout(() => resolve(null), 2000).unref(); })])
    : null;
  return {
    toolAdmission: evolution.toolAdmission?.counters ?? null,
    supply: evolution.supply?.status?.() ?? null,
    isolation: evaluationIsolation?.counters ?? null,
    integration: evolution.integration?.counters ?? null,
    // The limits that act inside the loops themselves (the account floors, the proposals sent to the operators, ...), gathered by the composition.
    limits: typeof evolution.limitCounters === "function" ? evolution.limitCounters() : null,
    executor,
  };
}

/**
 * @param {boolean} composed whether the module is running @param {any} snapshot @param {{ code: string, key: string } | null} [refusal]
 * @returns {MetricFamily[]}
 */
export function evolutionOpsMetricFamilies(composed, snapshot, refusal = null) {
  /** @type {MetricFamily[]} */
  const families = [{
    name: "open_science_evolution_enabled", type: "gauge", series: [{ value: composed ? 1 : 0 }],
    help: "Whether the 循证进化 module is running (0 when it is off, or switched on but refused to start).",
  }];
  if (refusal) families.push({
    name: "open_science_evolution_refused", type: "gauge", series: [{ value: 1, labels: { code: refusal.code, key: refusal.key } }],
    help: "The module was switched on and refused to start because a setting is wrong: the code and the setting's key, never its value.",
  });
  if (!composed || !snapshot) return families;
  const rows = (/** @type {any} */ counters, /** @type {Record<string, string>} */ names) => counters
    ? Object.entries(names).map(([key, outcome]) => ({ value: Number(counters[key]) || 0, labels: { outcome } })) : [];
  if (snapshot.toolAdmission) families.push({
    name: "open_science_evolution_tool_admission_total", type: "counter",
    help: "Calls of a published platform tool by tenants, by whether they were admitted or which question refused them: host capacity, the module's own daily budget, a project's calls in flight, a project's calls in a minute, or too many projects tracked.",
    series: rows(snapshot.toolAdmission, { admitted: "admitted", refusedHostCapacity: "refused_host_capacity", refusedBudget: "refused_budget",
      refusedProjectConcurrency: "refused_project_concurrency", refusedProjectRate: "refused_project_rate", refusedBusy: "refused_busy" }),
  });
  if (snapshot.supply) families.push({
    name: "open_science_evolution_platform_skill_events_total", type: "counter",
    help: "Platform-skill generation problems that were not allowed to stop a runtime start or a dispatch, since process start: failed selections, starts that used the last verified generation instead, and altered generations rebuilt.",
    series: [
      { value: Number(snapshot.supply.failures) || 0, labels: { event: "failed" } },
      { value: Number(snapshot.supply.fallbacks) || 0, labels: { event: "fallback_used" } },
      { value: Number(snapshot.supply.rebuilt) || 0, labels: { event: "generation_rebuilt" } },
    ],
  });
  if (snapshot.isolation) families.push({
    name: "open_science_evolution_isolation_lookup_total", type: "counter",
    help: "Evaluation exclusion layer lookups that went wrong, by outcome: a run lookup that failed and was ignored, a lookup in the module's own other projects that failed and was ignored, and an evaluation request refused for an unreadable policy.",
    series: rows(snapshot.isolation, { runLookupFailed: "run_lookup_failed", platformLookupFailed: "platform_lookup_failed", refused: "refused" }),
  });
  if (snapshot.isolation) families.push({
    name: "open_science_evolution_reference_recalled_total", type: "counter",
    help: "Development runs whose model named the protected reference paper from its own memory, with nothing served to it and no source event that matched it. Recorded and reported with the result; not an exposure, and it does not make a candidate wait.",
    series: [{ value: Number(snapshot.isolation.recalled) || 0 }],
  });
  if (snapshot.integration) families.push({
    name: "open_science_evolution_events_total", type: "counter",
    help: "Observations the other modules published to the evolution queue, by outcome since process start.",
    series: rows(snapshot.integration, { published: "published", failed: "failed" }),
  });
  const limits = snapshot.limits ?? {};
  if (limits.signals) families.push({
    name: "open_science_evolution_signal_groups", type: "gauge",
    help: "User-originated signal groups at the platform loop's last aggregation, by account class (researcher or operator) and outcome: written as a summary because enough different accounts of the class showed it, or held back below the class's floor (five researchers; the operator floor for operators).",
    series: ["user", "operator"].flatMap((accountClass) => [
      { value: Number(limits.signals.aggregated?.[accountClass]) || 0, labels: { class: accountClass, outcome: "aggregated" } },
      { value: Number(limits.signals.heldBack?.[accountClass]) || 0, labels: { class: accountClass, outcome: "held_back" } },
    ]),
  });
  if (limits.engineReviews) families.push({
    name: "open_science_evolution_engine_reviews_total", type: "counter",
    help: "Proposals for the platform's own code, since process start: inbox items sent to the operators, passes where nobody could be told (retried within the minute), and the answers given: adopted (kept as work to implement) or declined.",
    series: [["announced", "announced"], ["announceFailed", "announce_failed"], ["adopted", "adopted"], ["declined", "declined"]]
      .map(([key, outcome]) => ({ value: Number(limits.engineReviews[key]) || 0, labels: { outcome } })),
  });
  if (limits.policy) families.push({
    name: "open_science_evolution_policy_ignored_fields_total", type: "counter",
    help: "Fields of a stored research policy (or trial candidate) that the policy no longer has and that were ignored on reading it, since process start; each stored policy is counted once, however often it is read.",
    series: [{ value: Number(limits.policy.ignoredFields) || 0 }],
  });
  if (limits.resourceWaits) families.push({
    name: "open_science_evolution_resource_waits_total", type: "counter",
    help: "Waits for material only an outside party can bring, since process start, by the category that used to ask about them: each is written on its dossier or failure record (resourceWait) and picked up again by the opportunity's wake conditions. No decision, card or inbox line is made for them; `unrecorded` counts the annotations that could not be written, which never fail the job.",
    series: [...Object.entries(limits.resourceWaits.resourceWaits ?? {}).map(([category, value]) => ({ value: Number(value) || 0, labels: { category } })),
      { value: Number(limits.resourceWaits.resourceWaitFailed) || 0, labels: { category: "unrecorded" } }],
  });
  if (limits.retention) families.push({
    name: "open_science_evolution_records_folded_total", type: "counter",
    help: "Records of the loops folded into a count of their day and deleted, since process start: module observations that counted no failure, and processed routine events (OPEN_SCIENCE_EVOLUTION_RECORD_RETENTION_DAYS); passes that failed leave every row where it was.",
    series: [["observationsFolded", "module_observation"], ["eventsFolded", "event"], ["failures", "pass_failed"]]
      .map(([key, record]) => ({ value: Number(limits.retention[key]) || 0, labels: { record } })),
  });
  if (limits.heavyWindow) families.push({
    name: "open_science_evolution_heavy_window_open", type: "gauge", series: [{ value: limits.heavyWindow.open ? 1 : 0 }],
    help: "Whether the heavy, model-intensive evolution jobs may be claimed now: 1 inside OPEN_SCIENCE_EVOLUTION_HEAVY_WINDOW (22:00-07:00 China time by default) or when there is no window, 0 outside it.",
  }, {
    name: "open_science_evolution_heavy_jobs_started_total", type: "counter",
    help: "Heavy, model-intensive evolution jobs claimed since process start, by whether the window was open: `outside` counts only jobs asked for by kind (an operator's or a test's), never the polling worker's.",
    series: ["inside", "outside"].map((window) => ({ value: Number(limits.heavyWindow.started?.[window]) || 0, labels: { window } })),
  });
  if (limits.selfResearch) {
    const research = limits.selfResearch;
    const entries = (/** @type {any} */ map) => Object.entries(map ?? {});
    families.push({
      name: "open_science_evolution_self_research_items_total", type: "counter",
      help: "What the weekly self-research funnel did with the entries the plugin's AI-discovery rows brought, since process start, by stage: collected (entries read), merged (papers and posts left after merging the rows that list the same one), already_screened (left out: screened in the last two weeks), screened, shortlisted, full_texts (papers read whole), cards (mechanism cards written), rejected (cards that failed the quotation and field checks), venue_events (proceedings volumes set apart).",
      series: [["collected", "collected"], ["merged", "merged"], ["alreadyScreened", "already_screened"], ["screened", "screened"], ["shortlisted", "shortlisted"],
        ["fullTexts", "full_texts"], ["cards", "cards"], ["rejected", "rejected"], ["venueEvents", "venue_events"]]
        .map(([key, stage]) => ({ value: Number(research[key]) || 0, labels: { stage } })),
    }, {
      name: "open_science_evolution_self_research_cap_hits_total", type: "counter",
      help: "Weeks, since process start, in which a stage of the self-research funnel had more than its cap let through (OPEN_SCIENCE_EVOLUTION_SELF_RESEARCH_*_LIMIT; collect is the week's fixed ceiling on entries read).",
      series: entries(research.capHits).map(([cap, value]) => ({ value: Number(value) || 0, labels: { cap } })),
    }, {
      name: "open_science_evolution_self_research_failures_total", type: "counter",
      help: "What failed inside the funnel without failing the week, since process start: triage_batch (a screening call that gave no answer), extraction (a card call that gave none), venue_quote (a venue claim whose quoted words were not in the text, so the claim was dropped).",
      series: [["triageBatchesFailed", "triage_batch"], ["extractFailed", "extraction"], ["venueQuotesRejected", "venue_quote"]]
        .map(([key, kind]) => ({ value: Number(research[key]) || 0, labels: { kind } })),
    }, {
      name: "open_science_evolution_self_research_sources_total", type: "counter",
      help: "Plugin rows the funnel found readable (read) or that the plugin reports unreadable, drifted or off (skipped), summed over the weeks since process start; a skipped row does not stop the others.",
      series: [["sourcesRead", "read"], ["sourcesSkipped", "skipped"]].map(([key, state]) => ({ value: Number(research[key]) || 0, labels: { state } })),
    }, {
      name: "open_science_evolution_self_research_full_text_fallbacks_total", type: "counter",
      help: "Papers read from their abstract instead of whole, since process start, by the closed reason (no_reader, not_arxiv, a web-read code, empty, unreachable).",
      series: entries(research.fullTextFallbacks).map(([reason, value]) => ({ value: Number(value) || 0, labels: { reason } })),
    }, {
      name: "open_science_evolution_self_research_enrichment_total", type: "counter",
      help: "Weeks, since process start, in which a scholarly index was asked about the shortlist, by provider and outcome: ok, no_key (skipped: the deployment has no key), or the closed code of what failed.",
      series: entries(research.enrichment).flatMap(([provider, outcomes]) => entries(outcomes).map(([outcome, value]) => ({ value: Number(value) || 0, labels: { provider, outcome } }))),
    });
  }
  if (limits.sourceRequests) families.push({
    name: "open_science_evolution_source_requests_total", type: "counter",
    help: "What became of the sources the scout suggested for the knowledge-source plugin, since process start: filed (on the list the plugin pulls), duplicate (already filed), invalid (not an https address with a name), unsupported_host (a host the plugin does not admit), not_a_feed (the address is not an RSS or Atom feed with entries), unreachable, cap_reached (the plugin reads twenty-five), and, of the filed ones, admitted (the plugin took it) and lapsed (it had not in OPEN_SCIENCE_EVOLUTION_SOURCE_REQUEST_LAPSE_DAYS).",
    series: [["filed", "filed"], ["duplicate", "duplicate"], ["invalid", "invalid"], ["unsupportedHost", "unsupported_host"], ["notAFeed", "not_a_feed"], ["unreachable", "unreachable"],
      ["capReached", "cap_reached"], ["admitted", "admitted"], ["lapsed", "lapsed"]].map(([key, outcome]) => ({ value: Number(limits.sourceRequests[key]) || 0, labels: { outcome } })),
  }, {
    name: "open_science_evolution_source_requests_waiting", type: "gauge", series: [{ value: Number(limits.sourceRequests.waiting) || 0 }],
    help: "Sources on the list the knowledge-source plugin pulls that it has neither taken nor let lapse, at the last look (at most 25).",
  });
  families.push({
    name: "open_science_evolution_executor_reachable", type: "gauge", series: [{ value: snapshot.executor ? 1 : 0 }],
    help: "Whether the runtime controller answered for the candidate executor's counters on this scrape (0: the executor series below are absent).",
  });
  if (snapshot.executor) families.push({
    name: "open_science_evolution_executor_total", type: "counter",
    help: "Candidate executions and dependency preparations since the runtime controller started, by outcome: ok, candidate_failed (the candidate's own failure), unavailable (no slot or admission lock, an executor blocked by an unconfirmed attempt, or the container daemon failing), timed_out (killed at the execution timeout), canceled (the caller left), errored, and dependencies_prepared / dependency_preparation_failed.",
    series: rows(snapshot.executor, { ok: "ok", candidateFailed: "candidate_failed", unavailable: "unavailable", timedOut: "timed_out", canceled: "canceled",
      errored: "errored", dependenciesPrepared: "dependencies_prepared", dependencyPreparationFailed: "dependency_preparation_failed" }),
  });
  return families;
}
