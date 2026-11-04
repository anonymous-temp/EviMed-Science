import { sessionOwner } from "@/lib/sessionLifecycle";
import { prepareRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { optionalOpaqueRuntimeUiIntent } from "@/test/runtimeUiIntentAssertions";
import { useEffect, useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, MemoryRouter, useBlocker, useLocation, useNavigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterLink } from "@/components/geo/spine/ClusterLink";
import { geoResultDrawerProps, useGeoDrawerAddress, useGeoSearchChange } from "@/components/geo/spine/drawerParams";
import { AskAi } from "@/components/geo/AskAi";
import { Drawer } from "@/components/ui/Drawer";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormDialog } from "@/components/ui/FormDialog";
import { useToastStore } from "@/lib/toast";
import { WorkspaceSplit } from "./WorkspaceSplit";

const openNative = vi.hoisted(() => vi.fn());
vi.mock("@/lib/geoNativeClient", async (original) => ({
  ...await original<typeof import("@/lib/geoNativeClient")>(),
  openGeoConversation: openNative,
}));

const resultPath = "/app/geo/geo_1/accuracy?error=claim_1";
const target = { projectId: "prj_1", geoId: "geo_1", sessionId: "ses_1" };

function Composer() {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // The native host focuses only when no other shell control owns focus.
    if (document.activeElement === document.body) input.current?.focus();
  }, []);
  return <textarea ref={input} aria-label="会话草稿" />;
}

function Harness({ retainResults = true, settings = false, confirmable = false, independentModal }: { retainResults?: boolean; settings?: boolean; confirmable?: boolean; independentModal?: "confirm" | "form" }) {
  const location = useLocation();
  const navigate = useNavigate();
  const search = new URLSearchParams(location.search);
  const [confirm, setConfirm] = useState(false);
  const [independentOpen, setIndependentOpen] = useState(false);
  const drawer = useGeoDrawerAddress();
  const change = useGeoSearchChange();
  const detail = drawer.error;
  const to = (change: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(change)) {
      if (value === null) next.delete(key); else next.set(key, value);
    }
    return { pathname: location.pathname, search: next.toString() };
  };
  const collapse = to({ conversation: null });
  return <>
    <output aria-label="Committed location">{location.pathname + location.search}</output>
    <output aria-label="Committed state">{JSON.stringify(location.state)}</output>
    <button onClick={() => { void navigate(-1); }}>History back</button>
    {confirmable && <button onClick={() => { void navigate(`${resultPath}&conversation=open`); }}>Open conversation outside drawer</button>}
    <WorkspaceSplit
      open={search.get("conversation") === "open"}
      retainResults={retainResults}
      collapseTo={`${collapse.pathname}?${collapse.search}`}
      {...geoResultDrawerProps(search, location.state, "accuracy", { analysis: false, distribution: false })}
      results={<>
        <button onClick={() => drawer.open({ error: "claim_1" })}>First claim</button>
        <button onClick={() => drawer.open({ error: "claim_2" })}>Second claim</button>
        <button onClick={() => change({ engine: "kimi", selectionRef: "new_scope" })}>Apply filter</button>
        {independentModal && <button onClick={() => setIndependentOpen(true)}>Review independent result</button>}
        {independentOpen && independentModal === "confirm" && <ConfirmDialog title="Independent confirmation" confirmLabel="Apply" onConfirm={() => setIndependentOpen(false)} onCancel={() => setIndependentOpen(false)} />}
        {independentOpen && independentModal === "form" && <FormDialog title="Independent form" onClose={() => setIndependentOpen(false)}><input aria-label="Independent note" /></FormDialog>}
        {detail && <Drawer title="讲错的说法" onClose={drawer.close}>
          <p>{detail}</p>
          <input aria-label="本地备注" defaultValue="" />
          <AskAi project={target} label="让 AI 写纠错稿" draft="Write a draft about the selected claim." />
          {confirmable && <button onClick={() => setConfirm(true)}>Review change</button>}
          {confirm && <ConfirmDialog title="Review this change?" confirmLabel="Apply" onConfirm={() => setConfirm(false)} onCancel={() => setConfirm(false)} />}
        </Drawer>}
      </>}
      conversation={<Composer />}
    />
    {settings && <Drawer title="项目设置" onClose={() => undefined}>Settings outside results</Drawer>}
  </>;
}

