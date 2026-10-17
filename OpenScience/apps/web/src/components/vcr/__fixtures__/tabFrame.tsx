import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { Toolbar, type ToolbarProps } from "@/components/ui/Toolbar";
import { StudyFrameContext, ToolbarSlotContext, type StudyFrameApi } from "../studyFrameContext";

/**
 * What the study frame gives a tab, for a test that renders one tab on its own (R19).
 *
 * A tab hands its controls to the frame's sticky band (`useVcrToolbar`), and the band draws them above the body. Rendered without a
 * frame a tab draws none, which is what it must do and is no way to test its controls. This stands in for the frame: the same
 * context, the same real `Toolbar` above the body in document order, and the doors a tab uses (`refresh`, `openChat`, `openPanel`)
 * as spies the test can read. The page's own conversation, panels and polling are the frame's and are held by its tests.
 */
export interface TabFrameSpies {
  refresh: ReturnType<typeof vi.fn>;
  openChat: ReturnType<typeof vi.fn>;
  openPanel: ReturnType<typeof vi.fn>;
}

export function makeFrameSpies(): TabFrameSpies {
  return { refresh: vi.fn(), openChat: vi.fn(), openPanel: vi.fn() };
}

export function TabFrame({ studyId, spies, version = "v1", children }: {
  studyId: string;
  spies?: TabFrameSpies;
  /** What the study's reads follow; a test changes it to say the study moved. */
  version?: string;
  children: ReactNode;
}) {
  const [toolbar, setToolbar] = useState<ToolbarProps | null | undefined>(undefined);
  const doors = useMemo(() => spies ?? makeFrameSpies(), [spies]);
  const api = useMemo<StudyFrameApi>(() => ({
    studyId,
    version,
    activity: null,
    refresh: doors.refresh,
    openChat: doors.openChat,
    openPanel: doors.openPanel,
    setToolbar,
  }), [studyId, version, doors]);
  return (
    <StudyFrameContext.Provider value={api}>
      {toolbar ? <div data-page-chrome=""><Toolbar {...toolbar} /></div> : null}
      <div data-page-body="">{children}</div>
    </StudyFrameContext.Provider>
  );
}

/**
 * The toolbar slot of the module home (`HomeFrame`), for a test that renders one of its libraries (方法库, 试验先例) on its own: the same
 * context, and the same real `Toolbar` above the body in document order.
 */
export function ToolbarSlotFrame({ children }: { children: ReactNode }) {
  const [toolbar, setToolbar] = useState<ToolbarProps | null | undefined>(undefined);
  return (
    <ToolbarSlotContext.Provider value={setToolbar}>
      {toolbar ? <div data-page-chrome=""><Toolbar {...toolbar} /></div> : null}
      <div data-page-body="">{children}</div>
    </ToolbarSlotContext.Provider>
  );
}

/**
 * A tab drawn the way the study page draws it: inside the router and the frame, with the frame's doors as spies.
 *
 * The spies are made here and handed back, so a test can say what the tab asked the page to do (`openChat`, `openPanel`, `refresh`)
 * without a frame of its own. `route` is the address the tab is read at (`?patient=…`, `?card=…`).
 */
export function renderTab(node: ReactElement, options: { studyId?: string; route?: string; version?: string } = {}) {
  const spies = makeFrameSpies();
  const wrap = (child: ReactElement, next: { studyId?: string; version?: string } = {}) => (
    <MemoryRouter initialEntries={[options.route ?? "/"]}>
      <TabFrame studyId={next.studyId ?? options.studyId ?? "std_1"} spies={spies} version={next.version ?? options.version}>{child}</TabFrame>
    </MemoryRouter>
  );
  const view = render(wrap(node));
  /** The same page after the study moved: a new `version`, which is what makes a study's reads follow it. */
  const rerenderTab = (child: ReactElement, next: { version?: string } = {}) => view.rerender(wrap(child, next));
  return { ...view, spies, rerenderTab };
}

/**
 * The room a master/detail page has, as `MasterDetail` measures it (jsdom has no layout): wide enough for the list beside the
 * record. Call it in `beforeEach` and run what it returns in `afterEach`.
 */
export function fakeRoom(width = 1400): () => void {
  const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { width: this.hasAttribute("data-master-detail") ? width : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  return () => spy.mockRestore();
}
