// Content-free, bounded diagnostics. These observations never grant learning authority.
import { createHash } from 'node:crypto';
export const LEARNING_FUNNEL_REASONS = Object.freeze([
  'no_deliverable', 'outside_window', 'run_in_between', 'judge_unavailable', 'judge_failed', 'judge_unreadable', 'busy',
  'judge_over_budget', 'admission_refused', 'fewer_than_three_clean', 'routine_not_due', 'transcript_incomplete', 'source_not_reusable',
  'unknown', 'corrected', 'clean', 'routine_queued', 'binding_unavailable', 'binding_changed', 'already_followed_up', 'late_disabled',
  'paused', 'before_reset', 'clinical_context', 'not_researcher_work', 'internal_project', 'internal_agent', 'trial', 'shared_automated',
  'not_finished', 'run_unavailable', 'not_eligible', 'input_unbound', 'quote_not_found', 'rule_unsafe', 'sensitive', 'record_failed', 'settle_failed', 'no_shape', 'enqueue_failed',
]);
export const funnelHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