const renderAt = (path = resultPath, options?: Parameters<typeof Harness>[0]) =>
  render(<MemoryRouter initialEntries={[path]}><Harness {...options} /></MemoryRouter>);

beforeEach(() => {
  openNative.mockReset().mockResolvedValue({
    projectId: target.projectId, sessionId: target.sessionId,
    scope: { kind: "geo", geoProjectId: target.geoId, sessionId: target.sessionId },
  });
  useToastStore.setState({ toasts: [] });
});
afterEach(() => vi.unstubAllGlobals());

function setViewportWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: width >= 1180 && query === "(min-width: 1180px)" }));
}

describe.each([{ width: 1440, collapse: "收起对话" }, { width: 390, collapse: "回到结果" }])("GEO drawer handoff at $width px", ({ width, collapse }) => {
  it("gives the committed conversation keyboard focus and restores the same drawer and focused control on return", async () => {
    setViewportWidth(width);
    renderAt();
    const user = userEvent.setup();
    const action = screen.getByRole("button", { name: "让 AI 写纠错稿" });
    const drawer = screen.getByRole("dialog", { name: "讲错的说法" });
    const note = screen.getByRole("textbox", { name: "本地备注" });
    await user.type(note, "Still here");

    for (let index = 0; index < 2; index += 1) {
      action.focus();
      await user.keyboard("{Enter}");
      const composer = await screen.findByRole("textbox", { name: "会话草稿" });
      expect(screen.getByLabelText("Committed location")).toHaveTextContent("error=claim_1");
      expect(screen.queryByRole("dialog", { name: "讲错的说法" })).not.toBeInTheDocument();
      expect(drawer).not.toBeVisible();
      expect(composer).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(screen.getByLabelText("Committed location")).toHaveTextContent("error=claim_1");
      await user.tab({ shift: true });
      const collapseLink = screen.getByRole("link", { name: collapse });
      expect(collapseLink).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("dialog", { name: "讲错的说法" })).toBe(drawer);
      expect(note).toHaveValue("Still here");
      expect(action).toHaveFocus();
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "讲错的说法" })).not.toBeInTheDocument();
  });
});

it("keeps the result drawer active and keyboard dismissible when the AI handoff fails", async () => {
  setViewportWidth(1440);
  openNative.mockRejectedValueOnce(new Error("Unavailable"));
  renderAt();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "让 AI 写纠错稿" }));
  await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
  expect(screen.getByRole("dialog", { name: "讲错的说法" })).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "会话草稿" })).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "讲错的说法" })).not.toBeInTheDocument();
});

it("keeps the settings drawer outside retained results in charge of keyboard focus", async () => {
  setViewportWidth(1440);
  renderAt(`${resultPath}&conversation=open`, { settings: true });
  const settings = screen.getByRole("dialog", { name: "项目设置" });
  expect(settings).toHaveFocus();
  expect(screen.queryByRole("dialog", { name: "讲错的说法" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "收起对话" }));
  expect(await screen.findByRole("dialog", { name: "讲错的说法" })).toBeVisible();
  expect(settings).toHaveFocus();
});

it("preserves ordinary drawers in a split that did not opt into retained results", () => {
  setViewportWidth(1440);
  renderAt(`${resultPath}&conversation=open`, { retainResults: false });
  expect(screen.getByRole("dialog", { name: "讲错的说法" })).toHaveFocus();
});


