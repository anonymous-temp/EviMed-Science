import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MEMORY_PROMOTION_MIN_OCCURRENCES, MEMORY_PROMOTION_MIN_RUNS } from "@evimed/domain";
import { MemoryIntelligence, conversationMemorySources } from "../src/memoryIntelligence.mjs";

class MemoryStoreDouble {
  constructor() {
    this.records = new Map();
    this.nextId = 1;
    /** Every revision reason the store was given — the record's audit trail. */
    this.reasons = [];
  }

  async listRecords() {
    return [...this.records.values()];
  }

  async upsertRecord(_userId, input, evidence, options = {}) {
    this.reasons.push({ key: input.key, status: input.status, reason: String(options.reason ?? "") });
    const key = [input.scope, input.scopeId ?? "", input.kind, input.key].join("\u0000");
    const existing = this.records.get(key);
    if (existing && options.expectedVersion > 0 && options.expectedVersion !== existing.version) {
      const error = new Error("conflict");
      error.code = "memory_conflict";
      error.status = 409;
      throw error;
    }
    const proofs = [...(existing?.evidence ?? [])];
    if (evidence && !proofs.some((item) => item.sourceRef === evidence.sourceRef && item.quote === evidence.quote)) {
      proofs.push({ ...evidence, fingerprint: `proof_${proofs.length + 1}` });
    }
    const changed = existing && (existing.value !== input.value || existing.summary !== input.summary || existing.status !== input.status);
    const record = {
      ...existing,
      ...input,
      id: existing?.id ?? `record_${this.nextId++}`,
      version: existing ? existing.version + 1 : 1,
      evidence: proofs,
      evidenceCount: proofs.length,
      revisions: changed ? [...(existing.revisions ?? []), { version: existing.version }] : (existing?.revisions ?? []),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key, record);
    return record;
  }
}

const config = {
  deepseekProviderEnabled: true,
  deepseekApiKey: "unit-test-key",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro",
  memoryExtractionEnabled: true,
  memoryExtractionTimeoutMs: 1_000,
};

function project() {
  return { id: "project_1", userId: "user_1" };
}

/**
 * A finished run.
 *
 * `finishedAt` is a parameter because it is now load-bearing: an evidence entry
 * is stamped with the terminal time of the run that contributed it, which is
 * how "observed in separate runs" is decided. Three runs ending at the same
 * instant is not something production produces, and a fixture that pretends
 * otherwise would be testing one run three times.
 */
function run(id = "run_1", finishedAt = "2026-07-22T01:01:00.000Z") {
  return {
    id,
    sessionId: "session_1",
    mode: "open-domain",
    agentId: null,
    agentVersion: null,
    effectiveAgentId: "clinical-evidence-synthesis",
    effectiveAgentVersion: "1.0.0",
    effectiveRuntimeAgent: "research",
    model: "deepseek/deepseek-v4-pro",
    status: "succeeded",
    errorCode: null,
    artifacts: ["reports/result.md"],
    startedAt: "2026-07-22T01:00:00.000Z",
    finishedAt,
    durationMs: 60_000,
  };
}

function message(id, text) {
  return { info: { id, role: "user" }, parts: [{ type: "text", text }] };
}

function modelFetch(candidateFactory) {
  return async (_input, init) => {
    assert.match(init.headers.Authorization, /^Bearer /);
    const request = JSON.parse(String(init.body));
    const payload = JSON.parse(request.messages[1].content);
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ candidates: candidateFactory(payload.sources) }) } }],
    });
  };
}

test("a computed tool result can ground a memory, and a paraphrase of one cannot", async () => {
  // The platform's real knowledge — the estimate, the interval, the query that
  // worked — exists exactly once, in the tool result. Reconstructing it from
  // the assistant's prose loses the numbers.
  const client = new MemoryStoreDouble();
  const toolPart = {
    type: "tool",
    tool: "adr_signal_analysis",
    state: {
      status: "completed",
      input: { drug: "metformin", event: "lactic acidosis" },
      output: JSON.stringify({
        status: "success",
        summary: "Disproportionality computed.",
        data: { drug: "metformin", event: "lactic acidosis", ror: 3.42, cases: 1843 },
      }),
    },
  };
  const messages = [
    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "分析二甲双胍的乳酸酸中毒信号。" }] },
    { info: { id: "a1", role: "assistant" }, parts: [toolPart, { type: "text", text: "ROR 为 3.42。" }] },
  ];

  let sourcesSeen = null;
  const intelligence = new MemoryIntelligence(config, client, {
    fetchImpl: async (_input, init) => {
      const payload = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
      sourcesSeen = payload.sources;
      const toolSource = payload.sources.find((source) => source.role === "tool");
      return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [
        {
          scope: "project", kind: "analysis", key: "project.analysis.adr_signal.metformin",
          value: "ROR 3.42 over 1843 cases", summary: "metformin / lactic acidosis disproportionality",
          origin: "system", confidence: 1, importance: 0.8, sensitive: false,
          sourceRef: toolSource.sourceRef, evidenceQuote: '"ror":3.42',
        },
        {
          scope: "project", kind: "analysis", key: "project.analysis.paraphrased",
          value: "ROR was about 3.4", summary: "paraphrase", origin: "system",
          confidence: 1, importance: 0.8, sensitive: false,
          sourceRef: toolSource.sourceRef, evidenceQuote: "ROR was approximately 3.4",
        },
      ] }) } }] });
    },
  });

  const result = await intelligence.recordRun(project(), run("run_tool_memory"), messages);
  assert.ok(sourcesSeen.some((source) => source.role === "tool" && source.text.includes('"ror":3.42')),
    "the tool result must reach the extractor verbatim");
  assert.equal(result.extracted, 1, "the verbatim candidate is stored");
  assert.equal(result.rejected, 1, "the paraphrased candidate is refused");
  assert.match(result.rejectionReasons.join(" "), /not verbatim/);
});

