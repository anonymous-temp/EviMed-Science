/** Selected coverage presenters. Counts retain their actual unit, with no new clinical verdict or metric formula. */
import { createHash } from "node:crypto";
import {
  documentExportDigest,
  geoAnswerAccuracy,
  geoJudgementCoverage,
  geoClaimAssessmentIdentity,
  geoClaimApplicability,
  geoMetricMembers,
  GEO_METRIC_UNITS,
} from "@evimed/domain";
import { computeGeoSelection } from "./geoReadScope.mjs";
import { HttpError } from "./security.mjs";
const hash = (value) =>
  createHash("sha256").update(documentExportDigest(value)).digest("hex");
export const GEO_COVERAGE_VIEWS = Object.freeze([
  "V06",
  "V07",
  "V11",
  "V12",
  "V14",
]);
const statusLabels = {
  questions: "原始问题",
  returned: "取得回答",
  refused: "拒答",
  failed: "采集失败",
  suspect: "采集存疑",
  pending: "等待采集",
  skipped: "已跳过",
  unsampled: "未安排采集",
  complete: "完整判定",
  partial: "部分判定",
  unjudged: "未判定",
  unknown: "判定未知",
  correct: "正确",
  wrong: "错误",
  unverifiable: "无法核实",
  not_applicable: "无临床陈述",
  assessed: "已判陈述",
  condition_unknown: "条件未知",
  metric: "所选指标",
  observations: "全部记录",
  not_obtained: "未取得回答",
  planned: "实际安排",
  applicable: "含临床陈述",
  applicability_unknown: "临床适用性未知",
};
const collectionKeys = [
  "returned",
  "refused",
  "failed",
  "suspect",
  "pending",
  "skipped",
];
const coverageKeys = ["complete", "partial", "unjudged", "unknown"];
const activeStatements = (observation) =>
  (
    observation.facts?.statements ??
    observation.assessmentFacts?.statements ??
    []
  ).filter(
    (statement) =>
      statement.judgmentState !== "withdrawn" &&
      statement.judgementState !== "withdrawn" &&
      statement.judgment_state !== "withdrawn",
  );
const coverage = (observation) =>
  !observation.facts ? "unjudged" : geoJudgementCoverage(observation.facts);
const answerItem = (row) => ({
  id: row.snapshotId,
  unit: "answers",
  snapshotId: row.snapshotId,
  questionId: row.questionId,
  roundId: row.roundId,
  engine: row.engine,
  repeatIndex: row.repeatIndex,
  askedAt: row.askedAt ?? null,
  status: row.status,
  surface: row.surface ?? null,
  judgment: row.facts ?? row.assessmentFacts ?? null,
  citations: row.citations ?? [],
});
const questionItem = (question) => ({
  id: question.id,
  unit: "questions",
  questionId: question.id,
  questionVersion: question.set_version,
  originalId: question.original_id ?? question.original_question_id ?? null,
  originalRow:
    question.original_row_index ??
    question.original_row ??
    question.original_row_number ??
    null,
  text: question.text,
  originalGroup: question.original_group ?? null,
  clientTags: question.client_tags ?? [],
  classificationStatus: question.classification_status ?? null,
});
const jobItem = (job) => ({
  id: job.id,
  unit: "asks",
  questionId: job.question_id,
  roundId: job.round_id,
  engine: job.engine,
  repeatIndex: job.repeat_index,
  status: job.status,
  reason:
    job.error_code ??
    (job.linked_snapshot_id
      ? "snapshot_outside_selected_observations"
      : job.status === "done"
        ? "snapshot_missing"
        : job.status),
  snapshotId: job.snapshot_id ?? null,
  attempts: job.attempts ?? null,
  scheduledAt: job.run_after ?? null,
});
const collection = (item) =>
  item.unit === "asks"
    ? item.status === "failed"
      ? "failed"
      : item.status === "skipped"
        ? "skipped"
        : item.status === "done"
          ? "unknown"
          : "pending"
    : item.status === "valid"
      ? "returned"
      : item.status === "refusal"
        ? "refused"
        : item.status === "failed"
          ? "failed"
          : item.status === "suspect"
            ? "suspect"
            : "unknown";
const by = (list, key) => {
  const map = new Map();
  for (const item of list) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
};
function dateOf(value, timeZone) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
/** Original selected questions, actual jobs and observations; never create a question x engine x round x repeat product.
 * @param {any} selected @param {any} view @param {any} context */