it("does not leave a nested confirmation trapping the conversation or steal its focus during cleanup", async () => {
  setViewportWidth(1440);
  renderAt(resultPath, { confirmable: true });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review change" }));
  expect(screen.getByRole("alertdialog")).toBeVisible();
  // An external route change can arrive while a modal inside the result drawer is focused.
  fireEvent.click(screen.getByRole("button", { name: "Open conversation outside drawer" }));
  const composer = await screen.findByRole("textbox", { name: "会话草稿" });
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(composer).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole("link", { name: "收起对话" })).toHaveFocus();
});


it("shows a newly clicked detail in the same drawer instance while the same wide conversation stays open", async () => {
  setViewportWidth(1440);
  renderAt();
  const user = userEvent.setup();
  const first = screen.getByRole("dialog");
  await user.click(screen.getByRole("button", { name: "让 AI 写纠错稿" }));
  const composer = await screen.findByRole("textbox", { name: "会话草稿" });
  await user.type(composer, "Keep this conversation");
  await user.click(screen.getByRole("button", { name: "Apply filter" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const secondLink = screen.getByRole("button", { name: "Second claim" });
  await user.click(secondLink);
  expect(screen.getByRole("dialog")).toBe(first);
  expect(first).toHaveTextContent("claim_2");
  expect(first).toHaveFocus();
  expect(composer).toHaveValue("Keep this conversation");
  expect(screen.getByLabelText("Committed location")).toHaveTextContent("session=ses_1");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(secondLink).toHaveFocus();
  expect(composer).toBeVisible();
  expect(screen.getByLabelText("Committed location")).toHaveTextContent("conversation=open");
});

it("keeps the results under the narrow conversation cover until returning, then shows a new selection", async () => {
  setViewportWidth(390);
  renderAt();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "让 AI 写纠错稿" }));
  await screen.findByRole("textbox", { name: "会话草稿" });
  expect(screen.queryByRole("button", { name: "Second claim" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "回到结果" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("claim_1");
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Second claim" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("claim_2");
  expect(screen.getByLabelText("Committed location")).toHaveTextContent("session=ses_1");
});

const NativeRequest = globalThis.Request;
beforeAll(() => {
  globalThis.Request = class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init ? { ...init, signal: undefined } : init);
    }
  };
});
afterAll(() => { globalThis.Request = NativeRequest; });

function GuardedHarness() {
  const blocker = useBlocker(({ nextLocation }) => Boolean(nextLocation.state?.geoDrawerSelection));
  return <>
    <Harness />
    {blocker.state === "blocked" && <button onClick={() => blocker.reset()}>Cancel detail navigation</button>}
    {blocker.state === "blocked" && <button onClick={() => blocker.proceed()}>Continue to detail</button>}
  </>;
}

it("waits for a guarded selection to commit and keeps the conversation on cancellation", async () => {
  setViewportWidth(1440);
  const intent = prepareRuntimeUiIntent({ kind: "open", projectId: target.projectId, sessionId: target.sessionId, requestId: "guarded-request", draft: "Keep after cancelled navigation", owner: sessionOwner() });
  const router = createMemoryRouter([{ path: "*", element: <GuardedHarness /> }], {
    initialEntries: [{ pathname: "/app/geo/geo_1/accuracy", search: "?error=claim_1&conversation=open&session=ses_1", state: { runtimeUiIntent: intent } }],
  });
  render(<RouterProvider router={router} />);
  const user = userEvent.setup();
  const secondLink = screen.getByRole("button", { name: "Second claim" });
  for (const trigger of [screen.getByRole("button", { name: "First claim" }), secondLink]) {
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Cancel detail navigation" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Committed location")).toHaveTextContent("error=claim_1");
    expect(router.state.location.state).toEqual({ runtimeUiIntent: intent });
  }
  await user.click(secondLink);
  await user.click(screen.getByRole("button", { name: "Continue to detail" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("claim_2");
  expect(screen.getByLabelText("Committed location")).toHaveTextContent("session=ses_1");
});

it.each(["confirm", "form"] as const)("pauses an independent %s opened while AI is pending and restores it after collapse", async (independentModal) => {
  setViewportWidth(1440);
  const descriptor = { projectId: target.projectId, sessionId: target.sessionId, scope: { kind: "geo", geoProjectId: target.geoId, sessionId: target.sessionId } };
  let finish = (_: typeof descriptor) => {};
  openNative.mockImplementationOnce(() => new Promise<typeof descriptor>((resolve) => { finish = resolve; }));
  renderAt(resultPath, { independentModal });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "让 AI 写纠错稿" }));
  fireEvent.click(screen.getByRole("button", { name: "Review independent result" }));
  const role = independentModal === "confirm" ? "alertdialog" : "dialog";
  const name = independentModal === "confirm" ? "Independent confirmation" : "Independent form";
  const independent = screen.getByRole(role, { name });
  await act(async () => { finish(descriptor); });
  const composer = await screen.findByRole("textbox", { name: "会话草稿" });
  expect(independent).not.toBeVisible();
  expect(composer).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole("link", { name: "收起对话" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole(role, { name })).toBe(independent);
  expect(independent).toContainElement(document.activeElement as HTMLElement);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole(role, { name })).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "讲错的说法" })).toBeVisible();
});


