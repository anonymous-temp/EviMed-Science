import assert from "node:assert/strict";
import test from "node:test";
import { MemoryIntelligence } from "../src/memoryIntelligence.mjs";

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

function run(id = "run_1") {
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
    finishedAt: "2026-07-22T01:01:00.000Z",
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

test("inferred memory remains pending until three independent exact observations", async () => {
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
    await intelligence.recordRun(project(), run(`run_${index}`), [
      message(`user_${index}`, `第${index}次：请保留分析脚本、参数和可复现步骤。`),
    ]);
    const behavior = [...store.records.values()].find((record) => record.kind === "behavior");
    assert.equal(behavior.status, index < 3 ? "pending" : "active");
  }
  const behavior = [...store.records.values()].find((record) => record.kind === "behavior");
  assert.equal(behavior.evidenceCount, 3);
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
