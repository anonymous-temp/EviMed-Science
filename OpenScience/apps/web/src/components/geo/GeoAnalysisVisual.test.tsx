import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { GeoAnalysisVisual } from './GeoAnalysisVisual';
import type { GeoAnalysisView, GeoAnalysisChartCell } from '@/lib/geoAnalysisClient';
const cell = (groupId: string, engine: string, value: number | null, state = 'known'): GeoAnalysisChartCell => ({ rowKey: `${groupId}-${engine}`, columnKey: 'current', label: `品牌提及率 · Same · 问题版本 1 · ${engine}`, groupId, setVersion: 1, engine, value, state });
it('renders exact same-named group identities and unknown cells without replacing null with zero', () => {
  const cells = [cell('g1', 'deepseek', 0), cell('g1', 'kimi', 100), cell('g2', 'deepseek', 100), cell('g2', 'kimi', null, 'unknown')];
  render(<GeoAnalysisVisual data={{ chart: { kind: 'matrix', labels: [], series: [], cells } } as unknown as GeoAnalysisView} onSelect={() => { }}/>);
  expect(screen.getByRole('table', { name: '问题群与平台交叉实测' })).toBeTruthy();
  expect(screen.getAllByText(/Same.*组/)).toHaveLength(2);
  expect(screen.getByText('未测')).toBeTruthy();
  expect(screen.getByText('0')).toBeTruthy();
});
it('platform bars retain full-data cell member context beyond the table page', () => {
  const chosen = vi.fn(), cells = [cell('g1', 'deepseek', 0), cell('g1', 'kimi', 100)];
  render(<GeoAnalysisVisual data={{ view: { viewId: 'V04' }, chart: { kind: 'bars', labels: [], series: [], cells } } as unknown as GeoAnalysisView} onSelect={chosen}/>);
  fireEvent.click(screen.getByRole('button', { name: /Kimi/ }));
  expect(chosen).toHaveBeenCalledWith(cells[1]);
  expect(screen.getByRole('button', { name: /DeepSeek/ })).toBeTruthy();
});