export function buildGeoCoverageAnalysis(selected, view, context = {}) {
  const observations = selected.rows ?? [],
    questions = context.questions ?? selected.questions ?? [],
    jobs = context.jobs ?? [],
    engines =
      context.engines ??
      selected.selection.engines ??
      selected.metricOptions?.engines ??
      [];
  const snapshotById = new Map(
    (context.snapshots ?? []).map((item) => [item.id, item]),
  );
  const obtainedJobIds = new Set(
    observations
      .map((row) => snapshotById.get(row.snapshotId)?.probe_job_id)
      .filter(Boolean),
  );
  const observedIds = new Set(observations.map((row) => row.snapshotId));
  // A job whose snapshot is outside a dated selection is scheduled context, never an observed failure.
  const jobItems = jobs
    .filter(
      (job) => !obtainedJobIds.has(job.id) && !observedIds.has(job.snapshot_id),
    )
    .map(jobItem);
  const answers = observations.map(answerItem);
  const observationById = new Map(
    observations.map((row) => [row.snapshotId, row]),
  );
  if (view.viewId === "V07" && questions.length * engines.length > 20000)
    throw new HttpError(
      422,
      "geo_read_filter_invalid",
      "Narrow the question or engine scope to at most 20,000 question/platform rows.",
    );
  const memberItems = new Map(),
    rows = [];
  const cell = (items, unit, reason = null) => ({
    value: items.length,
    state: "known",
    reason,
    unit,
    metric: null,
    members: null,
    links: [],
    _items: items,
  });
  const absent = (unit, reason) => ({
    value: null,
    state: "unknown",
    reason,
    unit,
    metric: null,
    members: null,
    links: [],
    _items: null,
  });
  const add = (dimensions, label, values) => {
    const key = hash([view.viewId, dimensions]);
    for (const [columnKey, value] of Object.entries(values)) {
      if (value._items) memberItems.set(`${key}:${columnKey}`, value._items);
      delete value._items;
    }
    rows.push({
      key,
      label,
      metricId: view.metricId ?? null,
      dimensions,
      values,
      links: [],
    });
  };
  const counts = (items, unit = "answers") =>
    Object.fromEntries(
      collectionKeys.map((key) => [
        key,
        cell(
          items.filter((item) => collection(item) === key),
          unit,
        ),
      ]),
    );
  const judgementCounts = (items) =>
    Object.fromEntries(
      coverageKeys.map((key) => [
        key,
        cell(
          items.filter(
            (item) =>
              item.unit === "answers" &&
              item.status === "valid" &&
              coverage(observationById.get(item.id)) === key,
          ),
          "answers",
        ),
      ]),
    );
  let keys = [],
    definition = {
      metricId: null,
      unit: "derived_inputs",
      countingRule:
        "Counts of actual selected records. Collection and judgment axes overlap and have independent units.",
      denominatorRule:
        "No probability, inferred classification or replacement of domain metric denominators.",
      methodVersion: selected.selection.methodVersion,
      dataType: "observed",
    };
  const reasons = [];
  if (view.viewId === "V06") {
    const categories = by(questions, (question) =>
      documentExportDigest(
        view.categoryMode === "client_tags"
          ? (question.client_tags ?? [])
          : [question.original_group ?? null],
      ),
    );
    const categoryQuestions = new Map();
    for (const entries of categories.values())
      for (const category of view.categoryMode === "client_tags"
        ? entries[0].client_tags?.length
          ? [...new Set(entries[0].client_tags)]
          : [null]
        : [entries[0].original_group ?? null]) {
        if (!categoryQuestions.has(category))
          categoryQuestions.set(category, new Map());
        for (const question of entries)
          categoryQuestions.get(category).set(question.id, question);
      }
    if (categoryQuestions.size * engines.length + 1 > 20000)
      throw new HttpError(
        422,
        "geo_read_filter_invalid",
        "Narrow the category or platform scope to at most 20,000 rows.",
      );
    const buckets = [
      { category: null, overall: true, questions },
      ...[...categoryQuestions].map(([category, items]) => ({
        category,
        overall: false,
        questions: [...items.values()],
      })),
    ];
    const answersByQuestion = by(answers, (item) => item.questionId);
    for (const bucket of buckets)
      for (const engine of bucket.overall ? [null] : engines) {
        const items = bucket.questions
          .flatMap((question) => answersByQuestion.get(question.id) ?? [])
          .filter((item) => !engine || item.engine === engine);
        const missing = jobItems.filter(
          (item) =>
            bucket.questions.some(
              (question) => question.id === item.questionId,
            ) &&
            (!engine || item.engine === engine),
        );
        /** @type {Record<string,any>} */
        const values = {
          questions: cell(bucket.questions.map(questionItem), "questions"),
          ...counts(items),
          ...judgementCounts(items),
          not_obtained: cell(missing, "asks"),
        };
        for (const key of ["failed", "pending", "skipped"])
          values[key] = cell(
            [...items, ...missing].filter((item) => collection(item) === key),
            key === "failed" ? "records" : "asks",
          );
        if (view.metricId) {
          const computed = computeGeoSelection(
            items.map((item) => observationById.get(item.id)),
            { ...selected.metricOptions, engines: engine ? [engine] : engines },
          );
          const metric = computed.cells.find(
            (item) =>
              item.metricId === view.metricId &&
              item.scope === (engine ? "engine" : "project") &&
              (!engine || item.engine === engine) &&
              !item.variant &&
              !item.rival &&
              !item.arm,
          );
          values.metric = {
            value: metric?.value ?? null,
            state:
              metric?.status === "ok" ? "known" : (metric?.status ?? "unknown"),
            unit: GEO_METRIC_UNITS[view.metricId] ?? "index",
            memberUnit: "answers",
            reason: metric ? metric.reason : "no_selected_readings",
            metric: metric ?? null,
            members: null,
            links: [],
            _items: metric
              ? geoMetricMembers(
                  /** @type {any[]} */ (
                    metric.scope === "engine"
                      ? computed.balance.deduped
                      : computed.balance.rows
                  ),
                  metric,
                  selected.metricOptions,
                ).rows.map(answerItem)
              : [],
          };
        }
        add(
          {
            categoryMode: view.categoryMode,
            category: bucket.category,
            overall: bucket.overall,
            engine,
          },
          `${bucket.overall ? "去重总体" : (bucket.category ?? "未分类")}${engine ? ` · ${engine}` : ""}`,
          values,
        );
      }
    keys = [
      "questions",
      "not_obtained",
      ...collectionKeys,
      ...coverageKeys,
      ...(view.metricId ? ["metric"] : []),
    ];
    if (
      !questions.some((question) =>
        view.categoryMode === "client_tags"
          ? question.client_tags?.length
          : question.original_group != null,
      )
    )
      reasons.push("original_categories_missing");
  } else if (view.viewId === "V07") {
    const itemsByQuestion = by(
      [...answers, ...jobItems],
      (item) => item.questionId,
    );
    for (const question of questions)
      for (const engine of engines) {
        const items = (itemsByQuestion.get(question.id) ?? []).filter(
            (item) => item.engine === engine,
          ),
          answerItems = items.filter((item) => item.unit === "answers"),
          asks = items.filter((item) => item.unit === "asks");
        const values = {
          observations: cell(items, "records"),
          not_obtained: cell(asks, "asks"),
          ...counts(answerItems),
          ...judgementCounts(answerItems),
          unsampled: items.length
            ? cell([], "questions")
            : cell([questionItem(question)], "questions", "not_planned"),
        };
        for (const key of ["failed", "pending", "skipped"])
          values[key] = cell(
            asks
              .filter((item) => collection(item) === key)
              .concat(answerItems.filter((item) => collection(item) === key)),
            key === "pending" || key === "skipped" ? "asks" : "records",
          );
        add(
          {
            questionId: question.id,
            questionVersion: question.set_version,
            basis: answerItems.length
              ? asks.length
                ? "observed_and_scheduled"
                : "observed"
              : asks.length
                ? "scheduled_only"
                : "unsampled",
            originalId: questionItem(question).originalId,
            engine,
          },
          `${question.text} · ${engine}`,
          values,
        );
      }
    keys = [
      "observations",
      "not_obtained",
      ...collectionKeys,
      ...coverageKeys,
      "unsampled",
    ];
  } else if (view.viewId === "V11") {
    const observedBuckets = by(answers, (item) =>
      documentExportDigest([
        item.engine,
        item.roundId,
        dateOf(item.askedAt, selected.scope.timeZone),
      ]),
    );
    for (const [key, items] of observedBuckets) {
      const [engine, roundId, date] = JSON.parse(key);
      add(
        { basis: "observed", engine, roundId, date },
        `${engine} · ${roundId} · ${date ?? "采样时间未知"}`,
        {
          planned: absent("asks", "observed_records_are_not_a_plan"),
          not_obtained: absent("asks", "observed_records_are_not_a_plan"),
          ...counts(items),
          ...judgementCounts(items),
        },
      );
    }
    const jobBuckets = by(jobItems, (item) =>
      documentExportDigest([item.engine, item.roundId]),
    );
    // Explicit empty engine/round coverage is separate from the observed denominator.
    for (const round of context.rounds ?? selected.rounds)
      for (const engine of engines) {
        const key = documentExportDigest([engine, round.id]),
          items = jobBuckets.get(key) ?? [];
        if (
          jobs.some(
            (job) => job.round_id === round.id && job.engine === engine,
          ) ||
          !observations.some(
            (item) => item.roundId === round.id && item.engine === engine,
          )
        )
          add(
            {
              basis: "scheduled_jobs",
              engine,
              roundId: round.id,
              date: null,
              scheduledDate: round.sample_date ?? null,
            },
            `${engine} · ${round.id} · 计划与缺失任务`,
            {
              planned: jobs.some(
                (job) => job.round_id === round.id && job.engine === engine,
              )
                ? cell(
                    jobs
                      .filter(
                        (job) =>
                          job.round_id === round.id && job.engine === engine,
                      )
                      .map(jobItem),
                    "asks",
                  )
                : absent("asks", "plan_records_unavailable"),
              not_obtained: jobs.some(
                (job) => job.round_id === round.id && job.engine === engine,
              )
                ? cell(items, "asks")
                : absent("asks", "plan_records_unavailable"),
              ...Object.fromEntries(
                Object.entries(counts(items, "asks")).map(([name, value]) => [
                  name,
                  jobs.some(
                    (job) => job.round_id === round.id && job.engine === engine,
                  )
                    ? value
                    : absent("asks", "plan_records_unavailable"),
                ]),
              ),
              ...Object.fromEntries(
                coverageKeys.map((k) => [
                  k,
                  absent("answers", "scheduled_context_not_observed"),
                ]),
              ),
            },
          );
      }
    keys = ["planned", "not_obtained", ...collectionKeys, ...coverageKeys];
    if (selected.selection.timeCoverage?.unknownTime)
      reasons.push("unknown_sampling_time");
    reasons.push("scheduled_jobs_separate_from_observed");
  } else {
    const statements = [];
    for (const observation of observations)
      for (const [index, statement] of activeStatements(
        observation,
      ).entries()) {
        if (statements.length >= 200000)
          throw new HttpError(
            422,
            "geo_read_filter_invalid",
            "Narrow the selection to at most 200,000 statements.",
          );
        statements.push({
          id: hash([
            observation.snapshotId,
            observation.facts?.judgedAt ??
              observation.assessmentFacts?.judgedAt ??
              null,
            index,
            statement,
          ]),
          unit: "statements",
          snapshotId: observation.snapshotId,
          questionId: observation.questionId,
          engine: observation.engine,
          roundId: observation.roundId,
          statement,
          assessmentVersion:
            observation.facts?.judgedAt ??
            observation.assessmentFacts?.judgedAt ??
            null,
          claimIdentity: geoClaimAssessmentIdentity(statement),
          citations: observation.citations ?? [],
        });
      }
    if (view.viewId === "V12") {
      const completeApplicable = observations.filter(
        (row) => row.status === "valid" && row.facts,
      );
      const applicability = (row) => row.facts?.checks?.clinicalApplicability;
      const confirmedNA = (row) =>
        row.status === "valid" &&
        applicability(row)?.schemaVersion === 1 &&
        applicability(row)?.rubric === "geo-clinical-applicability-v1" &&
        applicability(row)?.status === "not_applicable" &&
        applicability(row)?.validated === true &&
        geoJudgementCoverage(row.facts) === "complete" &&
        !activeStatements(row).length;
      const answerState = (row) =>
        confirmedNA(row)
          ? "not_applicable"
          : !row.facts || row.status !== "valid"
            ? "unknown"
            : geoAnswerAccuracy(row.facts) === "unknown" &&
                activeStatements(row).length &&
                activeStatements(row).every(
                  (statement) => statement.verdict === "unverifiable",
                )
              ? "unverifiable"
              : geoAnswerAccuracy(row.facts);
      keys = [
        "correct",
        "wrong",
        "unverifiable",
        "unknown",
        "partial",
        "unjudged",
        "refused",
        "not_applicable",
      ];
      const valueFor = (unit, items) =>
        Object.fromEntries(
          keys.map((key) => [
            key,
            key === "not_applicable" &&
            (unit === "statements" ||
              !completeApplicable.some(
                (row) => applicability(row)?.validated === true,
              ))
              ? absent(unit, "no_validated_applicability_assessment")
              : cell(
                  items.filter((item) =>
                    unit === "answers"
                      ? key === "refused"
                        ? item.status === "refusal"
                        : key === "unjudged"
                          ? item.status === "valid" &&
                            !observationById.get(item.id).facts
                          : answerState(observationById.get(item.id)) === key
                      : key ===
                        (["correct", "wrong", "unverifiable"].includes(
                          item.statement.verdict,
                        )
                          ? item.statement.verdict
                          : "unknown"),
                  ),
                  unit,
                ),
          ]),
        );
      const statementValues = valueFor("statements", statements);
      if (
        observations.some(
          (row) =>
            row.status === "valid" &&
            (!row.facts || geoJudgementCoverage(row.facts) !== "complete"),
        )
      )
        statementValues.unknown = absent(
          "statements",
          "unextracted_statement_count_unknown",
        );
      const answerValues = valueFor("answers", answers);
      const knownApplicable = (row) =>
        row.status === "valid" &&
        row.facts &&
        geoJudgementCoverage(row.facts) === "complete" &&
        applicability(row)?.schemaVersion === 1 &&
        applicability(row)?.rubric === "geo-clinical-applicability-v1" &&
        applicability(row)?.validated === true &&
        applicability(row)?.status === "applicable";
      answerValues.applicable = cell(
        answers.filter((item) => knownApplicable(observationById.get(item.id))),
        "answers",
      );
      answerValues.applicability_unknown = cell(
        answers.filter((item) => {
          const row = observationById.get(item.id);
          return !confirmedNA(row) && !knownApplicable(row);
        }),
        "answers",
      );
      statementValues.applicable = absent(
        "statements",
        "answer_applicability_is_separate",
      );
      statementValues.applicability_unknown = absent(
        "statements",
        "answer_applicability_is_separate",
      );
      keys.push("applicable", "applicability_unknown");
      add({ unit: "answers" }, "回答级正确性", answerValues);
      add({ unit: "statements" }, "陈述级正确性", statementValues);
      reasons.push(
        "statement_not_applicable_not_a_verdict",
        "legacy_applicability_unknown",
      );
    } else {
      const buckets = by(statements, (item) =>
        documentExportDigest([
          item.statement.topic ?? null,
          item.engine,
          item.claimIdentity,
        ]),
      );
      if (buckets.size > 20000)
        throw new HttpError(
          422,
          "geo_read_filter_invalid",
          "Narrow the clinical condition scope to at most 20,000 rows.",
        );
      for (const [key, items] of buckets) {
        const [topic, engine, claimIdentity] = JSON.parse(key),
          conditions = geoClaimApplicability(items[0].statement);
        add(
          { topic, engine, claimIdentity, conditions },
          `${topic ?? "主题未知"} · ${engine} · ${conditions?.population ?? "条件未知"} · 结论版本 ${items[0].statement.claimVersion ?? "未知"} · ${JSON.stringify(conditions?.elements ?? null)}`,
          {
            wrong: cell(
              items.filter((item) => item.statement.verdict === "wrong"),
              "statements",
            ),
            assessed: cell(
              items.filter((item) =>
                ["correct", "wrong", "unverifiable"].includes(
                  item.statement.verdict,
                ),
              ),
              "statements",
            ),
            condition_unknown: cell(
              items.filter(
                (item) => geoClaimApplicability(item.statement) == null,
              ),
              "statements",
            ),
          },
        );
      }
      keys = ["wrong", "assessed", "condition_unknown"];
      definition = { ...definition, unit: "statements" };
    }
  }
  if (rows.length > 20_000)
    throw new HttpError(
      422,
      "geo_read_filter_invalid",
      "Narrow the question, engine or date scope to at most 20,000 analysis rows.",
    );
  rows.sort((a, b) => a.key.localeCompare(b.key));
  return {
    rows,
    memberItems,
    columns: keys.map((key) => ({
      key,
      label: statusLabels[key] ?? key,
      type: "number",
      unit: "count",
    })),
    definition,
    contextualBasis: [
      {
        kind: "collection_context",
        id: "scheduled_rounds",
        version: null,
        digest: hash({
          rounds: context.rounds ?? selected.rounds,
          questions,
          engines,
          jobs,
        }),
        temporalBasis: "current_context",
        questionVersions: [
          ...new Set(questions.map((question) => question.set_version)),
        ],
        engines,
      },
    ],
    availability: {
      status: reasons.includes("original_categories_missing")
        ? "unsupported"
        : !rows.length
          ? "empty"
          : reasons.length
            ? "partial"
            : "ready",
      reasons: rows.length ? reasons : ["no_selected_records"],
      remedy: reasons.includes("original_categories_missing")
        ? { kind: "questions", href: "questions", label: "补充原始分类" }
        : null,
    },
    dependencies: {
      questions,
      jobs,
      rounds: context.rounds ?? selected.rounds,
      snapshots: context.snapshots ?? [],
      observations,
    },
    chart: { labels: [], series: [] },
  };
}