test("extraction is shown the keys already in use so a repeat reinforces one memory", async () => {
  // Without this the model mints a fresh key each time — one run produced
  // user.specialty, profile.specialty, profile.work.area and
  // user.profile.work_domain for the same fact — and the profile fills with
  // synonyms that each stay at a single observation.
  const client = new MemoryStoreDouble();
  await client.upsertRecord("user_1", {
    scope: "user", scopeId: null, kind: "profile", key: "user.profile.job_title",
    value: "临床药师", summary: "临床药师", origin: "explicit", status: "active",
    confidence: 1, importance: 0.7, sensitive: false,
  }, null, {});

  let seenExisting = null;
  const intelligence = new MemoryIntelligence(config, client, {
    fetchImpl: async (_input, init) => {
      const payload = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
      seenExisting = payload.existingMemories;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }] });
    },
  });
  await intelligence.recordRun(project(), run("run_reuse"), [message("m1", "我是临床药师。")]);

  assert.ok(Array.isArray(seenExisting), "existing memories must reach the extraction prompt");
  assert.ok(
    seenExisting.some((record) => record.key === "user.profile.job_title" && record.kind === "profile"),
    "the stored profile key must be offered for reuse",
  );
  assert.ok(
    seenExisting.every((record) => record.kind !== "run_summary"),
    "run summaries are episodic and must not be offered as profile keys",
  );
});

test("memory extraction accepts only candidates backed by an exact source quote", async () => {
  const store = new MemoryStoreDouble();
  const text = "以后回答请优先引用原始研究，并明确说明证据不确定性。";
  const intelligence = new MemoryIntelligence(config, store, {
    fetchImpl: modelFetch((sources) => [{
      scope: "user",
      kind: "preference",
      key: "response.primary_evidence",
      value: "Prefer primary studies and explicit uncertainty.",
      summary: "Primary evidence first; preserve uncertainty.",
      origin: "explicit",
      confidence: 1,
      importance: 0.9,
      sensitive: false,
      sourceRef: sources[0].sourceRef,
      evidenceQuote: text,
    }]),
  });
  const result = await intelligence.recordRun(project(), run(), [message("user_1", text)]);
  assert.equal(result.extracted, 1);
  const conversation = [...store.records.values()].find((record) => record.kind === "run_summary");
  assert.equal(JSON.parse(conversation.value).question, text);
  assert.equal(JSON.parse(conversation.value).effectiveAgentId, "clinical-evidence-synthesis");
  assert.equal(JSON.parse(conversation.value).effectiveRuntimeAgent, "research");
  const preference = [...store.records.values()].find((record) => record.kind === "preference");
  assert.equal(preference.status, "active");
  assert.equal(preference.evidence[0].quote, text);
});

test("memory extraction rejects a plausible but unsupported model claim", async () => {
  const store = new MemoryStoreDouble();
  const intelligence = new MemoryIntelligence(config, store, {
    fetchImpl: modelFetch((sources) => [{
      scope: "user",
      kind: "profile",
      key: "profile.employer",
      value: "Works at a university hospital.",
      summary: "University hospital employee.",
      origin: "inferred",
      confidence: 0.9,
      importance: 0.7,
      sensitive: false,
      sourceRef: sources[0].sourceRef,
      evidenceQuote: "I work at a university hospital.",
    }]),
  });
  const result = await intelligence.recordRun(project(), run(), [message("user_1", "请分析这个研究方案。")]);
  assert.equal(result.extracted, 0);
  assert.equal([...store.records.values()].filter((record) => record.kind === "profile").length, 0);
  assert.equal([...store.records.values()].filter((record) => record.kind === "run_summary").length, 1);
});

