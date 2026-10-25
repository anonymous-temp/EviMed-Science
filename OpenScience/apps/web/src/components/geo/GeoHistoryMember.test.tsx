import {render,screen,fireEvent,within} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {expect,it,vi} from "vitest";
import {GeoHistoryMember} from "./GeoHistoryMember";

it("shows task completion and current unresolved clinical issue separately with exact safe routes",()=>{
 const open=vi.fn();
 render(<MemoryRouter initialEntries={["/app/geo/g/actions?step=distribution&order=stale&publication=stale&signal=old&round=old&session=conversation"]}><GeoHistoryMember geoId="g" selectionRef="gsel_exact" openPublication={open}
  item={{id:"event",kind:"task_attempt",eventLabel:"处理任务",at:"2026-10-02",currentStatus:"open",currentExecutionState:"completed",signalId:"signal",errorId:"error",fingerprint:"exact-fingerprint",resultVersionId:"old-version",digest:"old-digest",linkId:"actual-link"}}/></MemoryRouter>);
 expect(screen.getByText("待处理")).toBeVisible();expect(screen.getByText("任务完成")).toBeVisible();
 const url=new URL(screen.getByRole("link",{name:"查看登记发布的版本历史"}).getAttribute("href")!,"https://local.invalid");
 expect(url.searchParams.get("publication")).toBe("actual-link");expect(url.searchParams.get("selectionRef")).toBe("gsel_exact");expect(url.searchParams.get("session")).toBe("conversation");
 for(const key of ["order","signal","round"])expect(url.searchParams.has(key)).toBe(false);
 fireEvent.click(screen.getByRole("button",{name:"打开事件关联的内容版本"}));expect(open).toHaveBeenCalledWith("old-version","old-digest");
});

it("pages immutable before and after answers locally and resets when their preserved identity changes",()=>{
 const before=Array.from({length:21},(_,index)=>({snapshotId:"old-"+index,preservedQuestion:{text:"Original "+index},preservedAnswer:{text:"Preserved old answer "+index}}));
 const props={geoId:"g",item:{id:"group",basisDigest:"first",cohorts:{before,after:[{snapshotId:"new",preservedQuestion:{text:"New question"},preservedAnswer:{text:"Actual new answer"}}]}}};
 const shown=render(<MemoryRouter><GeoHistoryMember {...props}/></MemoryRouter>);
 fireEvent.click(screen.getByRole("button",{name:"变化前保留的样本下一页"}));
 const old=screen.getByRole("region",{name:"变化前保留的样本"});expect(within(old).getByText("Original 20")).toBeVisible();fireEvent.click(within(old).getByText("Original 20"));expect(within(old).getByText("Preserved old answer 20")).toBeVisible();
 shown.rerender(<MemoryRouter><GeoHistoryMember {...props} item={{...props.item,basisDigest:"replacement"}}/></MemoryRouter>);
 expect(screen.getByText("Original 0")).toBeVisible();expect(screen.queryByText("Original 20")).toBeNull();expect(screen.getByText("New question")).toBeVisible();
});

it("shows actual before and after sampling agreements without claiming the exact setting-change instant",()=>{
 render(<MemoryRouter><GeoHistoryMember geoId="g" selectionRef="gsel_exact" item={{id:"mode",kind:"sampling_mode_changed",eventLabel:"完成轮次的采样约定变化",at:"2026-10-04T00:00:00Z",before:"web",after:"web",beforeContract:{samplingMode:"one_shot",repeats:1,engines:["deepseek"]},afterContract:{samplingMode:"recurring",repeats:3,engines:["deepseek"]},roundId:"exact-round"}}/></MemoryRouter>);
 expect(screen.getByText(/单次采样 · 每题 1 次/)).toBeVisible();expect(screen.getByText(/重复采样 · 每题 3 次/)).toBeVisible();
 // The event is worded as the completed round's agreement, never as a switch with an instant.
 expect(screen.getByText("完成轮次的采样约定变化")).toBeVisible();expect(screen.queryByText(/切换.*时刻/)).toBeNull();
 expect(screen.getByRole("link",{name:"查看本轮采集设置与记录"})).toHaveAttribute("href",expect.stringContaining("diagnosisRound=exact-round"));
});

