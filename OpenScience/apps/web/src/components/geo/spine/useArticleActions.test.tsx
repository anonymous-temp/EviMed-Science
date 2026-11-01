import { act,renderHook } from '@testing-library/react';
import { beforeEach,expect,it,vi } from 'vitest';
import { useArticleActions } from './useArticleActions';
import { geoProject } from '../__fixtures__/geoTabs';
const calls=vi.hoisted(()=>({get:vi.fn(),revision:vi.fn(),open:vi.fn()}));
vi.mock('@/lib/resultProvenance',()=>({getResultVersion:calls.get,requestResultRevision:calls.revision}));
vi.mock('../useOpenGeoConversation',()=>({useOpenGeoConversation:()=>calls.open}));
vi.mock('./useOpenArticle',()=>({useOpenArticle:()=>vi.fn()}));
const article={id:'article',title:'Title',runId:'r',path:'articles/a.md',currentResultVersionId:'version-selected',contentSha256:'digest-selected'};
beforeEach(()=>{vi.clearAllMocks();calls.get.mockResolvedValue({projectId:'prj_geo_1',versionId:'version-selected',digest:'digest-selected',producer:{sessionId:'native-original'}});calls.revision.mockResolvedValue({referenceId:'rr_selected',draft:'selected draft'});});
it('language revision stays attached to exactly the selected article version and producer conversation',async()=>{
  const hook=renderHook(()=>useArticleActions('geo_1',geoProject(),vi.fn()));
  await act(async()=>{await hook.result.current.humanizeInConversation(article);});
  expect(calls.get).toHaveBeenCalledWith('version-selected');
  expect(calls.revision).toHaveBeenCalledWith(expect.objectContaining({versionId:'version-selected',digest:'digest-selected'}),{kind:'file',elementId:'file',selectedText:''},'native-original');
  expect(calls.open).toHaveBeenCalledWith({projectId:'prj_geo_1',geoId:'geo_1',sessionId:'native-original',resultRevision:{referenceId:'rr_selected'}},expect.stringContaining('保留数字、引文、出处、药名与限定条件'));
});
it('does not silently swap a stale article digest or project',async()=>{
  calls.get.mockResolvedValue({projectId:'other-project',versionId:'version-selected',digest:'new-digest',producer:{sessionId:'different'}});
  const hook=renderHook(()=>useArticleActions('geo_1',geoProject(),vi.fn()));
  await act(async()=>{await hook.result.current.continueInConversation(article);});
  expect(calls.revision).not.toHaveBeenCalled();expect(calls.open).not.toHaveBeenCalled();
});