test("inferred memory remains pending until enough exact observations in separate runs", async () => {
  const store = new MemoryStoreDouble();
  const intelligence = new MemoryIntelligence(config, store, {
    fetchImpl: modelFetch((sources) => [{
      scope: "user",
      kind: "behavior",
      key: "workflow.requests_reproducibility",
      value: "Frequently requests reproducible analysis outputs.",
      summary: "Prefers reproducible analysis workflows.",
      origin: "inferred",
      confidence: 0.7,
      importance: 0.7,
      sensitive: false,
      sourceRef: sources[0].sourceRef,
      evidenceQuote: sources[0].text,
    }]),
  });

  for (let index = 1; index <= 3; index += 1) {
    await intelligence.recordRun(project(), run(`run_${index}`, `2026-07-2${index}T01:01:00.000Z`), [
      message(`user_${index}`, `第${index}次：请保留分析脚本、参数和可复现步骤。`),
    ]);
    const behavior = [...store.records.values()].find((record) => record.kind === "behavior");
    assert.equal(behavior.status, index < MEMORY_PROMOTION_MIN_OCCURRENCES ? "pending" : "active");
  }
  const behavior = [...store.records.values()].find((record) => record.kind === "behavior");
  assert.equal(behavior.evidenceCount, MEMORY_PROMOTION_MIN_OCCURRENCES);
});

// Three observations that all came out of one conversation are one
// conversation repeating itself, and `evidenceCount >= 3` counted them as
// independence. `MEMORY_PROMOTION_MIN_RUNS` was declared in the domain and had
// no consumer anywhere, so nothing checked the second half of the rule.
test("three observations inside one run are not three independent ones", async () => {
  const store = new MemoryStoreDouble();
  // The same behavior proposed from three different messages of the same run:
  // three distinct evidence entries, one conversation.
  const intelligence = new MemoryIntelligence(config, store, {
    fetchImpl: modelFetch((sources) => sources.filter((source) => source.role === "user").map((source) => ({
      scope: "user",
      kind: "behavior",
      key: "workflow.requests_reproducibility",
      value: "Frequently requests reproducible analysis outputs.",
      summary: "Prefers reproducible analysis workflows.",
      origin: "inferred",
      confidence: 0.7,
      importance: 0.7,
      sensitive: false,
      sourceRef: source.sourceRef,
      evidenceQuote: source.text,
    }))),
  });

  const single = await intelligence.recordRun(project(), run("run_one_shot", "2026-07-22T02:00:00.000Z"), [
    message("u1", "请保留分析脚本。"),
    message("u2", "也请保留参数。"),
    message("u3", "还有可复现步骤。"),
  ]);
  const behavior = [...store.records.values()].find((record) => record.kind === "behavior");
  assert.equal(behavior.evidenceCount, MEMORY_PROMOTION_MIN_OCCURRENCES,
    "the occurrence count is met, which is exactly what used to be enough");
  assert.equal(behavior.status, "pending", "one run cannot promote itself however often it repeats");
  assert.equal(single.activated, 0);
  assert.ok(single.pendingReasons.some((item) => item.reason === "inferred"));

  // A second run says the same thing. Now the observations span
  // MEMORY_PROMOTION_MIN_RUNS runs and the promotion is earned.
  assert.equal(MEMORY_PROMOTION_MIN_RUNS, 2);
  const second = await intelligence.recordRun(project(), run("run_second", "2026-07-23T02:00:00.000Z"), [
    message("u4", "这次也请保留可复现步骤。"),
  ]);
  const promoted = [...store.records.values()].find((record) => record.kind === "behavior");
  assert.equal(promoted.status, "active");
  assert.equal(second.activated, 1);
  const reason = store.reasons.at(-1).reason;
  assert.match(reason, new RegExp(`${MEMORY_PROMOTION_MIN_OCCURRENCES} observations across at least ${MEMORY_PROMOTION_MIN_RUNS} runs`));
});

