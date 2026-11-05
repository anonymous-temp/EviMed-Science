import { act, render, renderHook, screen }  from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WEB_SESSION_STARTED_EVENT } from '@/lib/sessionLifecycle';
import { beforeEach, expect, it, vi } from 'vitest';
import { useArticleActions } from './useArticleActions';
import { geoProject } from '../__fixtures__/geoTabs';
const calls=vi.hoisted(()=>({stage:vi.fn(),read:vi.fn(),open:vi.fn()}));
vi.mock('@/lib/geoClient',async original=>({...await original<typeof import('@/lib/geoClient')>(),stageGeoArticleRevision:calls.stage,readGeoArticleVersion:calls.read}));
vi.mock('../useOpenGeoConversation',()=>({useOpenGeoConversation:()=>calls.open}));
vi.mock('./useOpenArticle',()=>({useOpenArticle:()=>vi.fn()}));
const article={id:'article',title:'Title',runId:'r',path:'articles/a.md',currentResultVersionId:'version-selected',contentSha256:'digest-selected'};
beforeEach(()=>{vi.clearAllMocks();calls.stage.mockResolvedValue({referenceId:'rr_selected',sessionId:'native-original'});});
it('language revision stages the exact article and opens its exact authorized conversation',async()=>{
  const hook=renderHook(()=>useArticleActions('geo_1',geoProject(),vi.fn()));
  await act(async()=>{await hook.result.current.humanizeInConversation(article);});
  expect(calls.stage).toHaveBeenCalledWith('geo_1','article','version-selected','digest-selected');
  expect(calls.open).toHaveBeenCalledWith({projectId:'prj_geo_1',geoId:'geo_1',sessionId:'native-original',exactSession:true,resultRevision:{referenceId:'rr_selected'}},expect.stringContaining('保留数字、引文、出处、药名与限定条件'));
});
it('does not open a conversation when staging refuses a stale version',async()=>{
  calls.stage.mockRejectedValue(new Error('stale'));
  const hook=renderHook(()=>useArticleActions('geo_1',geoProject(),vi.fn()));
  await act(async()=>{await hook.result.current.continueInConversation(article);});
  expect(calls.open).not.toHaveBeenCalled();
});

it('reads the selected article through GEO scope and displays a refusal without falling back',async()=>{
  calls.read.mockResolvedValueOnce({versionId:'version-selected',digest:'digest-selected',text:'Frozen article'}).mockRejectedValueOnce(new Error('unavailable'));
  function Host(){const actions=useArticleActions('geo_1',geoProject(),vi.fn());return <><button onClick={()=>actions.open(article)}>Open</button>{actions.dialogs}</>;}
  render(<Host />);const user=userEvent.setup();
  await user.click(screen.getByRole('button',{name:'Open'}));
  expect(await screen.findByText('Frozen article')).toBeInTheDocument();
  expect(calls.read).toHaveBeenCalledWith('geo_1','article','version-selected','digest-selected');
  await user.click(screen.getByRole('button',{name:'关闭'}));
  await user.click(screen.getByRole('button',{name:'Open'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('所选版本暂时无法读取');
});

it('discards a late staged revision across an account boundary',async()=>{
  let finish!: (value: {referenceId:string;sessionId:string}) => void;
  calls.stage.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const hook=renderHook(()=>useArticleActions('geo_1',geoProject(),vi.fn()));
  let pending!: Promise<void>;
  act(()=>{pending=hook.result.current.continueInConversation(article);});
  act(()=>window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)));
  await act(async()=>{finish({referenceId:'old',sessionId:'native-original'});await pending;});
  expect(calls.open).not.toHaveBeenCalled();
});

it('removes article text and ignores an old read on an account boundary',async()=>{
  let finish!: (value: {versionId:string;digest:string;text:string}) => void;
  calls.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  function Host(){const actions=useArticleActions('geo_1',geoProject(),vi.fn());return <><button onClick={()=>actions.open(article)}>Open</button>{actions.dialogs}</>;}
  render(<Host />);await userEvent.click(screen.getByRole('button',{name:'Open'}));
  act(()=>window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)));
  await act(async()=>{finish({versionId:'version-selected',digest:'digest-selected',text:'Old private text'});});
  expect(screen.queryByText('Old private text')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog',{name:'查看内容版本'})).not.toBeInTheDocument();
});

it('removes already displayed article text on an account boundary',async()=>{
  calls.read.mockResolvedValue({versionId:'version-selected',digest:'digest-selected',text:'Visible article before switch'});
  function Host(){const actions=useArticleActions('geo_1',geoProject(),vi.fn());return <><button onClick={()=>actions.open(article)}>Open</button>{actions.dialogs}</>;}
  render(<Host />);await userEvent.click(screen.getByRole('button',{name:'Open'}));
  expect(await screen.findByText('Visible article before switch')).toBeInTheDocument();
  act(()=>window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)));
  expect(screen.queryByText('Visible article before switch')).not.toBeInTheDocument();
});
