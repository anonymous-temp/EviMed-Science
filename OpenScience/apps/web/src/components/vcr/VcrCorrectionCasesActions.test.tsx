import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VcrCorrectionCasesActions } from './VcrCorrectionCasesActions';
const api = vi.hoisted(() => ({ export: vi.fn(), replay: vi.fn(), download: vi.fn() }));
vi.mock('@/lib/vcrClient', () => ({ exportVcrCorrectionCases: api.export, replayVcrCorrectionCases: api.replay }));
vi.mock('@/lib/artifactFile', () => ({ downloadInlineArtifact: api.download }));
describe('correction case actions', () => {
  it('downloads the authorized reference manifest then replays its exact dataset id', async () => {
    const dataset = { datasetId: 'eds_approved', schemaVersion: 'vcr-correction-cases-1', cases: [{ caseId: 'case_1', partition: 'held_out' }], selection: { more: false, nextCursor: null, legacyUnfrozen: 0 } };
    api.export.mockResolvedValueOnce(dataset); api.replay.mockResolvedValueOnce({ evaluated: 1, matched: 0, partition: 'held_out', extractionRerun: false });
    render(<VcrCorrectionCasesActions studyId="study" />);
    fireEvent.click(screen.getByRole('button', { name: '导出纠正案例' }));
    await waitFor(() => expect(api.download).toHaveBeenCalledWith(JSON.stringify(dataset, null, 2), 'correction-cases-eds_approved.json'));
    fireEvent.click(screen.getByRole('button', { name: '重放留出案例' }));
    await waitFor(() => expect(api.replay).toHaveBeenCalledWith('study', 'eds_approved'));
    expect(await screen.findByText(/0 条复现了纠正结果/)).toBeInTheDocument();
    expect(screen.getByText(/未重新进行病历抽取/)).toBeInTheDocument();
  });
  it('shows source authorization failures without inventing replay results', async () => {
    api.export.mockRejectedValueOnce(new Error('Source permission revoked'));
    render(<VcrCorrectionCasesActions studyId="restricted" />);
    fireEvent.click(screen.getByRole('button', { name: '导出纠正案例' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重放留出案例' })).not.toBeInTheDocument();
  });
});
