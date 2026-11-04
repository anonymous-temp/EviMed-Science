import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { ErrorDrawer } from './ErrorDrawer';
import { geoProject } from '../__fixtures__/geoTabs';
import type { GeoErrorRow } from '@/lib/geoClient';
import type { ClaimRow } from './errorModel';

it('explains an unknown accepted confirmation without claiming it was retried', () => {
  const row = { id: 'error', engine: 'deepseek', statement: 'Example', severity: 'S2', errorType: 'number',
    stability: 'unconfirmed', confirmationReason: 'delivery_unknown_no_automatic_retry', citedSource: null,
    action: null, status: 'open', snapshotId: null } as GeoErrorRow;
  const claim: ClaimRow = { key: 'claim', statement: 'Example', claimId: null, engines: ['deepseek'], count: 1,
    severity: 'S2', status: 'open', urgent: false, snapshotId: null, evidenceQuote: null, rows: [row], traces: ['unattributable'] };
  render(<MemoryRouter><ErrorDrawer geoId="geo_1" project={geoProject()} claim={claim} actions={[]} groupOf={new Map()} onClose={vi.fn()} /></MemoryRouter>);
  expect(screen.getByText('复问结果未知，未自动重试，请人工核查。')).toBeVisible();
  expect(screen.getByText(/待复核/)).toBeVisible();
});

it('shows an ungraded error as unknown without assigning it a severity', () => {
  const row: GeoErrorRow = { id: 'error', engine: 'deepseek', statement: 'Example', severity: null, errorType: 'number',
    stability: 'unconfirmed', citedSource: null, action: null, status: 'open', snapshotId: null };
  const claim: ClaimRow = { key: 'claim', statement: row.statement, claimId: null, engines: ['deepseek'], count: 1,
    severity: null, status: 'open', urgent: false, snapshotId: null, evidenceQuote: null, rows: [row], traces: ['unattributable'] };
  render(<MemoryRouter><ErrorDrawer geoId="geo_1" project={geoProject()} claim={claim} actions={[]} groupOf={new Map()} onClose={vi.fn()} /></MemoryRouter>);
  expect(screen.getByText('严重程度未知')).toBeVisible();
  expect(screen.queryByText(/潜在临床风险 S[0-4]/)).not.toBeInTheDocument();
});

it('keeps an unknown engine severity visible beside a graded engine', () => {
  const unknown: GeoErrorRow = { id: 'unknown', engine: 'deepseek', statement: 'Example', severity: null, errorType: 'number',
    stability: 'unconfirmed', citedSource: null, action: null, status: 'open', snapshotId: null };
  const known: GeoErrorRow = { ...unknown, id: 'known', engine: 'doubao', severity: 'S2' };
  const claim: ClaimRow = { key: 'claim', statement: unknown.statement, claimId: null, engines: ['deepseek', 'doubao'], count: 2,
    severity: 'S2', status: 'open', urgent: false, snapshotId: null, evidenceQuote: null, rows: [known, unknown], traces: ['unattributable'] };
  render(<MemoryRouter><ErrorDrawer geoId="geo_1" project={geoProject()} claim={claim} actions={[]} groupOf={new Map()} onClose={vi.fn()} /></MemoryRouter>);
  expect(screen.getByText(/潜在临床风险 S2/)).toBeVisible();
  expect(screen.getByText(/严重程度未知/)).toBeVisible();
});