// A record parked as `pending` is not refused: it is stored with its evidence
// and simply not recalled until a person confirms it. Nothing said so, and
// `sensitivePattern` includes 病历号 and 患者姓名 — ordinary words in medical
// research text — so a researcher watched memory "not learn" with no reason
// anywhere. The demotion is deliberate and unchanged; what changes is that it
// now names itself, both to the run and in the record's own revision history.
test("a memory parked by the sensitive screen says why, and one that is not is untouched", async () => {
  const client = new MemoryStoreDouble();
  const messages = [
    message("u1", "请记住：这批分析统一按病历号去重，不要按姓名。"),
    message("u2", "请记住：随访窗口统一取 12 周。"),
  ];
  const intelligence = new MemoryIntelligence(config, client, {
    fetchImpl: modelFetch((sources) => [
      {
        scope: "project", kind: "analysis", key: "project.analysis.dedup_rule",
        value: "按病历号去重", summary: "去重口径", origin: "explicit",
        confidence: 1, importance: 0.8, sensitive: false,
        sourceRef: sources.find((source) => source.sourceRef.endsWith("u1")).sourceRef,
        evidenceQuote: "按病历号去重",
      },
      {
        scope: "project", kind: "analysis", key: "project.analysis.followup_window",
        value: "随访窗口取 12 周", summary: "随访窗口", origin: "explicit",
        confidence: 1, importance: 0.8, sensitive: false,
        sourceRef: sources.find((source) => source.sourceRef.endsWith("u2")).sourceRef,
        evidenceQuote: "随访窗口统一取 12 周",
      },
    ]),
  });

  const result = await intelligence.recordRun(project(), run("run_pending_reason"), messages);
  assert.equal(result.extracted, 2, "both candidates are stored; parking is not refusing");

  // Unchanged: which records are demoted. One matched the screen, one did not.
  const stored = await client.listRecords();
  const parked = stored.find((record) => record.key === "project.analysis.dedup_rule");
  const active = stored.find((record) => record.key === "project.analysis.followup_window");
  assert.equal(parked.status, "pending", "the sensitive-screen demotion still happens");
  assert.equal(active.status, "active", "a record the screen did not match is unaffected");

  // Added: the reason, to the caller that reports to the user...
  assert.equal(result.pending, 1);
  assert.deepEqual(result.pendingReasons.map((item) => [item.reason, item.count]), [["sensitive", 1]]);
  assert.match(result.pendingReasons[0].text, /敏感词表/);

  // ...and to the record's own audit trail, which is what a person opening the
  // memory later actually reads.
  const parkedReason = client.reasons.find((entry) => entry.key === "project.analysis.dedup_rule");
  assert.match(parkedReason.reason, /parked as pending: the text matched the sensitive-vocabulary screen/);
  const activeReason = client.reasons.find((entry) => entry.key === "project.analysis.followup_window");
  assert.doesNotMatch(activeReason.reason, /parked as pending/, "a record that was not parked says nothing about parking");
});

/**
 * The inbox, with the one behaviour a recorder would have hidden.
 *
 * The real `NotificationService.create` derives the row id from the idempotency
 * key and, when that key already names a row, returns it only if the content is
 * the same one — same project, notice type, title, body, actions and source —
 * and otherwise throws `notification_idempotency_conflict`. A double that only
 * appends cannot tell a key that dedups from a key that collides, which is how
 * a run-scoped `source` under a run-stable key passed its own test here and
 * would have thrown against the real service on every later observation.
 */
function notificationsDouble() {
  /** Every call the module made, including the ones that were refused. */
  const attempts = [];
  /** What the inbox would actually hold. */
  const rows = new Map();
  return {
    attempts,
    rows,
    async create(userId, input) {
      attempts.push({ userId, ...input });
      const semantics = JSON.stringify([
        userId, input.projectId ?? null, input.noticeType, input.title, input.body,
        input.actions ?? [], input.source ?? null,
      ]);
      const key = input.idempotencyKey == null ? `unkeyed:${rows.size}` : `${userId} ${input.idempotencyKey}`;
      const prior = rows.get(key);
      if (prior) {
        if (prior.semantics !== semantics) {
          /** @type {any} */
          const error = new Error("The notification key already names different content.");
          error.status = 409;
          error.code = "notification_idempotency_conflict";
          throw error;
        }
        return prior.item;
      }
      const item = { id: `notice_${rows.size + 1}`, ...input };
      rows.set(key, { semantics, item });
      return item;
    },
  };
}

/** Everything the composition root would have audited. */
function auditDouble() {
  const failures = [];
  return { failures, record: async (event, error) => { failures.push({ event, code: error?.code ?? null }); } };
}

/** A memory the user stated and the system has been using ever since. */
async function seedConfirmed(store, { key, value, origin = "explicit", kind = "preference" }) {
  return store.upsertRecord("user_1", {
    scope: "user", scopeId: "", kind, key, value, summary: value,
    origin, status: "active", confidence: 1, importance: 0.8, sensitive: false,
  }, null, {});
}

/** An extractor that proposes exactly one candidate under a key it was told about. */
function proposeValue(key, value, kind = "preference", origin = "explicit") {
  return modelFetch((sources) => [{
    scope: "user", kind, key, value, summary: value, origin,
    confidence: 1, importance: 0.8, sensitive: false,
    sourceRef: sources[0].sourceRef, evidenceQuote: sources[0].text,
  }]);
}

