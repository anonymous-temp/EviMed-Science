import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { VcrForecastComparisonResult } from './VcrForecastComparisonResult';
import type { LongitudinalRecord } from '@/lib/vcrLongitudinalClient';

it('draws the older version, the newer version and what was observed afterwards, for the same people', () => {
  const record: LongitudinalRecord = { id: 'c', kind: 'comparison', createdAt: '2026-02-01', hash: 'h', summary: { mode: 'update', available: true, groups: [],
    endpoint: { code: 'HbA1c', unit: '%', type: 'continuous' },
    observed: { available: true, groups: [{ horizonDays: 30, targetAt: '2026-01-31T00:00:00.000Z', observed: 2, olderError: .7, newerError: .15, newerCloser: 2, olderCloser: 0, errorMetric: 'mae' }] } } };
  render(<VcrForecastComparisonResult record={record} />);
  const table = screen.getByRole('table', { name: '旧预测、新预测与随后的实际观测' });
  expect(table).toHaveTextContent('2026-01-31');
  expect(table).toHaveTextContent('0.7');
  expect(table).toHaveTextContent('0.15');
  expect(screen.getByText(/实际观测发生在新版本的预测起点之后/)).toBeInTheDocument();
});
