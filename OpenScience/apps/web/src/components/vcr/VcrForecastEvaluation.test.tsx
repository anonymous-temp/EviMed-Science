import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { LongitudinalRecord } from '@/lib/vcrLongitudinalClient';
import { REPLAY_ACCURACY_NOTE, VcrForecastEvaluation } from './VcrForecastEvaluation';

/** A replay's accuracy is never read as the accuracy of a forecast that could have been made at the origin. */
const evaluation = (actionContext?: { mode: string; actionSource: string; deployable: boolean; label: string }): LongitudinalRecord => ({ id: 'ev', kind: 'evaluation', createdAt: '2026-01-02', hash: 'h',
  summary: { groups: [], ...(actionContext ? { actionContext } : {}) } as LongitudinalRecord['summary'] });

it('says an evaluation of logged-action replay is not forecast accuracy', () => {
  render(<VcrForecastEvaluation record={evaluation({ mode: 'conditional_forecast', actionSource: 'logged_replay', deployable: false, label: 'logged_action_replay' })} />);
  expect(screen.getByText(REPLAY_ACCURACY_NOTE)).toBeInTheDocument();
});

it('says nothing extra for a forecast that was deployable at the origin or has no action context', () => {
  const { container, rerender } = render(<VcrForecastEvaluation record={evaluation({ mode: 'factual_forecast', actionSource: 'none', deployable: true, label: 'factual_forecast' })} />);
  expect(container.querySelector('[data-vcr-replay-note]')).toBeNull();
  rerender(<VcrForecastEvaluation record={evaluation()} />);
  expect(container.querySelector('[data-vcr-replay-note]')).toBeNull();
});
