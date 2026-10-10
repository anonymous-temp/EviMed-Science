import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClinicalTimeline, MatchingPanelControls } from './ClinicalMatchingDetails';
import { CloudDocuments, reviewedSpans } from './data/CloudDocuments';
import type { VcrIntakeSource, VcrMatchingTab } from '@/lib/vcrClient';
import { WebApiError } from '@/lib/apiClient';
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
    fireEvent.change(screen.getByLabelText('患者'),{target:{value:'P-001'}});
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

describe('the redaction a reviewer attests to',()=>{
  const TEXT='王小明住院。王小明否认胸痛。李四来探视。';
  const source=()=>({id:'src',files:[{id:'doc1',name:'病历.txt',role:'document'}],upload:{cloudDestinations:['https://api.example.org']},
    cloudPermission:{status:'approved',reference:'合作协议 2026-09',expiresAt:'2999-01-01'}}) as unknown as VcrIntakeSource;
  async function open(){
    api.document.mockResolvedValue({document:{id:'doc1',text:TEXT,sourceHash:'h1'}});
    api.projection.mockResolvedValue({});
    const changed=vi.fn();
    const view=render(<CloudDocuments studyId="s1" source={source()} onChanged={changed}/>);
    fireEvent.click(screen.getByText('病历云端处理 · 已授权'));
    fireEvent.change(screen.getByLabelText('准备脱敏文本'),{target:{value:'doc1'}});
    fireEvent.click(screen.getByRole('button',{name:'打开原文'}));
    await screen.findByLabelText('受保护的原文');
    return {view,changed};
  }
  const identify=(lines:string)=>fireEvent.change(screen.getByLabelText('需替换的姓名、编号或地址（每行一项）'),{target:{value:lines}});
  const preview=()=>screen.getByRole('region',{name:'脱敏后的文本'});

  // Review V-C1: the reviewer attested 「已检查全文」 without seeing the text that would be saved, with one total over all
  // identifiers (a misspelt one matched nothing and nobody saw it), and the whole record stayed in the page after the save.
  it('shows the text as it will be saved — the located names masked, everything else as written — before the save can be pressed',async()=>{
    await open();
    identify('王小明');
    expect(preview()).not.toHaveTextContent('王小明');
    expect(within(preview()).getAllByText('已遮蔽')).toHaveLength(2);
    expect(preview()).toHaveTextContent('住院。');
    // A name the reviewer did not list is plainly still there: this is what the attestation is about.
    expect(preview()).toHaveTextContent('李四来探视');
    expect(screen.getByRole('button',{name:'保存脱敏文本'})).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox',{name:/已检查脱敏后的全文/}));
    expect(screen.getByRole('button',{name:'保存脱敏文本'})).toBeEnabled();
  });
  it('counts each identifier on its own and warns on one that was found nowhere',async()=>{
    await open();
    identify('王小明\n王晓明\n李四');
    const list=screen.getByRole('list',{name:'需替换的内容'});
    const [first,second,third]=within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('王小明');expect(first).toHaveTextContent('2 处');
    expect(second).toHaveTextContent('王晓明');expect(second).toHaveTextContent('0 处');expect(second).toHaveTextContent('原文里没有找到');
    expect(third).toHaveTextContent('1 处');expect(third).not.toHaveTextContent('没有找到');
    expect(screen.getByText(/共 3 处将被替换/)).toBeVisible();
  });
  it('sends what it always sent — the reviewed spans of the original and the permission it rests on — and then lets the record go',async()=>{
    const {changed}=await open();
    identify('王小明');
    fireEvent.click(screen.getByRole('checkbox',{name:/已检查脱敏后的全文/}));
    fireEvent.click(screen.getByRole('button',{name:'保存脱敏文本'}));
    await waitFor(()=>expect(api.projection).toHaveBeenCalledWith('s1','doc1',{sourceHash:'h1',spans:[{start:0,end:3,kind:'identifier'},{start:6,end:9,kind:'identifier'}],attestation:'合作协议 2026-09'}));
    await waitFor(()=>expect(changed).toHaveBeenCalled());
    expect(await screen.findByText('已准备脱敏文本，匹配可读取这份副本。')).toBeVisible();
    // Neither the record nor the names typed beside it stay in the page.
    expect(screen.queryByLabelText('受保护的原文')).toBeNull();
    expect(screen.queryByLabelText('需替换的姓名、编号或地址（每行一项）')).toBeNull();
    expect(screen.queryByRole('region',{name:'脱敏后的文本'})).toBeNull();
    expect(document.body.textContent).not.toContain('王小明');
    expect(document.body.textContent).not.toContain('李四');
  });
  it('keeps the record when the save fails, so the reviewer can try again',async()=>{
    api.document.mockResolvedValue({document:{id:'doc1',text:TEXT,sourceHash:'h1'}});
    await open();
    api.projection.mockRejectedValue(new WebApiError('no',{status:409,code:'vcr_projection_span_invalid'}));
    identify('王小明');
    fireEvent.click(screen.getByRole('checkbox',{name:/已检查脱敏后的全文/}));
    fireEvent.click(screen.getByRole('button',{name:'保存脱敏文本'}));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByLabelText('受保护的原文')).toBeInTheDocument();
    expect(screen.getByLabelText('需替换的姓名、编号或地址（每行一项）')).toHaveValue('王小明');
  });
  it('lets the record go when the fold is closed',async()=>{
    await open();
    identify('王小明');
    fireEvent.click(screen.getByText('病历云端处理 · 已授权'));
    await waitFor(()=>expect(screen.queryByLabelText('受保护的原文')).toBeNull());
    expect(document.body.textContent).not.toContain('王小明');
  });
});

