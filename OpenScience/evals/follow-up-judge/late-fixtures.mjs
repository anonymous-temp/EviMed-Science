// Deterministic transport/storage fixtures; judge semantics are supplied by each caller.
import { cleanLearningEvidence, learningRunOutcome } from '@evimed/domain';
import { LearningEvidence } from '../../apps/server/src/learningEvidence.mjs';

export const LATE_NOW = Date.UTC(2026, 10, 17, 12);
export const DELIVERY = { path: 'report/final.md', sha256: 'a'.repeat(64) };
export function lateFixture({ age = 1_801_000, enabled = true, answer = null, refusal = null, extraRuns = [], files = [DELIVERY], currentFiles = files, previousRequest = 'Write the report', sessionId = 'session', requestId = 'human-turn' } = {}) {
  const project = { id: 'project', userId: 'owner', workspaceDir: '/nonexistent' };
  const run = { id: 'previous', sessionId: 'session', status: 'succeeded', question: previousRequest,
    effectiveAgentId: 'open-domain-answer', automated: false, transcript: { completeness: 'complete' },
    outputFiles: files.map(file => file.path), startedAt: new Date(LATE_NOW - age - 60_000).toISOString(), finishedAt: new Date(LATE_NOW - age).toISOString() };
  const rows = [], calls = [], queued = [], funnel = [];
  const feedback = {
    async recordLearningEvidence(userId, { runId, projectId, key, detail }) {
      const clean = cleanLearningEvidence(detail);
      if (!clean) throw new Error('Invalid evidence');
      const id = `${userId}:${runId}:${clean.evidence}:${key}`;
      const held = rows.find(row => row.id === id);
      if (held) return { event: held, created: false };
      const event = { id, userId, runId, projectId, trigger: 'learning-evidence', detail: clean, occurredAt: clean.at };
      rows.push(event); return { event, created: true };
    },
    async learningEvidenceOf(_owner, id) { return rows.filter(row => row.runId === id); },
    async cleanSettledRuns() { return rows.filter(row => row.detail.shape && learningRunOutcome(rows.filter(other => other.runId === row.runId).map(other => other.detail)) === 'clean')
      .map(row => ({ runId: row.runId, projectId: row.projectId, shape: row.detail.shape, at: row.detail.at })); },
  };
  let now = LATE_NOW;
  const triggers = { refusalFor: async () => refusal, resetInstantOf: async () => null, guestInfluenced: async () => false,
    queue: async (_project, _run, lesson) => { queued.push(lesson); return true; },
    afterCorrection: async () => ({ queued: ['correction'] }), afterAdoption: async () => { throw new Error('Late adoption is forbidden'); } };
  const evidence = new LearningEvidence({ feedback, jobs: { enqueue: async () => {}, bringForward: async () => false },
    agentRuns: { list: async () => [run, ...extraRuns] }, triggers, lateFollowUpEnabled: enabled,
    readDeliveryBindings: async () => now < LATE_NOW ? files : currentFiles,
    judge: { available: true, read: async request => { calls.push(request); return typeof answer === 'function' ? answer(request) : answer; } },
    readShapes: async () => Object.fromEntries(files.map(file => [file.path, { format: 'md', labels: ['summary', 'findings'] }])),
    resolveProject: async () => project, funnel: event => funnel.push(event), now: () => new Date(now) });
  return { project, run, rows, calls, queued, funnel, evidence, feedback,
    async snapshot() { now = Date.parse(run.finishedAt); await evidence.afterRun(project, run); now = LATE_NOW; },
    turn(text, overrides = {}) { return evidence.onNewTurn(project, { sessionId, requestId, text, ...overrides }); },
    outcome() { return learningRunOutcome(rows.filter(row => row.runId === run.id).map(row => row.detail)); } };
}
export const boundAcceptance = (message, delivery = DELIVERY) => JSON.stringify({ verdict: 'accept', quote: message, relation: 'convert', artifact: delivery });
