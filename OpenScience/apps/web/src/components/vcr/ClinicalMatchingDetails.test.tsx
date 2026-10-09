import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClinicalTimeline, MatchingPanelControls } from './ClinicalMatchingDetails';
import { CloudDocuments, reviewedSpans } from './data/CloudDocuments';
import type { VcrIntakeSource, VcrMatchingTab } from '@/lib/vcrClient';
const api = vi.hoisted(() => ({ enqueue:vi.fn(),quote:vi.fn(),permission:vi.fn(),document:vi.fn(),projection:vi.fn() }));
vi.mock('@/lib/vcrClient',()=>({enqueueVcrMatching:api.enqueue,resolveVcrQuote:api.quote,setVcrCloudPermission:api.permission,getVcrProtectedDocument:api.document,createVcrProjection:api.projection}));
beforeEach(()=>vi.clearAllMocks());

describe('clinical matching controls',()=>{
  it('keeps a patient-to-trial request unsubmitted until both patient and protocols are selected',async()=>{
    api.enqueue.mockResolvedValue({jobs:[{id:'job'}],unavailable:[]});
    const data={protocols:[{id:'p1',version:1,title:'方案一'},{id:'p2',version:2,title:'方案二'}],direction:'patient_to_trial',candidateRoster:['P-001']} as unknown as VcrMatchingTab;
    render(<MatchingPanelControls studyId="s1" data={data} canRun onProtocol={()=>{}} onCandidate={()=>{}} onReload={()=>{}}/>);
    fireEvent.click(screen.getByText('比较多个方案'));
    const button=screen.getByRole('button',{name:'开始评估所选方案'});
    expect(button).toBeDisabled();
    const select=screen.getByLabelText('选择方案（最多 10 项）') as HTMLSelectElement;
    for(const option of select.options)option.selected=true;
    fireEvent.change(select);expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('受试者'),{target:{value:'P-001'}});
    fireEvent.click(button);
    await waitFor(()=>expect(api.enqueue).toHaveBeenCalledWith('s1',{protocolVersionIds:['p1','p2'],subjectKeys:['P-001'],direction:'patient_to_trial'}));
    expect(await screen.findByRole('status')).toHaveTextContent('已提交 1 项评估');
  });
  it('shows conflicts and sourced corrections while opening originals only through the protected resolver',async()=>{
    api.quote.mockResolvedValue({evidence:{quote:'受保护的合成原文'}});
    const data={timeline:[{id:'f1',variable:'creatinine',at:null,assertion:'affirmed',experiencer:'patient',quote:'肌酐 2.4 mg/dL',correctionOf:'f0',correctionReason:'检验科更正',conflictFactIds:['f2'],locator:{documentId:'prj_fixture',start:0,end:13}}]} as unknown as VcrMatchingTab;
    render(<ClinicalTimeline studyId="s1" data={data} mayReadOriginal/>);
    fireEvent.click(screen.getByText('临床记录与更正'));
    expect(screen.getByText(/记录有冲突/)).toBeVisible();
    expect(screen.getByText('检验科更正')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'查看对应原文'}));
    expect(await screen.findByText('受保护的合成原文')).toBeVisible();
    expect(api.quote).toHaveBeenCalledWith('s1','prj_fixture',{start:0,end:13,quote:'肌酐 2.4 mg/dL'});
  });
  it('preserves Unicode offsets and requires renewed permission when a source authorization expired',()=>{
    const text='😀王小明住院。王小明否认胸痛。';
    expect(reviewedSpans(text,'王小明\n小明')).toEqual([{start:2,end:5,kind:'identifier'},{start:8,end:11,kind:'identifier'}]);
    const source={id:'src',files:[],upload:{cloudDestinations:['https://example.org']},cloudPermission:{status:'approved',expiresAt:'2000-01-01'}} as unknown as VcrIntakeSource;
    render(<CloudDocuments studyId="s1" source={source} onChanged={()=>{}}/>);
    fireEvent.click(screen.getByText('病历云端处理 · 授权已到期'));
    expect(screen.getByRole('button',{name:'保存云端处理授权'})).toBeDisabled();
    expect(screen.queryByRole('button',{name:'保存脱敏文本'})).toBeNull();
  });
});