// The first version of this feature answered a contradiction by refusing the
// write: the confirmed record was left untouched and the new value was parked
// under a key of its own as `pending`. So a researcher who says "from now on
// answer in English" was answered in Chinese forever — the inbox action that
// would have applied their statement has no handler anywhere, and before the
// feature existed the same statement simply took effect. A check that refuses
// what used to succeed is a blocking point, and those are budgeted; this one
// was never justified by an observed distribution and is gone. What is left is
// the part that was worth having: the contradiction is detected, the value it
// replaced is kept, and the researcher is told.
test("a restated preference takes effect at once, and the memory it replaced is recorded rather than refused", async () => {
  const store = new MemoryStoreDouble();
  const notifications = notificationsDouble();
  const audit = auditDouble();
  const confirmed = await seedConfirmed(store, { key: "preference.output_language", value: "回答请用中文" });
  const intelligence = new MemoryIntelligence(config, store, {
    notifications,
    audit: audit.record,
    fetchImpl: proposeValue("preference.output_language", "回答请用英文"),
  });

  const result = await intelligence.recordRun(project(), run("run_conflict", "2026-07-24T01:01:00.000Z"), [
    message("u1", "回答请用英文"),
  ]);

  // The whole point: what the user just said is in force, under the key it
  // belongs to, immediately.
  const kept = [...store.records.values()].find((record) => record.key === "preference.output_language");
  assert.equal(kept.value, "回答请用英文", "the researcher's own restatement must take effect");
  assert.equal(kept.status, "active", "and take effect now, not after someone approves it");
  assert.equal(kept.version, confirmed.version + 1);
  assert.equal([...store.records.values()].filter((record) => record.key.includes(".proposed.")).length, 0,
    "a value the user stated is not a proposal");

  // The value it replaced, in the one place that outlives the write.
  const reason = store.reasons.find((entry) => entry.key === "preference.output_language" && /replaced/.test(entry.reason));
  assert.ok(reason, "the revision history must name the value that was replaced");
  assert.match(reason.reason, /replaced the value the user had confirmed: 「回答请用中文」/);

  // The verdict is a return value carrying the specifics.
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(
    {
      key: result.conflicts[0].key,
      previousValue: result.conflicts[0].previousValue,
      nextValue: result.conflicts[0].nextValue,
      origin: result.conflicts[0].origin,
    },
    { key: "preference.output_language", previousValue: "回答请用中文", nextValue: "回答请用英文", origin: "explicit" },
  );
  assert.equal(result.pending, 0, "nothing was parked");
  assert.equal(result.pendingReasons.length, 0);

  // And the researcher is told, with both values, by a notice that does not ask
  // them to do anything: the change has already happened.
  assert.equal(notifications.rows.size, 1);
  const notice = notifications.attempts[0];
  assert.equal(notice.noticeType, "notify", "a question would promise a decision nothing acts on");
  assert.equal(notice.actions, undefined, "an inbox action with no handler is a button that does nothing");
  assert.equal(notice.userId, "user_1");
  assert.match(notice.body, /回答请用中文/);
  assert.match(notice.body, /回答请用英文/);
  assert.match(notice.body, /记忆管理/, "the way back has to be in the notice");
  assert.equal(audit.failures.length, 0);
});

test("case and spacing are not a change of mind, and an unconfirmed guess is corrected in silence", async () => {
  // The narrowness is the point. Code decides only that two strings differ once
  // normalized; whether two statements contradict each other is a language
  // judgement, and this must not start making it.
  const cosmetic = new MemoryStoreDouble();
  const cosmeticInbox = notificationsDouble();
  await seedConfirmed(cosmetic, { key: "preference.evidence_depth", value: "Prefer primary evidence" });
  const unchanged = await new MemoryIntelligence(config, cosmetic, {
    notifications: cosmeticInbox,
    fetchImpl: proposeValue("preference.evidence_depth", "prefer  primary   evidence"),
  }).recordRun(project(), run("run_cosmetic", "2026-07-26T01:01:00.000Z"), [message("u1", "prefer  primary   evidence")]);
  assert.equal(cosmeticInbox.attempts.length, 0, "whitespace and case are not a contradiction");
  assert.equal(unchanged.conflicts.length, 0);

  // An active memory the model inferred and the user never confirmed is not
  // "what the user told the system": correcting it is how inference is supposed
  // to work, and a notice about it would be noise.
  const inferred = new MemoryStoreDouble();
  const inferredInbox = notificationsDouble();
  await seedConfirmed(inferred, { key: "preference.output_language", value: "回答请用中文", origin: "inferred" });
  const corrected = await new MemoryIntelligence(config, inferred, {
    notifications: inferredInbox,
    fetchImpl: proposeValue("preference.output_language", "回答请用英文"),
  }).recordRun(project(), run("run_inferred", "2026-07-27T01:01:00.000Z"), [message("u1", "回答请用英文")]);
  assert.equal(inferredInbox.attempts.length, 0);
  assert.equal(corrected.conflicts.length, 0);
  assert.equal([...inferred.records.values()].find((record) => record.key === "preference.output_language").value, "回答请用英文");

  // An episodic project fact is outside the boundary too: those legitimately
  // change, and telling the researcher every time one does is exactly the noise
  // a budget of six blocking points exists to prevent.
  const episodic = new MemoryStoreDouble();
  const episodicInbox = notificationsDouble();
  await episodic.upsertRecord("user_1", {
    scope: "project", scopeId: "project_1", kind: "analysis", key: "project.analysis.followup_window",
    value: "随访窗口取 12 周", summary: "随访窗口", origin: "explicit", status: "active",
    confidence: 1, importance: 0.8, sensitive: false,
  }, null, {});
  await new MemoryIntelligence(config, episodic, {
    notifications: episodicInbox,
    fetchImpl: modelFetch((sources) => [{
      scope: "project", kind: "analysis", key: "project.analysis.followup_window",
      value: "随访窗口取 24 周", summary: "随访窗口", origin: "explicit",
      confidence: 1, importance: 0.8, sensitive: false,
      sourceRef: sources[0].sourceRef, evidenceQuote: sources[0].text,
    }]),
  }).recordRun(project(), run("run_episodic", "2026-07-28T01:01:00.000Z"), [message("u1", "随访窗口取 24 周")]);
  assert.equal(episodicInbox.attempts.length, 0);
  assert.equal([...episodic.records.values()].find((record) => record.key === "project.analysis.followup_window").value, "随访窗口取 24 周");
});

