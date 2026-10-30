import { expect, it, vi } from 'vitest';
import { requestDocumentExport } from './documentExport';

const mocks = vi.hoisted(() => ({ request: vi.fn(), current: vi.fn(() => 'current-project') }));
vi.mock('./productClient', () => ({ productRequest: mocks.request }));
vi.mock('./apiClient', () => ({ getWebProjectId: mocks.current, webApiBase: '/api', fetchWithWebAuth: vi.fn() }));

it('uses the preview project for an ordinary export and retains the default when unspecified', () => {
  const source = { artifactId: 'report.md' };
  requestDocumentExport(source, undefined, 'preview-project');
  expect(mocks.request).toHaveBeenLastCalledWith('/document-exports', 'POST', { projectId: 'preview-project', source, formats: ['docx', 'pdf', 'html'] });
  requestDocumentExport(source);
  expect(mocks.request).toHaveBeenLastCalledWith('/document-exports', 'POST', { projectId: 'current-project', source, formats: ['docx', 'pdf', 'html'] });
});
