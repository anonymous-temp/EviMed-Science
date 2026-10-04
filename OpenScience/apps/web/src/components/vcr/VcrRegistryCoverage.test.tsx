import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VcrRegistryCoverage } from './VcrRegistryCoverage';
describe('registry coverage', () => {
  it('shows missing credentials and list-only limitations separately from a successful source', () => {
    render(<VcrRegistryCoverage sources={[
      { key: 'ctgov', label: 'ClinicalTrials.gov', configured: true, coverage: 'structured', availability: 'available', reason: null, lastCheckedAt: null },
      { key: 'chictr', label: 'ChiCTR', configured: false, coverage: 'list_only', availability: 'unavailable', reason: 'registry_not_configured', lastCheckedAt: null },
      { key: 'ctis', label: 'EU CTIS', configured: true, coverage: 'structured', availability: 'unavailable', reason: 'timeout', lastCheckedAt: null },
      { key: 'cde', label: 'CDE', configured: false, coverage: 'unsupported', availability: 'unavailable', reason: 'registry_unsupported', lastCheckedAt: null },
      { key: 'ictrp', label: 'WHO ICTRP', configured: false, coverage: 'unsupported', availability: 'unavailable', reason: 'registry_terms_forbid_commercial_use', lastCheckedAt: null },
    ]} />);
    expect(screen.getByText('上次读取成功')).toBeInTheDocument();
    // CTIS is a structured source like ClinicalTrials.gov, and an outage reads as one, not as an empty source.
    expect(screen.getByText('上次读取失败')).toBeInTheDocument();
    expect(screen.getByText('EU CTIS').closest('li')?.textContent).toContain('结构化记录');
    // WHO ICTRP is left out by its own terms, and the row says that: it is not "not yet integrated".
    const left = screen.getByText('WHO ICTRP').closest('li')?.textContent ?? '';
    expect(left).toContain('未接入');
    expect(left).toContain('使用条款禁止商业使用');
    expect(screen.getByText('CDE').closest('li')?.textContent).not.toContain('使用条款');
    expect(screen.getByText('未配置')).toBeInTheDocument();
    expect(screen.getByText('仅登记列表')).toBeInTheDocument();
    expect(screen.getByText(/不能作为历史基线/)).toBeInTheDocument();
    expect(screen.queryByText(/0 项/)).not.toBeInTheDocument();
  });
});
