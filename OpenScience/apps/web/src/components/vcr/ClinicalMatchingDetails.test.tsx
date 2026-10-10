import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClinicalTimeline, MatchingPanelControls } from './ClinicalMatchingDetails';
import { CloudDocuments, reviewedSpans } from './data/CloudDocuments';
import type { VcrIntakeSource, VcrMatchingTab } from '@/lib/vcrClient';
const api = vi.hoisted(() => ({ enqueue:vi.fn(),quote:vi.fn(),permission:vi.fn(),document:vi.fn(),projection:vi.fn() }));
vi.mock('@/lib/vcrClient',()=>({enqueueVcrMatching:api.enqueue,resolveVcrQuote:api.quote,setVcrCloudPermission:api.permission,getVcrProtectedDocument:api.document,createVcrProjection:api.projection}));
beforeEach(()=>vi.clearAllMocks());

describe('evaluating from the controls',()=>{
  const page=(extra:Record<string,unknown>={})=>({protocols:[{id:'p1',version:1,title:'方案一'},{id:'p2',version:2,title:'方案二'}],protocolVersionId:'p2',direction:'trial_to_patient',candidateRoster:['P-001'],...extra}) as unknown as VcrMatchingTab;
  const controls=(data=page(),extra:Record<string,unknown>={})=>render(<MatchingPanelControls studyId="s1" data={data} canRun onProtocol={()=>{}} onCandidate={()=>{}} onReload={()=>{}} {...extra}/>);
  // Review V-M5: 开始评估所选方案 and 刷新结果 were inside 比较多个方案, so running one protocol meant finding a section named "compare several".
  it('starts the protocol in view, and refreshes, without opening 比较多个方案',async()=>{
    api.enqueue.mockResolvedValue({jobs:[{jobId:'job',state:'queued'}],unavailable:[]});
    controls();
    const start=screen.getByRole('button',{name:'开始评估'});
    expect(start.closest('details')).toBeNull();
    expect(screen.getByRole('button',{name:'刷新结果'}).closest('details')).toBeNull();
    fireEvent.click(start);
    await waitFor(()=>expect(api.enqueue).toHaveBeenCalledWith('s1',{protocolVersionIds:['p2'],direction:'trial_to_patient'}));
    expect(await screen.findByRole('status')).toHaveTextContent('已提交 1 项评估。');
  });
  it('says nothing was submitted, and why, when no job was queued — as a problem, not as a success with a zero in it',async()=>{
    api.enqueue.mockResolvedValue({jobs:[],unavailable:[{code:'vcr_criteria_missing'}]});
    controls();
    fireEvent.click(screen.getByRole('button',{name:'开始评估'}));
    const alert=await screen.findByRole('alert');
    expect(alert).toHaveTextContent('没有提交评估。方案还没有结构化的入排条件，无法匹配。');
    expect(alert).not.toHaveTextContent('已提交');
  });
  it('says what was queued and what was not when only some of the protocols could be',async()=>{
    api.enqueue.mockResolvedValue({jobs:[{jobId:'job',state:'queued'}],unavailable:[{code:'vcr_criteria_missing'}]});
    controls();
    fireEvent.click(screen.getByRole('button',{name:'开始评估'}));
    expect(await screen.findByRole('status')).toHaveTextContent('已提交 1 项评估，1 项暂不可用。');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('runs the protocol the reader chose, for the patient the reader chose, in the direction the reader chose',async()=>{
    api.enqueue.mockResolvedValue({jobs:[{jobId:'job',state:'queued'}],unavailable:[]});
    controls(page({direction:'trial_to_patient'}),{direction:'patient_to_trial',protocolId:'p1'});
    const start=screen.getByRole('button',{name:'开始评估'});
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByLabelText('受试者'),{target:{value:'P-001'}});
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(()=>expect(api.enqueue).toHaveBeenCalledWith('s1',{protocolVersionIds:['p1'],subjectKeys:['P-001'],direction:'patient_to_trial'}));
  });
  it('offers no run to a reader who may not run it, and keeps the refresh',()=>{
    controls(page(),{canRun:false});
    expect(screen.queryByRole('button',{name:'开始评估'})).toBeNull();
    expect(screen.getByRole('button',{name:'刷新结果'})).toBeVisible();
  });
});

describe('choosing the protocols to compare',()=>{
  const protocols=(count:number)=>Array.from({length:count},(_,index)=>({id:`p${index+1}`,version:index+1,title:`方案 ${index+1}`}));
  const controls=(count:number)=>render(<MatchingPanelControls studyId="s1" data={{protocols:protocols(count),protocolVersionId:'p1',direction:'trial_to_patient'} as unknown as VcrMatchingTab} canRun onProtocol={()=>{}} onCandidate={()=>{}} onReload={()=>{}}/>);
  const group=()=>screen.getByRole('group',{name:'选择方案（最多 10 项）'});
  const boxes=()=>within(group()).getAllByRole('checkbox') as HTMLInputElement[];
  // Review V-M1: a native <select multiple> asks for Ctrl/Cmd-click with no hint, is unusable by touch, and showed an eleventh
  // option as chosen while the request sent ten.
  it('is a list of checkboxes — a group with one box per protocol — and not a multiple select',()=>{
    const {container}=controls(3);
    expect(container.querySelector('select[multiple]')).toBeNull();
    expect(boxes().map(box=>box.closest('label')?.textContent)).toEqual(['方案 1','方案 2','方案 3']);
    // A finger finds the whole row: 44 px high, from the heights the design system names.
    for(const box of boxes())expect(box.closest('label')).toHaveClass('min-h-form-primary');
  });
  it('picks several with plain clicks and sends exactly those',async()=>{
    api.enqueue.mockResolvedValue({jobs:[{jobId:'a'},{jobId:'b'}],unavailable:[]});
    controls(3);
    const [first,second,third]=boxes();
    fireEvent.click(first);fireEvent.click(third);
    expect([first,second,third].map(box=>box.checked)).toEqual([true,false,true]);
    fireEvent.click(screen.getByRole('button',{name:'开始评估所选方案'}));
    await waitFor(()=>expect(api.enqueue).toHaveBeenCalledWith('s1',{protocolVersionIds:['p1','p3'],direction:'trial_to_patient'}));
  });
  it('stops at ten and says why, and lets another be chosen once one is let go',()=>{
    controls(12);
    for(const box of boxes().slice(0,10))fireEvent.click(box);
    const [,,,,,,,,,,eleventh,twelfth]=boxes();
    expect(eleventh).toBeDisabled();expect(twelfth).toBeDisabled();
    expect(boxes().filter(box=>box.checked)).toHaveLength(10);
    expect(within(group()).getByText(/^已选/)).toHaveTextContent('已选 10 项，已到上限；取消一项后才能再选。');
    fireEvent.click(boxes()[0]);
    expect(eleventh).toBeEnabled();
    expect(within(group()).getByText(/^已选/)).toHaveTextContent('已选 9 项');
    expect(within(group()).getByText(/^已选/)).not.toHaveTextContent('已到上限');
  });
});

describe('clinical matching controls',()=>{
  it('keeps a patient-to-trial request unsubmitted until both patient and protocols are selected',async()=>{
    api.enqueue.mockResolvedValue({jobs:[{id:'job'}],unavailable:[]});
    const data={protocols:[{id:'p1',version:1,title:'方案一'},{id:'p2',version:2,title:'方案二'}],direction:'patient_to_trial',candidateRoster:['P-001']} as unknown as VcrMatchingTab;
    render(<MatchingPanelControls studyId="s1" data={data} canRun onProtocol={()=>{}} onCandidate={()=>{}} onReload={()=>{}}/>);
    fireEvent.click(screen.getByText('比较多个方案'));
    const button=screen.getByRole('button',{name:'开始评估所选方案'});
    expect(button).toBeDisabled();
    for(const box of within(screen.getByRole('group',{name:'选择方案（最多 10 项）'})).getAllByRole('checkbox'))fireEvent.click(box);
    expect(button).toBeDisabled();
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
