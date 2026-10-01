import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VcrRegistryCoverage } from './VcrRegistryCoverage';
describe('registry coverage', () => {
  it('shows missing credentials and list-only limitations separately from a successful source', () => {
    render(<VcrRegistryCoverage sources={[
      { key: 'ctgov', label: 'ClinicalTrials.gov', configured: true, coverage: 'structured', availability: 'available', reason: null, lastCheckedAt: null },
      { key: 'chictr', label: 'ChiCTR', configured: false, coverage: 'list_only', availability: 'unavailable', reason: 'registry_not_configured', lastCheckedAt: null },
      { key: 'ctis', label: 'EU CTIS', configured: false, coverage: 'unsupported', availability: 'unavailable', reason: 'registry_unsupported', lastCheckedAt: null },
    ]} />);
    expect(screen.getByText('上次读取成功')).toBeInTheDocument();
    expect(screen.getByText('未配置')).toBeInTheDocument();
    expect(screen.getByText('仅登记列表')).toBeInTheDocument();
    expect(screen.getByText(/不能作为历史基线/)).toBeInTheDocument();
    expect(screen.queryByText(/0 项/)).not.toBeInTheDocument();
  });
});
