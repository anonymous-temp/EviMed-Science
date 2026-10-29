import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { useProjectStore } from "@/lib/projects";
import { useToastStore } from "@/lib/toast";
import { useOpenGeoConversation, type GeoConversationTarget } from "./useOpenGeoConversation";

const mocks=vi.hoisted(()=>({open:vi.fn(),list:vi.fn()}));
vi.mock("@/lib/geoNativeClient",()=>({openGeoConversation:mocks.open}));
vi.mock("@/lib/geoClient",async original=>({...await original<typeof import("@/lib/geoClient")>(),listGeoProjects:mocks.list}));
vi.mock("@/lib/runtimeWarm",()=>({warmWebRuntime:vi.fn()}));

function Opener({target,draft}:{target:GeoConversationTarget;draft?:string}) {
  const open=useOpenGeoConversation(),location=useLocation();
  const [result,setResult]=useState("");
  return <><button type="button" onClick={()=>{void open(target,draft).then(value=>setResult(String(value)));}}>open</button>
    <pre data-testid="location">{JSON.stringify({path:location.pathname,search:location.search,intent:location.state?.runtimeUiIntent})}</pre><span data-testid="result">{result}</span></>;
}
const target={geoId:"geo-owned",projectId:"same-id",sessionId:null};
const descriptor=(sessionId="native-root")=>({projectId:"same-id",projectName:"Shared project",sessionId,scope:{kind:"geo",geoProjectId:"geo-owned",sessionId}});
const current=()=>JSON.parse(screen.getByTestId("location").textContent!);
function setup(value:GeoConversationTarget=target,draft?:string,initial="/app/geo/geo-owned/overview") {
  render(<MemoryRouter initialEntries={[initial]}><Opener target={value} draft={draft}/></MemoryRouter>);
}
beforeEach(()=>{vi.clearAllMocks();useProjectStore.setState({currentId:"default",projects:[{id:"same-id",name:"Personal project"}],switching:null});useToastStore.setState({toasts:[]});mocks.open.mockImplementation(async(_geoId,selected)=>descriptor(selected.sessionId??"native-root"));mocks.list.mockResolvedValue([{id:"geo-owned",projectId:"same-id"}]);});
afterEach(()=>useProjectStore.getState().clear());

