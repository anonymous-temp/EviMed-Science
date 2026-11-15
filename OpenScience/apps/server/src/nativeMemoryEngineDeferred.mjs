import { createHash } from 'node:crypto';
import { filterCapturedMessage } from './memoryGateway.mjs';
import { recordTurnCommit } from './nativeMemoryMetrics.mjs';
import { endedBeforeReset } from './memorySettings.mjs';
import { parseArchiveUri, platformSessionOf } from './openVikingSessions.mjs';

const MAX_WAIT_MS = 30 * 60_000;
/** @typedef {{ id: string, userId: string, projectCreatedAt?: string | null, createdAt?: string }} Project */
/** @typedef {{ id: string, startedAt: string, finishedAt: string }} Turn */
/** @typedef {{ role: string, source: string, time: number, parts: readonly unknown[] }} Message */

/** Durable startup obligations hold only a turn reference. Original text stays in the kernel's transcript.
 * Existing failed -> replayed/abandoned commit states and the worker own retries and account/source erasure.
 * The URI is a ledger key under the original source session, explicitly outside history archives. */
export class NativeMemoryEngineDeferred {
  /** @param {{ config: { memoryHistorySecretRedactionEnabled?: boolean, memoryEnabled?: boolean, memoryEngineEnabled?: boolean },
   * overlay: import('./nativeMemoryOverlay.mjs').NativeMemoryOverlay,
   * sessions: import('./openVikingSessions.mjs').OpenVikingSessions,
   * admission: ReturnType<typeof import('./memoryAdmission.mjs').createMemoryAdmission>,
   * memorySettings: { accountExists: (id: string) => Promise<boolean>, resetInstant: (id: string) => Promise<string | null> },
   * commit: import('./memoryGateway.mjs').MemoryGatewayCommitSession,
   * project: (userId: string, projectId: string) => Promise<Project | null>,
   * transcript: (project: Project, sessionId: string) => Promise<{ exhausted?: boolean, messages: readonly Message[] }>,
   * memoryContexts?: import('./geoNativeMemoryContext.mjs').GeoNativeMemoryContext | null, now?: () => Date }} dependencies */
  constructor({ config, overlay, sessions, admission, memorySettings, commit, project, transcript, memoryContexts = null, now = () => new Date() }) {
    this.config = config;
    this.overlay = overlay;
    this.sessions = sessions;
    this.admission = admission;
    this.memorySettings = memorySettings;
    this.commit = commit;
    this.project = project;
    this.transcript = transcript;
    this.memoryContexts = memoryContexts;
    this.now = now;
  }

  /** @param {string} uri */
  key(uri) { return createHash('sha256').update(uri).digest('hex').slice(0, 32); }

  /** @param {{userId: string, project: Project, sessionId: string, engineSessionId: string, run: Turn,
   * context?: unknown}} entry */
  async defer(entry) {
    const { userId, project, sessionId, engineSessionId, run } = entry;
    if (!Number.isFinite(Date.parse(run.startedAt)) || !Number.isFinite(Date.parse(run.finishedAt))) return false;
    const decision = await this.admission.admit({ user: { id: userId }, project, engineSessionId, at: Date.parse(run.startedAt) });
    // Readiness can recover between the end-of-turn decision and this durable write.
    if (!decision.learn && decision.learnReason !== 'engine_unavailable') return false;
    const context = this.memoryContexts ? await this.memoryContexts.forProject(project) : null;
    if (context) await this.memoryContexts?.assertLive(context);
    if (context?.kind === 'geo-project' && !await this.memoryContexts?.noteCapture(context, engineSessionId)) return false;
    const view = context?.sessions ?? this.sessions;
    const archiveUri = `${view.sessionUri(userId, engineSessionId)}/deferred/${this.key(run.id)}`;
    const saved = await this.overlay.recordCommit({ userId, archiveUri, engineSession: engineSessionId, projectId: project.id,
      ...(context?.projectCreatedAt ?? project.projectCreatedAt ? { projectCreatedAt: context?.projectCreatedAt ?? project.projectCreatedAt } : {}),
      origin: 'gateway', state: 'failed', error: 'engine_unavailable',
      extraction: { engineDeferred: { runId: run.id, sessionId, startedAt: run.startedAt, finishedAt: run.finishedAt } } });
    if (saved.inserted) recordTurnCommit('engine_deferred');
    return true;
  }

