import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClinicalTimeline, useMatchingControls } from './ClinicalMatchingDetails';
import { Toolbar } from '@/components/ui/Toolbar';
import { VcrToolbarActions } from './VcrToolbarActions';
import { CloudDocuments, reviewedSpans } from './data/CloudDocuments';
import type { VcrIntakeSource, VcrMatchingTab } from '@/lib/vcrClient';
import { WebApiError } from '@/lib/apiClient';
const api = vi.hoisted(() => ({ enqueue:vi.fn(),quote:vi.fn(),permission:vi.fn(),document:vi.fn(),projection:vi.fn(),retire:vi.fn() }));
vi.mock('@/lib/vcrClient',()=>({enqueueVcrMatching:api.enqueue,resolveVcrQuote:api.quote,setVcrCloudPermission:api.permission,getVcrProtectedDocument:api.document,createVcrProjection:api.projection,retireVcrProjection:api.retire}));
beforeEach(()=>vi.clearAllMocks());

/**
 * The matching tab's controls as the tab draws them (R19): the hook's filters and actions in the band's one row, its notes and its
 * folded comparison at the top of the body. Nothing here is a row of the controls' own.
 */
type ControlsProps = Parameters<typeof useMatchingControls>[0];
function Controls(props: Partial<ControlsProps> & { data: VcrMatchingTab | null }) {
  const controls = useMatchingControls({ studyId: 's1', canRun: true, onProtocol: () => {}, onCandidate: () => {}, onReload: () => {}, ...props });
  if (!controls) return null;
  return <>
    <Toolbar filters={controls.filters} actions={<VcrToolbarActions actions={controls.actions} />} />
    {controls.notes}
    {controls.compare}
  </>;
}
/** A chip that opens a menu, opened, and one of its items pressed. */
const choose = async (chip: string | RegExp, item: string | RegExp) => {
  await userEvent.click(screen.getByRole('button', { name: chip }));
  await userEvent.click(await screen.findByRole('menuitemradio', { name: item }));
};