test("the notice's key names exactly what the notice says, so observing one change twice is one inbox item", async () => {
  // Against the real service the identity of an inbox item is its key AND its
  // content: a repeated key whose content differs is a 409, not a duplicate.
  // The first version keyed on the record while sending the run as the notice's
  // source, so the second observation of one contradiction took the 409 branch
  // and was swallowed by a bare `catch`. Nothing about the run reaches this
  // notice now, and the double above enforces the rule the service enforces.
  const store = new MemoryStoreDouble();
  const notifications = notificationsDouble();
  const audit = auditDouble();
  await seedConfirmed(store, { key: "preference.output_language", value: "回答请用中文" });
  const say = (value, id, at) => new MemoryIntelligence(config, store, {
    notifications,
    audit: audit.record,
    fetchImpl: proposeValue("preference.output_language", value),
  }).recordRun(project(), run(id, at), [message(`m_${id}`, value)]);

  await say("回答请用英文", "run_first", "2026-07-24T01:01:00.000Z");
  await say("回答请用中文", "run_second", "2026-07-25T01:01:00.000Z");
  // The researcher changes their mind back: the same contradiction as the first
  // one, observed in a different run and reported from a different project.
  const third = await new MemoryIntelligence(config, store, {
    notifications,
    audit: audit.record,
    fetchImpl: proposeValue("preference.output_language", "回答请用英文"),
  }).recordRun({ id: "project_2", userId: "user_1" }, run("run_third", "2026-07-26T01:01:00.000Z"),
    [message("m_third", "回答请用英文")]);

  assert.equal(third.conflicts.length, 1);
  assert.equal(notifications.attempts.length, 3, "each observation reported");
  assert.equal(notifications.rows.size, 2, "but the same change twice is one inbox item, not a 409");
  assert.deepEqual(audit.failures, [], "and nothing was swallowed");
  assert.equal(notifications.attempts[0].idempotencyKey, notifications.attempts[2].idempotencyKey);
  assert.notEqual(notifications.attempts[0].idempotencyKey, notifications.attempts[1].idempotencyKey);
  for (const attempt of notifications.attempts) {
    assert.equal(attempt.source, undefined, "a run-scoped source under a run-stable key is the 409");
    assert.equal(attempt.projectId, null, "a user-scoped memory belongs to no project");
  }
});

test("a change the model inferred is a different notice from the same change the user stated", async () => {
  // The notice names which of the two it was, so the key has to as well: a key
  // that does not distinguish what its own text distinguishes is exactly the
  // idempotency conflict, one turn later.
  const store = new MemoryStoreDouble();
  const notifications = notificationsDouble();
  const audit = auditDouble();
  await seedConfirmed(store, { key: "preference.output_language", value: "回答请用中文" });
  const say = (value, origin, id, at) => new MemoryIntelligence(config, store, {
    notifications,
    audit: audit.record,
    fetchImpl: proposeValue("preference.output_language", value, "preference", origin),
  }).recordRun(project(), run(id, at), [message(`m_${id}`, value)]);

  await say("回答请用英文", "explicit", "run_said", "2026-08-02T01:01:00.000Z");
  await say("回答请用中文", "explicit", "run_back", "2026-08-03T01:01:00.000Z");
  await say("回答请用英文", "inferred", "run_guessed", "2026-08-04T01:01:00.000Z");

  assert.equal(notifications.rows.size, 3);
  assert.deepEqual(audit.failures, []);
  assert.match(notifications.attempts[0].body, /你在本次对话里的说法/);
  assert.match(notifications.attempts.at(-1).body, /模型对本次对话的推断/);
});

