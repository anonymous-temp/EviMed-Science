import { useMemo, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useNavigate, useLocation } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestProjectExit, useUnsavedGuard } from "@/lib/useUnsavedGuard";
import { UnsavedRouteGuard } from "./UnsavedRouteGuard";

const NativeRequest = globalThis.Request;
beforeAll(() => {
  globalThis.Request = class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init ? { ...init, signal: undefined } : init);
    }
  };
});
afterAll(() => { globalThis.Request = NativeRequest; });

function Editor() {
  const guard = useUnsavedGuard(true, () => undefined);
  const navigate = useNavigate();
  return <><UnsavedRouteGuard /><h1>Draft</h1><button onClick={() => { guard.markSaved(); void navigate("/next"); }}>Save and open</button><button onClick={guard.requestClose}>Close draft</button>{guard.confirming && <div role="alertdialog">Local discard confirmation</div>}</>;
}

describe("host dirty navigation", () => {
  it("keeps the draft until a blocked route is explicitly discarded", async () => {
    const router = createMemoryRouter([{ path: "/edit", element: <Editor /> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/edit"] });
    render(<RouterProvider router={router} />);
    await act(() => router.navigate("/next"));
    expect(router.state.location.pathname).toBe("/edit");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("heading", { name: "Draft" })).toBeInTheDocument();
    await act(() => router.navigate("/next"));
    fireEvent.click(screen.getByRole("button", { name: "放弃修改并离开" }));
    expect(await screen.findByRole("heading", { name: "Next" })).toBeInTheDocument();
  });
  it("keeps an existing local discard confirmation as the only confirmation", async () => {
    const router = createMemoryRouter([{ path: "/edit", element: <Editor /> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/edit"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole("button", { name: "Close draft" }));
    await act(() => router.navigate("/next"));
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(router.state.location.pathname).toBe("/edit");
  });
  it("allows a confirmed save to navigate in the same event without an old dirty closure blocking it", async () => {
    const router = createMemoryRouter([{ path: "/edit", element: <Editor /> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/edit"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole("button", { name: "Save and open" }));
    expect(await screen.findByRole("heading", { name: "Next" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  it("acknowledges only the saved draft and keeps an unrelated draft protected", async () => {
    function OtherDraft() { useUnsavedGuard(true, () => undefined); return null; }
    const router = createMemoryRouter([{ path: "/edit", element: <><Editor /><OtherDraft /></> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/edit"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole("button", { name: "Save and open" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/edit");
  });
});

// Review R1 P2-6: a save that hangs made the dialog undismissable (取消 disabled, Escape and the backdrop dead), which trapped every
// route change, browser Back included, until the request settled. Only leaving has to wait for the save.
it("lets the reader cancel a route change while a save is still pending, and makes only leaving wait", async () => {
  function Saving() { useUnsavedGuard(true, () => undefined, true); return <UnsavedRouteGuard />; }
  const router = createMemoryRouter([{ path: "/edit", element: <Saving /> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/edit"] });
  render(<RouterProvider router={router} />);
  await act(() => router.navigate("/next"));
  const dialog = await screen.findByRole("alertdialog");
  expect(screen.getByRole("button", { name: "放弃修改并离开" })).toHaveAttribute("aria-busy", "true");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(dialog).not.toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/edit");
  await act(() => router.navigate("/next"));
  const second = await screen.findByRole("alertdialog");
  expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
  fireEvent.click(second.parentElement!);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

it("mounts route confirmation outside an inert dialog host and preserves its draft on Cancel", async () => {
  function DialogEditor() {
    useUnsavedGuard(true, () => undefined);
    return <div inert><UnsavedRouteGuard /><div role="dialog" aria-label="Draft dialog"><input aria-label="Draft input" defaultValue="Unsaved draft" /></div></div>;
  }
  const router = createMemoryRouter([{ path: "/edit", element: <DialogEditor /> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/edit"] });
  render(<RouterProvider router={router} />);
  await act(() => router.navigate("/next"));
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.closest("[inert]")).toBeNull();
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(router.state.location.pathname).toBe("/edit");
  expect(screen.getByRole("textbox", { name: "Draft input" })).toHaveValue("Unsaved draft");
  await act(() => router.navigate("/next"));
  fireEvent.click(screen.getByRole("button", { name: "放弃修改并离开" }));
  expect(await screen.findByRole("heading", { name: "Next" })).toBeInTheDocument();
});


function ModeEditor({ finishSave }: {finishSave?: () => Promise<void>}) {
  const [text, setText] = useState('Original draft'), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false);
  const navigate = useNavigate(), location = useLocation();
  const options = useMemo(() => ({ samePathChange: (from: string, to: string) => new URLSearchParams(from).get('analysis') !== new URLSearchParams(to).get('analysis'), onRouteDiscard: () => {setText('');setSaved(true);} }), []);
  const guard = useUnsavedGuard(!saved, () => undefined, busy, options);
  return <><UnsavedRouteGuard /><input aria-label="Original rows" value={text} onChange={event=>setText(event.target.value)} /><output>{location.search}</output>
    <button onClick={()=>void navigate('/mode?questionMode=import&analysis=V26')}>Analysis mode</button>
    <button onClick={()=>void navigate('/mode?questionMode=import&sourceSearch=filter')}>Filter query</button>
    <button onClick={()=>{setBusy(true);void (finishSave?.()??Promise.resolve()).then(()=>{guard.markSaved();setSaved(true);setBusy(false);});}}>Save draft</button></>;
}
function modeRouter(finishSave?:()=>Promise<void>) { return createMemoryRouter([{path:'/mode',element:<ModeEditor finishSave={finishSave}/>}], {initialEntries:['/mode?questionMode=import&analysis=V26','/mode?questionMode=import'],initialIndex:1}); }

it('guards same-path mode exits, keeps ordinary filters working and restores input focus on cancel',async()=>{
 const router=modeRouter();render(<RouterProvider router={router}/>);
 const input=screen.getByRole('textbox',{name:'Original rows'});input.focus();fireEvent.change(input,{target:{value:'Valuable rows'}});
 fireEvent.click(screen.getByRole('button',{name:'Filter query'}));
 expect(router.state.location.search).toContain('sourceSearch=filter');expect(screen.queryByRole('alertdialog')).toBeNull();
 input.focus();await act(()=>router.navigate('/mode?questionMode=import&analysis=V26'));
 fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(input).toHaveValue('Valuable rows');expect(input).toHaveFocus();
 await act(()=>router.navigate('/mode?questionMode=import&analysis=V26'));
 fireEvent.click(screen.getByRole('button',{name:'放弃修改并离开'}));
 await waitFor(()=>expect(router.state.location.search).toContain('analysis=V26'));
 expect(input).toHaveValue('');
});

it('blocks back and forward mode transitions and preserves the draft when either is cancelled',async()=>{
 const router=createMemoryRouter([{path:'/mode',element:<ModeEditor/>}],{initialEntries:['/mode?analysis=V01','/mode?questionMode=import','/mode?analysis=V26'],initialIndex:1});
 render(<RouterProvider router={router}/>);
 for(const direction of [-1,1]) {
   await act(()=>router.navigate(direction));expect(screen.getByRole('alertdialog')).toBeVisible();
   fireEvent.click(screen.getByRole('button',{name:'取消'}));
   expect(router.state.location.search).toBe('?questionMode=import');
   expect(screen.getByRole('textbox',{name:'Original rows'})).toHaveValue('Original draft');
 }
});

it('keeps an asynchronous save protected and allows a mode transition after saving',async()=>{
 let finish!:()=>void;const saving=new Promise<void>(resolve=>{finish=resolve;});
 const router=modeRouter(()=>saving);render(<RouterProvider router={router}/>);
 fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
 fireEvent.click(screen.getByRole('button',{name:'Analysis mode'}));
 expect(screen.getByRole('button',{name:'放弃修改并离开'})).toHaveAttribute('aria-disabled','true');
 expect(router.state.location.search).not.toContain('analysis=');
 await act(async()=>{finish();await saving;});
 fireEvent.click(screen.getByRole('button',{name:'取消'}));
 fireEvent.click(screen.getByRole('button',{name:'Analysis mode'}));
 await waitFor(()=>expect(router.state.location.search).toContain('analysis=V26'));
 expect(screen.queryByRole('alertdialog')).toBeNull();expect(screen.getByRole('textbox',{name:'Original rows'})).toHaveValue('Original draft');
});


// A guard that exists only because a request is running holds nothing unsaved: its dialog says so, can be dismissed, and leaving is
// the person's call (a request cannot be undone by staying, and a long one must not hold the whole app).
describe("a request that is running while nothing is unsaved", () => {
  function Requesting() { const [running, setRunning] = useState(true); useUnsavedGuard(false, () => undefined, running); return <><UnsavedRouteGuard /><h1>Working</h1><button onClick={() => setRunning(false)}>Request settles</button></>; }
  const routed = () => createMemoryRouter([{ path: "/work", element: <Requesting /> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/work"] });

  it("says a request is running, not that changes are unsaved, and lets the person stay or leave", async () => {
    const router = routed(); render(<RouterProvider router={router} />);
    await act(() => router.navigate("/next"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("页面还在处理请求");
    expect(dialog).not.toHaveTextContent("未保存");
    expect(screen.getByRole("button", { name: "仍然离开" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "仍然离开" })).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/work");
    await act(() => router.navigate("/next"));
    fireEvent.click(await screen.findByRole("button", { name: "仍然离开" }));
    expect(await screen.findByRole("heading", { name: "Next" })).toBeInTheDocument();
  });

  it("stays the same kind of dialog when the request settles under it, and still lets the person leave", async () => {
    const router = routed(); render(<RouterProvider router={router} />);
    await act(() => router.navigate("/next"));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Request settles" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toHaveTextContent("页面还在处理请求"));
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent("未保存");
    fireEvent.click(screen.getByRole("button", { name: "仍然离开" }));
    expect(await screen.findByRole("heading", { name: "Next" })).toBeInTheDocument();
  });

  it("asks the same plain question before a project switch, and the switch goes ahead when the person agrees", async () => {
    const router = routed(); render(<RouterProvider router={router} />);
    let answer!: Promise<boolean>;
    await act(async () => { answer = requestProjectExit(); });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("页面还在处理请求");
    expect(dialog).not.toHaveTextContent("放弃未保存");
    fireEvent.click(screen.getByRole("button", { name: "仍然切换" }));
    await expect(answer).resolves.toBe(true);
    await act(async () => { answer = requestProjectExit(); });
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await expect(answer).resolves.toBe(false);
  });

  it("still makes leaving wait for a save that runs over unsaved work", async () => {
    function Saving() { useUnsavedGuard(true, () => undefined, true); return <UnsavedRouteGuard />; }
    const router = createMemoryRouter([{ path: "/edit", element: <Saving /> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/edit"] });
    render(<RouterProvider router={router} />);
    await act(() => router.navigate("/next"));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("未保存");
    expect(screen.getByRole("button", { name: "放弃修改并离开" })).toHaveAttribute("aria-busy", "true");
  });
});