describe('evaluating from the controls',()=>{
  const page=(extra:Record<string,unknown>={})=>({protocols:[{id:'p1',version:1,title:'方案一'},{id:'p2',version:2,title:'方案二'}],protocolVersionId:'p2',direction:'trial_to_patient',candidateRoster:['P-001'],...extra}) as unknown as VcrMatchingTab;
  const controls=(data=page(),extra:Partial<ControlsProps>={})=>render(<Controls data={data} {...extra}/>);
  // Review V-M5: 开始评估所选方案 and 刷新结果 were inside 比较多个方案, so running one protocol meant finding a section named "compare several".
  it('starts the protocol in view without opening 比较多个方案 — and there is no 刷新结果: the page reads itself when the job moves',async()=>{
    api.enqueue.mockResolvedValue({jobs:[{jobId:'job',state:'queued'}],unavailable:[]});
    controls();
    const start=screen.getByRole('button',{name:'开始评估'});
    expect(start.closest('details')).toBeNull();
    expect(screen.queryByRole('button',{name:'刷新结果'})).toBeNull();
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
  it('runs the protocol the reader chose, for the patient the reader chose, in the direction the reader chose — and offers no run until there is a patient to run it for',async()=>{
    api.enqueue.mockResolvedValue({jobs:[{jobId:'job',state:'queued'}],unavailable:[]});
    controls(page({direction:'trial_to_patient'}),{direction:'patient_to_trial',protocolId:'p1'});
    // 给患者找试验 starts from a person: with none chosen there is no button that would be grey — the patient's chip is the way to one.
    expect(screen.queryByRole('button',{name:'开始评估'})).toBeNull();
    await choose('患者','P-001');
    const start=await screen.findByRole('button',{name:'开始评估'});
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(()=>expect(api.enqueue).toHaveBeenCalledWith('s1',{protocolVersionIds:['p1'],subjectKeys:['P-001'],direction:'patient_to_trial'}));
  });
  it('shows the protocol in view in the band, and tells the page which one the reader chose',async()=>{
    const onProtocol=vi.fn();
    controls(page(),{onProtocol});
    expect(screen.getByRole('button',{name:'查看方案：方案二'})).toBeVisible();
    await choose(/^查看方案/,'方案一');
    expect(onProtocol).toHaveBeenCalledWith('p1');
  });
  // Per-source reprocessing (E-13): what an evaluation rested on has changed, so the page says so and offers the evaluation that exists.
  it('says how many evaluations rest on a basis that has changed, and evaluates those people again with the existing trigger',async()=>{
    api.enqueue.mockResolvedValue({jobs:[{jobId:'job',state:'queued'}],unavailable:[]});
    controls(page({basisUpdated:{count:2,subjects:['P-001','P-002']}}));
    expect(screen.getByText('2 人的评估依据已更新')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'重新评估'}));
    await waitFor(()=>expect(api.enqueue).toHaveBeenCalledWith('s1',{protocolVersionIds:['p2'],subjectKeys:['P-001','P-002'],direction:'trial_to_patient'}));
    expect(await screen.findByText('已提交 1 项评估。')).toBeVisible();
  });
  it('says nothing about a basis when nothing changed, and offers the evaluation only to a reader who may run it',()=>{
    controls();
    expect(screen.queryByText(/评估依据已更新/)).toBeNull();
    expect(screen.queryByRole('button',{name:'重新评估'})).toBeNull();
    document.body.innerHTML='';
    controls(page({basisUpdated:{count:1,subjects:['P-001']}}),{canRun:false});
    expect(document.body).toHaveTextContent('1 人的评估依据已更新');
    expect(screen.queryByRole('button',{name:'重新评估'})).toBeNull();
  });
  it('offers no run to a reader who may not run it, and no refresh either',()=>{
    controls(page(),{canRun:false});
    expect(screen.queryByRole('button',{name:'开始评估'})).toBeNull();
    expect(screen.queryByRole('button',{name:'刷新结果'})).toBeNull();
  });
  it('says how much of the selection has been evaluated as one sentence whose figures are numbers',()=>{
    controls(page({candidateCoverage:{requested:12,evaluated:8,pending:3,unavailable:1}}));
    expect(document.body).toHaveTextContent('本次选择 12 人 · 已评估 8 人 · 待评估 3 人 · 暂不可用 1 人');
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

describe('the identifiers the server suggests to the reviewer',()=>{
  const TEXT='患者张三，电话 13812345678，出生日期 1980-02-29，入院 2026-10-01。';
  const at=(value:string)=>({start:TEXT.indexOf(value),end:TEXT.indexOf(value)+value.length});
  const suggestions=()=>[{...at('13812345678'),format:'mobile',kind:'contact'},{...at('1980-02-29'),format:'date',kind:'date',birth:true},{...at('2026-10-01'),format:'date',kind:'date'}];
  const source=()=>({id:'src',files:[{id:'doc1',name:'病历.txt',role:'document'}],upload:{cloudDestinations:['https://api.example.org']},
    cloudPermission:{status:'approved',reference:'合作协议 2026-09',expiresAt:'2999-01-01'}}) as unknown as VcrIntakeSource;
  async function open(){
    api.document.mockResolvedValue({document:{id:'doc1',text:TEXT,sourceHash:'h1',suggestions:suggestions()}});
    api.projection.mockResolvedValue({});
    render(<CloudDocuments studyId="s1" source={source()} onChanged={()=>{}}/>);
    fireEvent.click(screen.getByText('病历云端处理 · 已授权'));
    fireEvent.change(screen.getByLabelText('准备脱敏文本'),{target:{value:'doc1'}});
    fireEvent.click(screen.getByRole('button',{name:'打开原文'}));
    await screen.findByLabelText('受保护的原文');
  }
  const preview=()=>screen.getByRole('region',{name:'脱敏后的文本'});

  it('lists them with what each is, applies none until the reviewer accepts it, and shows the text as it will be saved',async()=>{
    await open();
    const list=screen.getByRole('list',{name:'建议遮蔽'});
    const [phone,birth,admitted]=within(list).getAllByRole('listitem');
    expect(phone).toHaveTextContent('手机号');expect(phone).toHaveTextContent('13812345678');
    expect(birth).toHaveTextContent('出生日期');expect(birth).toHaveTextContent('1980-02-29');
    expect(admitted).toHaveTextContent('日期');expect(admitted).not.toHaveTextContent('出生日期');
    expect(screen.getByText('建议遮蔽 · 3 处')).toBeVisible();
    // Nothing is applied: the text is whole, and no span is counted.
    expect(screen.getByText(/共 0 处将被替换/)).toBeVisible();
    expect(preview()).toHaveTextContent('13812345678');
    expect(within(preview()).queryAllByText('已遮蔽')).toHaveLength(0);
    fireEvent.click(within(phone).getByRole('button',{name:'接受 13812345678'}));
    expect(preview()).not.toHaveTextContent('13812345678');
    expect(preview()).toHaveTextContent('1980-02-29');
    expect(within(preview()).getAllByText('已遮蔽')).toHaveLength(1);
    expect(screen.getByText(/共 1 处将被替换/)).toBeVisible();
    // Taking one back puts the text back.
    fireEvent.click(within(phone).getByRole('button',{name:'取消接受 13812345678'}));
    expect(preview()).toHaveTextContent('13812345678');
    expect(screen.getByText(/共 0 处将被替换/)).toBeVisible();
  });
  it('accepting asks for the full-text check again, and saves each accepted span as the kind the server named',async()=>{
    await open();
    fireEvent.click(screen.getByRole('button',{name:'全部接受'}));
    expect(screen.queryByRole('button',{name:'全部接受'})).toBeNull();
    expect(screen.getByText(/共 3 处将被替换/)).toBeVisible();
    const save=screen.getByRole('button',{name:'保存脱敏文本'});
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox',{name:/已检查脱敏后的全文/}));
    // Accepting one less is a change to the text, which has to be read again.
    fireEvent.click(screen.getByRole('button',{name:'取消接受 2026-10-01'}));
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox',{name:/已检查脱敏后的全文/}));
    fireEvent.click(save);
    await waitFor(()=>expect(api.projection).toHaveBeenCalledWith('s1','doc1',{sourceHash:'h1',attestation:'合作协议 2026-09',
      spans:[{...at('13812345678'),kind:'contact'},{...at('1980-02-29'),kind:'date'}]}));
  });
  it('joins the names the reviewer typed with the suggestions accepted, one span where they overlap',async()=>{
    await open();
    fireEvent.click(screen.getByRole('button',{name:'接受 13812345678'}));
    fireEvent.change(screen.getByLabelText('需替换的姓名、编号或地址（每行一项）'),{target:{value:'张三\n138123'}});
    expect(screen.getByText(/共 2 处将被替换/)).toBeVisible();
    expect(reviewedSpans(TEXT,'张三\n138123',[{...at('13812345678'),kind:'contact'}])).toEqual([
      {start:2,end:4,kind:'identifier'},{...at('13812345678'),kind:'contact'}]);
    expect(reviewedSpans(TEXT,'',[])).toEqual([]);
  });
  it('says nothing about suggestions when the server found none',async()=>{
    api.document.mockResolvedValue({document:{id:'doc1',text:TEXT,sourceHash:'h1'}});
    render(<CloudDocuments studyId="s1" source={source()} onChanged={()=>{}}/>);
    fireEvent.click(screen.getByText('病历云端处理 · 已授权'));
    fireEvent.change(screen.getByLabelText('准备脱敏文本'),{target:{value:'doc1'}});
    fireEvent.click(screen.getByRole('button',{name:'打开原文'}));
    await screen.findByLabelText('受保护的原文');
    expect(screen.queryByRole('list',{name:'建议遮蔽'})).toBeNull();
  });
});

describe('the reviewed texts saved of a record',()=>{
  const source=(projections:unknown[])=>({id:'src',files:[{id:'doc1',name:'病历.txt',role:'document',projections},{id:'doc2',name:'另一份.txt',role:'document'},{id:'gone',name:'已撤回.txt',role:'document',erased:true}],
    upload:{cloudDestinations:['https://api.example.org']},cloud:{state:'allowed',basis:'deployment_agreements'}}) as unknown as VcrIntakeSource;
  it('lists the ones of the chosen record and retires the one that missed an identifier',async()=>{
    api.retire.mockResolvedValue({retired:{projections:1}});
    const changed=vi.fn();
    render(<CloudDocuments studyId="s1" source={source([{id:'prj_a',at:'2026-10-09T08:00:00Z'},{id:'prj_b',at:'2026-10-10T08:00:00Z'}])} onChanged={changed}/>);
    fireEvent.click(screen.getByText('病历云端处理 · 已开放'));
    expect(screen.queryByRole('list',{name:'已保存的脱敏文本'})).toBeNull();
    expect(screen.queryByRole('option',{name:'已撤回.txt'})).toBeNull();
    fireEvent.change(screen.getByLabelText('准备脱敏文本'),{target:{value:'doc1'}});
    const list=screen.getByRole('list',{name:'已保存的脱敏文本'});
    const [first,second]=within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('脱敏文本 1 · 2026-10-09 保存');expect(second).toHaveTextContent('脱敏文本 2 · 2026-10-10 保存');
    fireEvent.click(within(second).getByRole('button',{name:'停用并清除'}));
    await waitFor(()=>expect(api.retire).toHaveBeenCalledWith('s1','prj_b'));
    await waitFor(()=>expect(changed).toHaveBeenCalled());
    expect(await screen.findByText('已停用并清除这份脱敏文本。')).toBeVisible();
    fireEvent.change(screen.getByLabelText('准备脱敏文本'),{target:{value:'doc2'}});
    expect(screen.queryByRole('list',{name:'已保存的脱敏文本'})).toBeNull();
  });
});

describe('where a source stands for the cloud models',()=>{
  const placed=(cloud:Record<string,unknown>|undefined,extra:Record<string,unknown>={})=>({id:'src',files:[{id:'doc1',name:'病历.txt',role:'document'}],
    upload:{cloudDestinations:['https://api.example.org']},cloud,...extra}) as unknown as VcrIntakeSource;
  // The deployment holds the agreements with its model providers (2026-10-10): a source needs no attestation, says so in a word, and can be restricted.
  it('is open under the deployment, with nothing to attest and a way to restrict it',async()=>{
    api.permission.mockResolvedValue({});
    const changed=vi.fn();
    render(<CloudDocuments studyId="s1" source={placed({state:'allowed',basis:'deployment_agreements'})} onChanged={changed}/>);
    fireEvent.click(screen.getByText('病历云端处理 · 已开放'));
    expect(screen.queryByRole('button',{name:'保存云端处理授权'})).toBeNull();
    expect(screen.queryByLabelText('授权依据')).toBeNull();
    expect(screen.getByLabelText('准备脱敏文本')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'限制云端处理'}));
    await waitFor(()=>expect(api.permission).toHaveBeenCalledWith('s1','src',{status:'revoked'}));
    await waitFor(()=>expect(changed).toHaveBeenCalled());
    expect(await screen.findByText('已限制这个数据源的云端处理。')).toBeVisible();
  });
  it('is restricted when an operator revoked it: no text is prepared, and one press brings it back to the deployment',async()=>{
    api.permission.mockResolvedValue({});
    render(<CloudDocuments studyId="s1" source={placed({state:'restricted',basis:null},{cloudPermission:{status:'revoked'}})} onChanged={()=>{}}/>);
    fireEvent.click(screen.getByText('病历云端处理 · 已限制'));
    expect(screen.queryByLabelText('准备脱敏文本')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'恢复云端处理'}));
    await waitFor(()=>expect(api.permission).toHaveBeenCalledWith('s1','src',{status:'default'}));
  });
  it('asks for a recorded permission only where nothing else stands, and takes identifiable records as a class of it',async()=>{
    api.permission.mockResolvedValue({});
    render(<CloudDocuments studyId="s1" source={placed({state:'closed',basis:null})} onChanged={()=>{}}/>);
    fireEvent.click(screen.getByText('病历云端处理 · 未授权'));
    fireEvent.change(screen.getByLabelText('文本来源'),{target:{value:'clinical'}});
    fireEvent.change(screen.getByLabelText('授权依据'),{target:{value:'合作协议 7'}});
    const save=screen.getByRole('button',{name:'保存云端处理授权'});
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox',{name:/已核实服务不保留文本/}));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(()=>expect(api.permission).toHaveBeenCalledWith('s1','src',expect.objectContaining({status:'approved',dataClass:'clinical',retention:'none',training:'disabled',humanReview:'disabled'})));
  });
  it('reads a recorded permission when the server did not say where the source stands',()=>{
    render(<CloudDocuments studyId="s1" source={placed(undefined,{cloudPermission:{status:'revoked'}})} onChanged={()=>{}}/>);
    expect(screen.getByText('病历云端处理 · 已限制')).toBeInTheDocument();
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
  it('says 依据已更新 beside a fact that was read from a basis that has changed',()=>{
    timeline([fact('f1',{basis:'updated'}),fact('f2')]);
    expect(rows()[0]).toHaveTextContent('依据已更新');
    expect(rows()[1]).not.toHaveTextContent('依据已更新');
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
  const controls=(count:number)=>render(<Controls data={{protocols:protocols(count),protocolVersionId:'p1',direction:'trial_to_patient'} as unknown as VcrMatchingTab}/>);
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
    render(<Controls data={data}/>);
    fireEvent.click(screen.getByText('比较多个方案'));
    const button=screen.getByRole('button',{name:'开始评估所选方案'});
    expect(button).toBeDisabled();
    for(const box of within(screen.getByRole('group',{name:'选择方案（最多 10 项）'})).getAllByRole('checkbox'))fireEvent.click(box);
    expect(button).toBeDisabled();
    await choose('患者','P-001');
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
  it('says 患者, once and the same, where the controls ask for the person',async()=>{
    render(<Controls data={{protocols:[{id:'p1',version:1,title:'方案一'}],direction:'patient_to_trial',candidateRoster:['P-001']} as unknown as VcrMatchingTab}/>);
    await userEvent.click(screen.getByRole('button',{name:'患者'}));
    expect(await screen.findByRole('menuitemradio',{name:'请选择患者'})).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/受试者/);
  });
  // 给患者找试验 starts from a person, and a person's trials do not wait on a protocol: a study with patients and no protocol version
  // still offers the patient to start from — and only that, since the protocol's controls have nothing to work on.
  it('offers the patient to start from when the study has no protocol version, in the direction that starts from a patient',()=>{
    const data={protocols:[],candidateRoster:['P-001','P-002'],direction:'patient_to_trial'} as unknown as VcrMatchingTab;
    render(<Controls data={data} direction="patient_to_trial"/>);
    expect(screen.getByRole('button',{name:'患者'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'刷新结果'})).toBeNull();
    expect(screen.queryByRole('button',{name:/^查看方案/})).toBeNull();
    expect(screen.queryByRole('button',{name:'开始评估'})).toBeNull();
    expect(screen.queryByText('比较多个方案')).toBeNull();
  });
  it('draws nothing for a study with no protocol version in the other direction, as before',()=>{
    const data={protocols:[],candidateRoster:['P-001'],direction:'trial_to_patient'} as unknown as VcrMatchingTab;
    const {container}=render(<Controls data={data} direction="trial_to_patient"/>);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows the patient the page keeps, tells the page what was chosen, and says nobody when 请选择患者 is chosen again',async()=>{
    const onCandidate=vi.fn();
    const data={protocols:[{id:'p1',version:1,title:'方案一'}],candidateRoster:['P-001','P-002'],direction:'patient_to_trial'} as unknown as VcrMatchingTab;
    const view=render(<Controls data={data} direction="patient_to_trial" subjectKey="P-001" onCandidate={onCandidate}/>);
    expect(screen.getByRole('button',{name:'患者：P-001'})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'开始评估'})).toBeEnabled();
    await choose('患者：P-001','P-002');
    expect(onCandidate).toHaveBeenLastCalledWith('P-002');
    // The page keeps the patient: the chip follows what the page was given, not what was clicked.
    expect(screen.getByRole('button',{name:'患者：P-001'})).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button',{name:'患者：P-001'}));
    await userEvent.click(await screen.findByRole('menuitemradio',{name:'请选择患者'}));
    expect(onCandidate).toHaveBeenLastCalledWith('');
    view.rerender(<Controls data={data} direction="patient_to_trial" subjectKey={null} onCandidate={onCandidate}/>);
    expect(screen.getByRole('button',{name:'患者'})).toBeInTheDocument();
    // Nobody to run it for: no button, rather than one that is grey.
    expect(screen.queryByRole('button',{name:'开始评估'})).toBeNull();
  });
  it('keeps the choice itself, and says nothing for the placeholder, where the page does not keep the patient',async()=>{
    const onCandidate=vi.fn();
    const data={protocols:[{id:'p1',version:1,title:'方案一'}],candidateRoster:['P-001'],direction:'trial_to_patient'} as unknown as VcrMatchingTab;
    render(<Controls data={data} onCandidate={onCandidate}/>);
    await choose('患者','P-001');
    expect(onCandidate).toHaveBeenCalledWith('P-001');
    onCandidate.mockClear();
    await choose('患者：P-001','全部已登记患者');
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