test("an inbox that refuses the notice costs the run neither its memory nor its visibility", async () => {
  const store = new MemoryStoreDouble();
  const audit = auditDouble();
  await seedConfirmed(store, { key: "behavior.reporting_style", value: "报告先给结论", kind: "behavior" });
  const refusing = { create: async () => {
    /** @type {any} */
    const error = new Error("inbox is down");
    error.code = "notification_unavailable";
    throw error;
  } };
  const result = await new MemoryIntelligence(config, store, {
    notifications: refusing,
    audit: audit.record,
    // The model's own guess, over something the user confirmed. It still lands,
    // exactly as it did before this feature existed — and it is the one case a
    // future decision to hold such a write back could be argued from, which is
    // why the notice names it as inferred.
    fetchImpl: proposeValue("behavior.reporting_style", "报告先给方法", "behavior", "inferred"),
  }).recordRun(project(), run("run_inbox_down", "2026-08-01T01:01:00.000Z"), [message("u1", "报告先给方法")]);

  assert.equal([...store.records.values()].find((record) => record.key === "behavior.reporting_style").value, "报告先给方法");
  assert.equal(result.conflicts.length, 1, "the run still reports the change it made");
  assert.equal(result.conflicts[0].origin, "inferred");
  assert.deepEqual(audit.failures, [{ event: "notification.memory_conflict.create", code: "notification_unavailable" }],
    "an inbox that stopped accepting these must not be invisible");
});

test("the promotion rule reads the domain's numbers instead of restating them", async () => {
  // `MEMORY_PROMOTION_MIN_OCCURRENCES` and `MEMORY_PROMOTION_MIN_RUNS` were
  // declared in `@evimed/domain` and consumed by nothing outside the domain's
  // own index and tests, while this module hard-coded `evidenceCount >= 3` and
  // never looked at runs at all. The behaviour is pinned by the tests above;
  // this pins where the numbers come from, because a copy that happens to agree
  // today is the shape the whole domain package exists to prevent.
  const source = await readFile(new URL("../src/memoryIntelligence.mjs", import.meta.url), "utf8");
  assert.ok(source.length > 1_000, "the module source must actually have been read");
  assert.match(source, /import \{[^}]*MEMORY_PROMOTION_MIN_OCCURRENCES[^}]*\} from "@evimed\/domain"/s);
  assert.match(source, /stored\.evidenceCount >= MEMORY_PROMOTION_MIN_OCCURRENCES/);
  assert.match(source, /distinctObservationRuns\(stored\) >= MEMORY_PROMOTION_MIN_RUNS/);
  assert.doesNotMatch(source, /evidenceCount >= \d/, "the literal the constants replaced must be gone");
});

// ---------------------------------------------------------------------------
// Whose words these are.
//
// `injectContext` makes a plugin's text a first-class `user/message`, so the
// brief, the capsule profile and the agenda arrive in the slot the person types
// into. Reading the slot instead of the sender let the capsule's own rendering
// of the user's preferences come back as a fresh observation of those same
// preferences on every run that mounted it — three runs, three "independent"
// observations, and an inferred guess activates itself.
// ---------------------------------------------------------------------------

test("the sender decides what the user said, and the recorded wire has four of them", async () => {
  // Driven through the real normalizer and the real ledger projection, from
  // frames recorded off the live wire — not a hand-written shape. The fixture
  // carries `plugin` and `skill-catalog` beside `user` in the same slot, and
  // `skill-catalog` is a kind the domain's own union does not list, which is
  // exactly why this is an allow-list.
  const { normalizeTranscript, transcriptToLedgerMessages } = await import("../src/dshRuntimeAdapter.mjs");
  const frames = JSON.parse(await readFile(new URL("./fixtures/dsh/native-turn-frames.json", import.meta.url), "utf8"));
  const kinds = new Set(frames.events
    .filter((event) => event.type === "user/message")
    .map((event) => event.data.source.kind));
  assert.deepEqual([...kinds].sort(), ["plugin", "skill-catalog", "user"],
    "the fixture must keep carrying more than one sender, or this test proves nothing");

  const ledger = transcriptToLedgerMessages(normalizeTranscript("session_1", frames.events.map((event) => ({ event }))));
  const { sources, excluded } = conversationMemorySources(ledger, "session_1");
  const userTexts = sources.filter((source) => source.role === "user").map((source) => source.text);
  assert.ok(userTexts.length > 0, "the person's own questions must survive the filter");
  for (const text of userTexts) {
    assert.doesNotMatch(text, /Synthetic injected context/, "injected context reached the extractor as user speech");
  }
  assert.equal(excluded.find((item) => item.reason === "injected")?.count, 2,
    "both machine senders are refused, and the refusal is counted rather than silent");
});

