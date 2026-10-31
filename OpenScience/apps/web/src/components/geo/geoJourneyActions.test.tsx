import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeoProject } from '@/lib/geoClient';
import { StepPending } from './tabs/geoTabKit';
import { GeoProjectPreview } from './GeoHomePreview';
import { GEO_SUMMARIES } from './__fixtures__/geoProjects';
import { frameGeoOptions } from './frameGeoOptions';
const calls=vi.hoisted(()=>({run:vi.fn(),open:vi.fn(),toast:vi.fn()}));
vi.mock('@/lib/geoClient',async original=>({...await original<typeof import('@/lib/geoClient')>(),runGeoStep:calls.run}));
vi.mock('./useOpenGeoConversation',()=>({useOpenGeoConversation:()=>calls.open}));
vi.mock('@/lib/toast',()=>({toast:{success:calls.toast,error:vi.fn()}}));
const project=(patch:Partial<GeoProject>={})=>({id:'g',projectId:'p',name:'Project',product:{brandName:'Product'},status:'active',engines:[],steps:{},...patch}) as GeoProject;
const mount=(node:React.ReactNode)=>render(<MemoryRouter>{node}</MemoryRouter>);
beforeEach(()=>{vi.clearAllMocks();calls.run.mockResolvedValue({accepted:true,runId:'run'});});
describe('GEO task action authority and feedback',()=>{
  it.each(['paused','viewer'] as const)('keeps failed results readable but prevents %s retries',mode=>{
    const p=project({status:mode==='paused'?'paused':'active',access:{roles:[],owner:false,abilities:mode==='viewer'?['read']:['run','edit']},steps:{content:{status:'failed',requested:true,note:'Task could not finish',summary:{text:'2 drafts',count:2,unit:'drafts'}}}});
    mount(<StepPending geoId="g" project={p} step="content"/>);
    expect(screen.queryByRole('button',{name:'接着做'})).toBeNull();
    expect(screen.queryByRole('button',{name:/开始任务/})).toBeNull();
    expect(calls.run).not.toHaveBeenCalled();
  });
  it('names the real prerequisite for standalone monitoring, never placement',()=>{
    mount(<StepPending geoId="g" project={project({steps:{monitoring:{status:'none',requested:true}}})} step="monitoring"/>);
    expect(screen.getByRole('status')).toHaveTextContent('诊断');
    expect(screen.getByRole('status')).not.toHaveTextContent('投放');
  });
  it('takes missing product inputs through the existing conversation instead of an unattended background task',async()=>{
    mount(<StepPending geoId="g" project={project({product:{}})} step="evidence"/>);
    await userEvent.click(screen.getByRole('button',{name:'在对话中补充产品与资料'}));
    expect(calls.open).toHaveBeenCalledWith(expect.objectContaining({geoId:'g',projectId:'p'}),expect.stringContaining('目标受众'));
    expect(calls.run).not.toHaveBeenCalled();
  });
  it('explicitly starts a task and acknowledges its execution',async()=>{
    mount(<StepPending geoId="g" project={project()} step="evidence"/>);
    await userEvent.click(screen.getByRole('button',{name:'开始任务：整理产品证据'}));
    await waitFor(()=>expect(calls.toast).toHaveBeenCalledWith('已开始整理产品证据。',expect.any(Object)));
    expect(calls.run).toHaveBeenCalledWith('g','evidence');
  });
  it('uses edit authority for native settings and offers only three contextual task intents',()=>{
    const value=frameGeoOptions('session',project({access:{roles:['runner'],owner:false,abilities:['run']}}));
    expect(value.controls).toBe(false);
    expect(value.starters).toEqual([]);
    const writable=frameGeoOptions('session',project());
    expect(writable.starters.map(item=>item.label)).toEqual(['诊断 AI 回答','修改已有稿件','制定策略与方案']);
    expect(writable.journey?.detail).toContain('已有资料');
  });
});

it('preview steps are direct destinations and read-only paused projects offer no resume or write conversation',()=>{
  const p={...GEO_SUMMARIES[0],status:'paused' as const,access:{roles:['viewer'],owner:false,abilities:['read']}};
  mount(<GeoProjectPreview project={p} label={p.name} heading resuming={false} onResume={vi.fn()} onConversation={vi.fn()}/>);
  expect(screen.queryByRole('button',{name:'恢复项目'})).toBeNull();
  expect(screen.queryByRole('button',{name:'在对话中继续'})).toBeNull();
  const links=screen.getByRole('list',{name:'八步进度'}).querySelectorAll('a');
  expect(links).toHaveLength(8);
  for(const link of links) expect(link.getAttribute('href')).toContain(`/app/geo/${p.id}/`);
});