it("yields a newly selected detail when another draft opens in the same session", async () => {
  setViewportWidth(1440);
  renderAt();
  const user = userEvent.setup();
  const draft = () => screen.getByRole("button", { name: "让 AI 写纠错稿" });
  await user.click(draft());
  await screen.findByRole("textbox", { name: "会话草稿" });
  await user.click(screen.getByRole("button", { name: "Second claim" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("claim_2");
  await user.click(draft());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Committed location")).toHaveTextContent("session=ses_1");
  await user.click(screen.getByRole("link", { name: "收起对话" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("claim_2");
  expect(draft()).toHaveFocus();
});


it("reopens the same ordinary detail on a keyboard selection while retaining the pending intent", async () => {
  setViewportWidth(1440);
  renderAt();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "让 AI 写纠错稿" }));
  await screen.findByRole("textbox", { name: "会话草稿" });
  const pending = optionalOpaqueRuntimeUiIntent(JSON.parse(screen.getByLabelText("Committed state").textContent ?? "{}"))!;
  expect(pending.draft).toBe("Write a draft about the selected claim.");
  await user.click(screen.getByRole("button", { name: "Apply filter" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const first = screen.getByRole("button", { name: "First claim" });
  first.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog")).toHaveFocus();
  expect(optionalOpaqueRuntimeUiIntent(JSON.parse(screen.getByLabelText("Committed state").textContent ?? "{}"))).toEqual(pending);
  fireEvent.click(screen.getByRole("button", { name: "History back" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Committed location")).toHaveTextContent("error=claim_1");
});

it("keeps a restored sibling confirmation above a drawer opened while the conversation was active", async () => {
  setViewportWidth(1440);
  let complete: (value: unknown) => void = () => undefined;
  openNative.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  renderAt(resultPath, { independentModal: "confirm" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "让 AI 写纠错稿" }));
  fireEvent.click(screen.getByRole("button", { name: "Review independent result" }));
  expect(screen.getByRole("alertdialog")).toBeVisible();
  await act(async () => complete({
    projectId: target.projectId, sessionId: target.sessionId,
    scope: { kind: "geo", geoProjectId: target.geoId, sessionId: target.sessionId },
  }));
  await screen.findByRole("textbox", { name: "会话草稿" });
  await user.click(screen.getByRole("button", { name: "Second claim" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("claim_2");
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "收起对话" }));
  const confirmation = await screen.findByRole("alertdialog");
  expect(confirmation).toContainElement(document.activeElement as HTMLElement);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getByRole("dialog")).toHaveTextContent("claim_2");
});

function GroupJourney() {
  const location = useLocation();
  const navigate = useNavigate();
  const drawer = useGeoDrawerAddress();
  const tab = location.pathname.endsWith("/questions") ? "questions" : "visibility";
  const query = new URLSearchParams(location.search);
  return <>
    <output aria-label="Group location">{location.pathname + location.search}</output>
    <output aria-label="Group state">{JSON.stringify(location.state)}</output>
    <button onClick={() => { void navigate(-1); }}>Group history back</button>
    <WorkspaceSplit open={query.get("conversation") === "open"} retainResults splitOverride collapseTo="/app/geo/geo_1/questions"
      {...geoResultDrawerProps(query, location.state, tab, { analysis: false, distribution: false })}
      conversation={<Composer />}
      results={<>
        {tab === "visibility"
          ? <ClusterLink groupId="group-a" geoId="geo_1" tab="questions">Open group elsewhere</ClusterLink>
          : <ClusterLink groupId="group-a">Open current group</ClusterLink>}
        {drawer.group && <Drawer title="Group detail" onClose={drawer.close}>
          <AskAi project={target} label="Ask about group" draft="Keep this group draft" />
        </Drawer>}
      </>} />
  </>;
}

it("opens a cross-page group link and can select the same hidden group again by keyboard", async () => {
  let complete: (value: unknown) => void = () => undefined;
  openNative.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const pending = prepareRuntimeUiIntent({ kind: "open", projectId: target.projectId, sessionId: target.sessionId, requestId: "pending-native", draft: "Pending native draft", owner: sessionOwner() });
  render(<MemoryRouter initialEntries={[{ pathname: "/app/geo/geo_1/visibility", search: "?conversation=open&session=ses_1", state: { runtimeUiIntent: pending, extra: "kept" } }]}><GroupJourney /></MemoryRouter>);
  const user = userEvent.setup();
  const crossPage = screen.getByRole("link", { name: "Open group elsewhere" });
  crossPage.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("dialog", { name: "Group detail" })).toBeVisible();
  expect(screen.getByLabelText("Group location")).toHaveTextContent("/questions?");
  expect(screen.getByLabelText("Group location")).toHaveTextContent("session=ses_1");
  expect(JSON.parse(screen.getByLabelText("Group state").textContent ?? "{}")).toMatchObject({ runtimeUiIntent: pending, extra: "kept" });
  await user.click(screen.getByRole("button", { name: "Ask about group" }));
  expect(openNative).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: "Group detail" })).toBeVisible();
  expect(optionalOpaqueRuntimeUiIntent(JSON.parse(screen.getByLabelText("Group state").textContent ?? "{}"))?.draft).toBe("Pending native draft");
  await act(async () => complete({
    projectId: target.projectId, sessionId: target.sessionId,
    scope: { kind: "geo", geoProjectId: target.geoId, sessionId: target.sessionId },
  }));
  await waitFor(() => {
    expect(optionalOpaqueRuntimeUiIntent(JSON.parse(screen.getByLabelText("Group state").textContent ?? "{}"))?.draft).toBe("Keep this group draft");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  const samePage = screen.getByRole("link", { name: "Open current group" });
  samePage.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog")).toHaveFocus();
  expect(optionalOpaqueRuntimeUiIntent(JSON.parse(screen.getByLabelText("Group state").textContent ?? "{}"))?.draft).toBe("Keep this group draft");
  fireEvent.click(screen.getByRole("button", { name: "Group history back" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it.each(["Apply filter", "First claim"])("does not copy a legacy plaintext intent when using %s", async (control) => {
  setViewportWidth(1440);
  const marker = { kind: "open", projectId: target.projectId, sessionId: target.sessionId, requestId: "legacy-result" };
  render(<MemoryRouter initialEntries={[{
    pathname: "/app/geo/geo_1/accuracy", search: "?error=claim_1&conversation=open&session=ses_1",
    state: { runtimeUiIntent: { ...marker, draft: "Previous account's draft", owner: "previous" }, extra: "retained" },
  }]}><Harness /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: control }));
  const state = JSON.parse(screen.getByLabelText("Committed state").textContent ?? "{}");
  expect(state.runtimeUiIntent).toEqual(marker);
  expect(state.extra).toBe("retained");
});