describe('the clinical timeline',()=>{
  const fact=(id:string,extra:Record<string,unknown>={})=>({id,variable:'creatinine',value:2.4,unit:'mg/dL',at:null,assertion:'affirmed',experiencer:'patient',medicationState:null,correctionOf:null,quote:null,superseded:false,conflictFactIds:[],correctionReason:null,locator:null,...extra});
  const timeline=(entries:unknown[],mayReadOriginal=true)=>{
    render(<ClinicalTimeline studyId="s1" data={{timeline:entries} as unknown as VcrMatchingTab} mayReadOriginal={mayReadOriginal} subject="P-001"/>);
    fireEvent.click(screen.getByText('P-001 的临床记录与更正'));
  };
  const rows=()=>screen.getAllByRole('listitem');
  beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-10T08:00:00Z'));});
  afterEach(()=>vi.useRealTimers());

  // Review V-M6: a patient's facts could run to hundreds of rows, drawn at once.
  it('shows the first twenty and lets the reader ask for the rest',()=>{
    timeline(Array.from({length:45},(_,index)=>fact(`f${index+1}`,{variable:`v${index+1}`})));
    expect(rows()).toHaveLength(20);
    fireEvent.click(screen.getByRole('button',{name:'显示更多 · 还有 25 条'}));
    expect(rows()).toHaveLength(40);
    fireEvent.click(screen.getByRole('button',{name:'显示更多 · 还有 5 条'}));
    expect(rows()).toHaveLength(45);
    expect(screen.queryByRole('button',{name:/显示更多/})).toBeNull();
  });
  // ...a structured value printed as [object Object]...
  it('writes a recorded value a reader can read — a record, a list, a yes or no — never [object Object]',()=>{
    timeline([
      fact('f1',{variable:'blood_pressure',value:{systolic:120,diastolic:80},unit:'mmHg'}),
      fact('f2',{variable:'allergies',value:['青霉素','磺胺'],unit:null}),
      fact('f3',{variable:'smoker',value:false,unit:null}),
      fact('f4',{variable:'ecog',value:null,unit:null}),
    ]);
    const text=rows().map(row=>row.textContent).join('|');
    expect(text).not.toContain('[object Object]');
    expect(rows()[0]).toHaveTextContent('blood_pressure：systolic：120；diastolic：80 mmHg');
    expect(rows()[1]).toHaveTextContent('allergies：青霉素、磺胺');
    expect(rows()[2]).toHaveTextContent('smoker：否');
    expect(rows()[3]).toHaveTextContent('ecog：未知');
  });
  // ...an ISO date prefix where the app writes 9月29日...
  it('dates a fact the way the rest of the app does: 9月29日 within this year, the full date before it',()=>{
    timeline([fact('f1',{at:'2026-09-29'}),fact('f2',{at:'2025-03-02'}),fact('f3',{at:null})]);
    expect(rows()[0]).toHaveTextContent('9月29日');
    expect(rows()[0]).not.toHaveTextContent('2026-09-29');
    expect(rows()[1]).toHaveTextContent('2025-03-02');
    expect(rows()[2]).toHaveTextContent('日期未记载');
  });
  // ...the original offered only to an id that starts with prj_...
  it('offers the original for any fact that cites a span it can be read from, whatever the document is called',async()=>{
    api.quote.mockResolvedValue({evidence:{quote:'原文片段'}});
    timeline([fact('f1',{quote:'肌酐 2.4 mg/dL',locator:{documentId:'doc_any_name',start:3,end:12}}),fact('f2'),fact('f3',{quote:'无定位',locator:null})]);
    expect(screen.getAllByRole('button',{name:'查看对应原文'})).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'查看对应原文'}));
    expect(await screen.findByText('原文片段')).toBeVisible();
    expect(api.quote).toHaveBeenCalledWith('s1','doc_any_name',{start:3,end:12,quote:'肌酐 2.4 mg/dL'});
  });
  it('offers no original to a reader who may not read patient-level records',()=>{
    timeline([fact('f1',{quote:'肌酐 2.4 mg/dL',locator:{documentId:'prj_x',start:3,end:12}})],false);
    expect(screen.queryByRole('button',{name:'查看对应原文'})).toBeNull();
  });
  // ...and the refusal under the whole list rather than under the fact it belongs to.
  it('says a refusal on the fact whose original was asked for, and nowhere else',async()=>{
    api.quote.mockRejectedValue(new WebApiError('no',{status:404,code:'vcr_projection_unavailable'}));
    timeline([
      fact('f1',{quote:'第一条',locator:{documentId:'prj_a',start:0,end:3}}),
      fact('f2',{quote:'第二条',locator:{documentId:'prj_b',start:0,end:3}}),
    ]);
    const [first,second]=rows();
    fireEvent.click(within(second).getByRole('button',{name:'查看对应原文'}));
    const alert=await within(second).findByRole('alert');
    expect(alert).toHaveTextContent('这份病历尚未准备好经审阅的脱敏文本。');
    expect(within(first).queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    // Asking again for the other one clears nothing of this one's, and a success clears its own.
    api.quote.mockResolvedValue({evidence:{quote:'第一条的原文'}});
    fireEvent.click(within(first).getByRole('button',{name:'查看对应原文'}));
    expect(await within(first).findByText('第一条的原文')).toBeVisible();
    expect(within(second).getByRole('alert')).toBeVisible();
    api.quote.mockResolvedValue({evidence:{quote:'第二条的原文'}});
    fireEvent.click(within(second).getByRole('button',{name:'查看对应原文'}));
    expect(await within(second).findByText('第二条的原文')).toBeVisible();
    expect(within(second).queryByRole('alert')).toBeNull();
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
    fireEvent.change(screen.getByLabelText('患者'),{target:{value:'P-001'}});
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
  it('names the person whose records the fold holds, when it is told whose they are',()=>{
    const data={timeline:[{id:'f1',variable:'creatinine',at:null,assertion:'affirmed',experiencer:'patient',quote:'肌酐 2.4 mg/dL',locator:null}]} as unknown as VcrMatchingTab;
    render(<ClinicalTimeline studyId="s1" data={data} mayReadOriginal={false} subject="P-0192"/>);
    expect(screen.getByText('P-0192 的临床记录与更正')).toBeInTheDocument();
  });
  it('says 患者, once and the same, where the controls ask for the person',()=>{
    render(<MatchingPanelControls studyId="s1" data={{protocols:[{id:'p1',version:1,title:'方案一'}],direction:'patient_to_trial',candidateRoster:['P-001']} as unknown as VcrMatchingTab} canRun onProtocol={()=>{}} onCandidate={()=>{}} onReload={()=>{}}/>);
    expect(screen.getByLabelText('患者')).toBeInTheDocument();
    expect(screen.getByRole('option',{name:'请选择患者'})).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/受试者/);
  });
  // 给患者找试验 starts from a person, and a person's trials do not wait on a protocol: a study with patients and no protocol version
  // still offers the patient to start from — and only that, since the protocol's controls have nothing to work on.
  it('offers the patient to start from when the study has no protocol version, in the direction that starts from a patient',()=>{
    const data={protocols:[],candidateRoster:['P-001','P-002'],direction:'patient_to_trial'} as unknown as VcrMatchingTab;
    render(<MatchingPanelControls studyId="s1" data={data} direction="patient_to_trial" canRun onProtocol={()=>{}} onCandidate={()=>{}} onReload={()=>{}}/>);
    expect(screen.getByLabelText('患者')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'刷新结果'})).toBeVisible();
    expect(screen.queryByLabelText('查看方案')).toBeNull();
    expect(screen.queryByRole('button',{name:'开始评估'})).toBeNull();
    expect(screen.queryByText('比较多个方案')).toBeNull();
  });
  it('draws nothing for a study with no protocol version in the other direction, as before',()=>{
    const data={protocols:[],candidateRoster:['P-001'],direction:'trial_to_patient'} as unknown as VcrMatchingTab;
    const {container}=render(<MatchingPanelControls studyId="s1" data={data} direction="trial_to_patient" canRun onProtocol={()=>{}} onCandidate={()=>{}} onReload={()=>{}}/>);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows the patient the page keeps, tells the page what was chosen, and says nobody when 请选择患者 is chosen again',()=>{
    const onCandidate=vi.fn();
    const data={protocols:[{id:'p1',version:1,title:'方案一'}],candidateRoster:['P-001','P-002'],direction:'patient_to_trial'} as unknown as VcrMatchingTab;
    const view=render(<MatchingPanelControls studyId="s1" data={data} direction="patient_to_trial" subjectKey="P-001" canRun onProtocol={()=>{}} onCandidate={onCandidate} onReload={()=>{}}/>);
    const select=screen.getByLabelText('患者') as HTMLSelectElement;
    expect(select.value).toBe('P-001');
    expect(screen.getByRole('button',{name:'开始评估'})).toBeEnabled();
    fireEvent.change(select,{target:{value:'P-002'}});
    expect(onCandidate).toHaveBeenLastCalledWith('P-002');
    // The page keeps the patient: the select follows what the page was given, not what was clicked.
    expect(select.value).toBe('P-001');
    fireEvent.change(select,{target:{value:''}});
    expect(onCandidate).toHaveBeenLastCalledWith('');
    view.rerender(<MatchingPanelControls studyId="s1" data={data} direction="patient_to_trial" subjectKey={null} canRun onProtocol={()=>{}} onCandidate={onCandidate} onReload={()=>{}}/>);
    expect((screen.getByLabelText('患者') as HTMLSelectElement).value).toBe('');
    expect(screen.getByRole('button',{name:'开始评估'})).toBeDisabled();
  });
  it('keeps the choice itself, and says nothing for the placeholder, where the page does not keep the patient',()=>{
    const onCandidate=vi.fn();
    const data={protocols:[{id:'p1',version:1,title:'方案一'}],candidateRoster:['P-001'],direction:'trial_to_patient'} as unknown as VcrMatchingTab;
    render(<MatchingPanelControls studyId="s1" data={data} canRun onProtocol={()=>{}} onCandidate={onCandidate} onReload={()=>{}}/>);
    fireEvent.change(screen.getByLabelText('患者'),{target:{value:'P-001'}});
    expect(onCandidate).toHaveBeenCalledWith('P-001');
    onCandidate.mockClear();
    fireEvent.change(screen.getByLabelText('患者'),{target:{value:''}});
    expect(onCandidate).not.toHaveBeenCalled();
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