test("an unfinished turn is not a fact, and a turn with no recorded ending still is", () => {
  const aborted = [
    { info: { id: "u1", role: "user", source: "user", turnStartSeq: 1 }, parts: [{ type: "text", text: "只看随机对照试验。" }] },
    { info: { id: "a1", role: "assistant", turnStartSeq: 1, turnEnd: { kind: "aborted" } }, parts: [{ type: "text", text: "我认为——" }] },
  ];
  assert.deepEqual(conversationMemorySources(aborted, "s").sources, [],
    "a turn the kernel cut short describes nothing durable");
  assert.deepEqual(conversationMemorySources(aborted, "s").excluded, [{ reason: "unfinished", count: 2 }]);

  const interrupted = [
    { info: { id: "a1", role: "assistant", error: { name: "interrupted" } }, parts: [{ type: "text", text: "我认为——" }] },
  ];
  assert.deepEqual(conversationMemorySources(interrupted, "s").sources, []);

  // No ending recorded at all is not the same claim as "ended badly". A rule
  // that needed the metadata to be present in order to allow anything would
  // stop the memory service learning the day a field went missing, silently.
  const legacy = [
    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "只看随机对照试验。" }] },
    { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "好的。" }] },
  ];
  assert.equal(conversationMemorySources(legacy, "s").sources.length, 2, "a transcript with no provenance still learns");
  assert.deepEqual(conversationMemorySources(legacy, "s").excluded, []);

  const completed = [
    { info: { id: "u1", role: "user", source: "user", turnStartSeq: 1 }, parts: [{ type: "text", text: "只看随机对照试验。" }] },
    { info: { id: "a1", role: "assistant", turnStartSeq: 1, turnEnd: { kind: "completed" } }, parts: [{ type: "text", text: "好的。" }] },
  ];
  assert.equal(conversationMemorySources(completed, "s").sources.length, 2);
});

test("the capsule's own profile cannot re-enter as an observation of itself", async () => {
  // The end-to-end shape of the echo. The extractor here promotes whatever it
  // is shown, so a stored record means the injected text reached it.
  const client = new MemoryStoreDouble();
  const capsuleProfile = "<evimed-capsule>\n用户偏好：只看随机对照试验，不看观察性研究。\n</evimed-capsule>";
  const messages = [
    { info: { id: "p1", role: "user", source: "plugin" }, parts: [{ type: "text", text: capsuleProfile }] },
    { info: { id: "u1", role: "user", source: "user" }, parts: [{ type: "text", text: "帮我查一下二甲双胍的证据。" }] },
    { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "已检索。" }] },
  ];
  let sourcesSeen = null;
  const intelligence = new MemoryIntelligence(config, client, {
    fetchImpl: async (_input, init) => {
      sourcesSeen = JSON.parse(JSON.parse(String(init.body)).messages[1].content).sources;
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        candidates: sourcesSeen.map((source, index) => ({
          scope: "user", kind: "preference", key: `user.preference.echo_${index}`,
          value: source.text.slice(0, 200), summary: source.text.slice(0, 120),
          origin: "inferred", confidence: 0.9, importance: 0.6, sensitive: false,
          sourceRef: source.sourceRef, evidenceQuote: source.text.slice(0, 60),
        })),
      }) } }] });
    },
  });

  const result = await intelligence.recordRun(project(), run("run_echo"), messages);
  for (const source of sourcesSeen) {
    assert.doesNotMatch(source.text, /evimed-capsule/, "the extractor was shown its own injection");
  }
  const stored = await client.listRecords();
  for (const record of stored) {
    assert.doesNotMatch(String(record.value), /随机对照试验/,
      "a preference the capsule injected became a new observation of that preference");
  }
  assert.deepEqual(result.excluded, [{ reason: "injected", count: 1 }],
    "and the run says how much of its own transcript it refused to read");
});

test("what the extractor refused reaches the run's audit line and its quality notice", async () => {
  const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  // `conversationMemorySources` returns its refusals instead of dropping them.
  // This is the assertion that somebody reads them: without a reader, "twenty
  // messages and nothing extracted" collapses back into the one number that
  // cannot tell an empty conversation from a transcript that was mostly our
  // own injection.
  assert.match(serverSource, /excluded=\$\{memoryResult\.excluded\.map\(/, "the refusals do not reach the audit ledger");
  assert.match(serverSource, /未读取 \$\{memoryResult\.excluded\.map\(/, "the refusals do not reach the zero-extraction notice");
});