  /** One due worker obligation; no new model call until all original admission checks pass again.
   * @param {{userId: string, archiveUri: string}} queued */
  async process(queued) {
    const held = await this.overlay.commit(queued.userId, queued.archiveUri);
    if (!held || held.state !== 'failed' || !held.extraction.engineDeferred) return false;
    const turn = held.extraction.engineDeferred;
    const giveUp = async (/** @type {string} */ reason) => {
      await this.overlay.abandonCommit(held.userId, held.archiveUri, reason);
      recordTurnCommit('engine_given_up');
      return true;
    };
    const startedAt = Date.parse(turn.startedAt), finishedAt = Date.parse(turn.finishedAt);
    if (turn.sessionId !== platformSessionOf(held.engineSession) || !Number.isFinite(startedAt)
      || !Number.isFinite(finishedAt) || startedAt > finishedAt) return giveUp('invalid_deferred_turn');
    if (this.config.memoryEnabled === false || this.config.memoryEngineEnabled === false) return giveUp('memory_off');
    if (this.now().getTime() - Date.parse(held.createdAt) >= MAX_WAIT_MS) return giveUp('engine_startup_wait_expired');
    if (!await this.memorySettings.accountExists(held.userId)) return giveUp('account_deleted');
    const project = held.projectId ? await this.project(held.userId, held.projectId) : null;
    if (!project || project.userId !== held.userId) return giveUp('source_project_deleted');
    // An id reused after project deletion is a different authority.
    const epoch = project.projectCreatedAt ?? project.createdAt;
    if (held.projectCreatedAt && (!epoch || Date.parse(epoch) !== Date.parse(held.projectCreatedAt))) return giveUp('source_project_changed');
    const resetAt = await this.memorySettings.resetInstant(held.userId);
    if (endedBeforeReset({ finishedAt: turn.finishedAt }, resetAt)) return giveUp('before_reset');
    const admit = () => this.admission.admit({ user: { id: held.userId }, project, engineSessionId: held.engineSession, at: Date.parse(turn.startedAt) });
    const decision = await admit();
    if (!decision.learn) {
      if (decision.learnReason !== 'engine_unavailable') return giveUp(decision.learnReason ?? 'not_learning');
      await this.overlay.noteReplayAttempt(held.userId, held.archiveUri, { nextAttemptAt: new Date(this.now().getTime() + 15_000) });
      return false;
    }
    const context = this.memoryContexts ? await this.memoryContexts.forProject(project) : null;
    if (context) await this.memoryContexts?.assertLive(context);
    const view = context?.sessions ?? this.sessions;
    if (!held.archiveUri.startsWith(`${view.sessionUri(held.userId, held.engineSession)}/deferred/`)) return giveUp('source_namespace_changed');
    if (context?.kind === 'geo-project' && !await this.memoryContexts?.noteCapture(context, held.engineSession)) return giveUp('unproven_session');
    const transcript = await this.transcript(project, turn.sessionId);
    if (transcript.exhausted !== true) throw new Error('Deferred memory requires the complete original transcript.');
    /** @type {Array<{ role: string, parts: { type: string, text: string }[], created_at?: string }>} */
    const messages = [];
    for (const message of transcript.messages) {
      if (message.time < Date.parse(turn.startedAt) || message.time > Date.parse(turn.finishedAt) || !Number.isFinite(message.time)) continue;
      if (message.role !== 'assistant' && !(message.role === 'user' && message.source === 'user')) continue;
      const captured = filterCapturedMessage({ role: message.role, parts: message.parts, created_at: new Date(message.time).toISOString() },
        { researchGoal: decision.researchGoal === true, semanticSecrets: this.config.memoryHistorySecretRedactionEnabled === true });
      if ('forward' in captured) messages.push(captured.forward);
    }
    if (!messages.length) return giveUp('nothing_to_learn');
    const sessionId = `evimed-replay-${this.key(held.archiveUri)}`;
    if (context?.kind === 'geo-project') {
      await this.memoryContexts?.configure(context);
      // This is the transcript's first materialization: use a current-project operation binding, not a nonexistent engine archive.
      await this.memoryContexts?.noteInternal(context, sessionId, { kind: 'page', operationRef: `engine-startup:${this.key(held.archiveUri)}` });
    }
    if (!(await admit()).learn) return false;
    await view.createSession(held.userId, sessionId);
    const state = (await view.readSession(held.userId, sessionId))?.result ?? {};
    // A crash after the engine accepted commit is reconciled before any message is resent.
    let result;
    if (Number(state.commit_count) > 0) {
      result = { archive_uri: `${view.sessionUri(held.userId, sessionId)}/history/archive_001` };
    } else {
      for (const message of messages.slice(Math.max(0, Number(state.message_count) || 0))) {
        if (this.now().getTime() - Date.parse(held.createdAt) >= MAX_WAIT_MS) return giveUp('engine_startup_wait_expired');
        if (!(await admit()).learn) return false;
        await view.addMessage(held.userId, sessionId, message);
      }
      if (this.now().getTime() - Date.parse(held.createdAt) >= MAX_WAIT_MS) return giveUp('engine_startup_wait_expired');
      const finalAdmission = await admit();
      if (!finalAdmission.learn) return false;
      const answer = await this.commit({ user: { id: held.userId }, project, engineSessionId: sessionId, sourceEngineSessionId: held.engineSession, admitted: finalAdmission, context });
      if (answer.commit !== 'accepted') return false;
      result = answer.json?.result;
    }
    const archive = parseArchiveUri(result?.archive_uri);
    if (!archive || archive.userRoot !== view.userRoot(held.userId) || archive.session !== sessionId || archive.rest) throw new Error('Deferred commit archive does not match its namespace.');
    await this.overlay.recordCommit({ userId: held.userId, archiveUri: archive.archiveUri, engineSession: sessionId,
      projectId: held.projectId, projectCreatedAt: held.projectCreatedAt, origin: 'gateway',
      taskId: typeof result?.task_id === 'string' ? result.task_id : null });
    await this.overlay.markReplayed(held.userId, held.archiveUri, archive.archiveUri);
    recordTurnCommit('engine_committed');
    return true;
  }
}