it("links a separately paged historical sample to its original side selection and displays the preserved answer",()=>{
 render(<MemoryRouter initialEntries={["/app/geo/g/overview?round=current&selectionRef=gsel_current&session=kept"]}><GeoHistoryMember geoId="g" selectionRef="gsel_current"
  item={{id:"ref",unit:"history_answer_refs",side:"before",snapshotId:"original-answer",preservedSelectionRef:"gsel_before",preservedQuestion:{text:"Original wording"},preservedAnswer:{text:"Original retained answer"}}}/></MemoryRouter>);
 fireEvent.click(screen.getByText("Original wording"));expect(screen.getByText("Original retained answer")).toBeVisible();
 const href=new URL(screen.getByRole("link",{name:"查看这次观察的原始回答"}).getAttribute("href")!,"https://local.invalid");
 expect(href.searchParams.get("selectionRef")).toBe("gsel_before");expect(href.searchParams.get("session")).toBe("kept");expect(href.searchParams.has("round")).toBe(false);
});

it('question-set events expose and navigate their preserved exact question-set version',()=>{
 const item={id:'question-set:7:locked',unit:'business_events',kind:'question_set_locked',eventLabel:'问题集锁定',at:'2026-10-02T00:00:00Z',questionVersion:7};
 render(<MemoryRouter initialEntries={['/app/geo/g/overview?selectionRef=gsel_current&questionVersion=10&round=current&diagnosisRound=stale&session=kept']}><GeoHistoryMember geoId='g' selectionRef='gsel_selected' item={item}/></MemoryRouter>);
 const links=screen.getAllByRole('link');
 expect(links.some(link=>new URL(link.getAttribute('href')!,'https://local.invalid').searchParams.get('questionVersion')==='7')).toBe(true);
 const target=new URL(links[0].getAttribute('href')!,'https://local.invalid');
 expect(target.searchParams.get('session')).toBe('kept');
 for(const name of ['selectionRef','round','diagnosisRound'])expect(target.searchParams.has(name)).toBe(false);
});

it('a historical judgment member exposes its original receipt kind and assessment versions separately from current state',()=>{
 const item={id:'judgment',unit:'business_events',kind:'judgment_changed',eventLabel:'判定变更',at:'2026-10-02T00:00:00Z',currentJudgmentState:'active',errorId:'issue',receipt:{kind:'assessment_correction',snapshotId:'answer',previousAssessmentVersion:'old-assessment-7',assessmentVersion:'corrected-assessment-8',claimId:'claim',claimVersion:3,changedAt:'2026-10-02T00:00:00Z'}};
 const {container}=render(<MemoryRouter><GeoHistoryMember geoId='g' selectionRef='gsel_selected' item={item}/></MemoryRouter>);
 expect(container).toHaveTextContent('old-assessment-7');
 expect(container).toHaveTextContent('corrected-assessment-8');
});

for(const kind of ['question_set_created','question_set_locked'])it('keeps the addressed native session for '+kind+' rather than a stale session query',()=>{
 render(<MemoryRouter initialEntries={['/app/geo/g/chat/native-session?session=wrong-session&selectionRef=gsel_old&questionVersion=10&round=old']}><GeoHistoryMember geoId="g" selectionRef="gsel_old" item={{id:'set',kind,questionVersion:7}}/></MemoryRouter>);
 const target=new URL(screen.getByRole('link',{name:'查看事件关联的问题集版本'}).getAttribute('href')!,'https://local.invalid');
 expect(target.searchParams.get('session')).toBe('native-session');expect(target.searchParams.get('questionVersion')).toBe('7');
 for(const key of ['selectionRef','round'])expect(target.searchParams.has(key)).toBe(false);
});