describe("opening the exact GEO native descriptor",()=>{
  it("keeps actor project selection while opening owner scope with an unsent draft",async()=>{
    setup(target,"Preserve the denominator");await userEvent.click(screen.getByRole("button",{name:"open"}));
    await waitFor(()=>expect(current().path).toBe("/app/geo/geo-owned/chat/native-root"));
    expect(mocks.open).toHaveBeenCalledWith("geo-owned",{kind:"primary"});
    expect(current().intent).toMatchObject({kind:"open",projectId:"same-id",sessionId:"native-root",draft:"Preserve the denominator",scope:descriptor().scope});
    expect(useProjectStore.getState().currentId).toBe("default");
  });
  it("resumes the exact handling session despite another session in the URL",async()=>{
    setup({...target,sessionId:"historical",exactSession:true},undefined,"/app/geo/geo-owned/overview?session=other");
    await userEvent.click(screen.getByRole("button",{name:"open"}));
    await waitFor(()=>expect(current().path).toBe("/app/geo/geo-owned/chat/historical"));
    expect(mocks.open).toHaveBeenCalledWith("geo-owned",{kind:"session",sessionId:"historical"});
  });
  it("opens the project's own conversation as the primary, so a kernel that lost it is repaired rather than refused, and accepts the session that stands",async()=>{
    mocks.open.mockImplementation(async()=>descriptor("replacement-root"));
    setup({...target,sessionId:"dead-root",primarySessionId:"dead-root"},undefined,"/app/geo/geo-owned/overview?session=dead-root");
    await userEvent.click(screen.getByRole("button",{name:"open"}));
    await waitFor(()=>expect(current().path).toBe("/app/geo/geo-owned/chat/replacement-root"));
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledWith("geo-owned",{kind:"primary"});
    expect(current().intent).toMatchObject({kind:"open",sessionId:"replacement-root"});
  });
  it("opens the project's own conversation as the primary when only the page holds it",async()=>{
    setup({...target,sessionId:"native-root",primarySessionId:"native-root"});
    await userEvent.click(screen.getByRole("button",{name:"open"}));
    await waitFor(()=>expect(current().path).toBe("/app/geo/geo-owned/chat/native-root"));
    expect(mocks.open).toHaveBeenCalledWith("geo-owned",{kind:"primary"});
  });
  it("keeps an addressed conversation exact beside a project primary, and refuses it when the server answers another",async()=>{
    setup({...target,sessionId:"historical",primarySessionId:"native-root"},undefined,"/app/geo/geo-owned/overview?session=other");
    await userEvent.click(screen.getByRole("button",{name:"open"}));
    await waitFor(()=>expect(current().path).toBe("/app/geo/geo-owned/chat/other"));
    expect(mocks.open).toHaveBeenCalledWith("geo-owned",{kind:"session",sessionId:"other"});
    mocks.open.mockResolvedValueOnce(descriptor("swapped"));
    await userEvent.click(screen.getByRole("button",{name:"open"}));
    await waitFor(()=>expect(screen.getByTestId("result")).toHaveTextContent("false"));
  });
  it("never turns a versioned handling attempt or a planning reference into the primary open",async()=>{
    const geoPlanContext={referenceId:`gpc_${"a".repeat(64)}`};
    setup({...target,sessionId:"native-root",primarySessionId:"native-root",geoPlanContext});
    await userEvent.click(screen.getByRole("button",{name:"open"}));
    await waitFor(()=>expect(current().path).toBe("/app/geo/geo-owned/chat/native-root"));
    expect(mocks.open).toHaveBeenCalledWith("geo-owned",{kind:"session",sessionId:"native-root"});
  });
  it("preserves selected planning and result references until native submission",async()=>{
    const geoPlanContext={referenceId:`gpc_${"a".repeat(64)}`},resultRevision={referenceId:`rr_${"b".repeat(64)}`};
    setup({...target,sessionId:"historical",geoPlanContext,resultRevision},"Review this article");
    await userEvent.click(screen.getByRole("button",{name:"open"}));
    await waitFor(()=>expect(current().intent).toMatchObject({kind:"open",geoPlanContext,resultRevision,draft:"Review this article"}));
  });
  it("shows a failed exact target and never creates a replacement",async()=>{
    mocks.open.mockRejectedValue(new Error("Historical session unavailable"));setup({...target,sessionId:"historical",exactSession:true});
    await userEvent.click(screen.getByRole("button",{name:"open"}));await waitFor(()=>expect(screen.getByTestId("result")).toHaveTextContent("false"));
    expect(current().path).toBe("/app/geo/geo-owned/overview");expect(mocks.open).toHaveBeenCalledTimes(1);expect(useToastStore.getState().toasts).toHaveLength(1);
  });
  it("refuses a returned session or project that differs from the selected target",async()=>{
    mocks.open.mockResolvedValue({...descriptor(),projectId:"foreign"});setup({...target,sessionId:"historical",exactSession:true});
    await userEvent.click(screen.getByRole("button",{name:"open"}));await waitFor(()=>expect(screen.getByTestId("result")).toHaveTextContent("false"));
    expect(current().intent).toBeUndefined();
  });
  it("discards a descriptor that arrives after a newer request",async()=>{
    let first:(value:ReturnType<typeof descriptor>)=>void=()=>{};
    mocks.open.mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;})).mockResolvedValueOnce(descriptor("new-root"));setup();
    await userEvent.click(screen.getByRole("button",{name:"open"}));await userEvent.click(screen.getByRole("button",{name:"open"}));
    await waitFor(()=>expect(current().path).toBe("/app/geo/geo-owned/chat/new-root"));first(descriptor("old-root"));
    await waitFor(()=>expect(current().path).toBe("/app/geo/geo-owned/chat/new-root"));
  });
});

it("never substitutes the URL session for an unavailable exact handling root",async()=>{
  setup({...target,sessionId:null,exactSession:true},undefined,"/app/geo/geo-owned/overview?session=other");
  await userEvent.click(screen.getByRole("button",{name:"open"}));
  await waitFor(()=>expect(screen.getByTestId("result")).toHaveTextContent("false"));
  expect(mocks.open).not.toHaveBeenCalled();expect(current().intent).toBeUndefined();
});
