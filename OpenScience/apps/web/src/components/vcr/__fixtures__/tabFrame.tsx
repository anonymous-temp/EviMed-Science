import { useMemo, useState, type ReactNode } from "react";
import { vi } from "vitest";
import { Toolbar, type ToolbarProps } from "@/components/ui/Toolbar";
import { StudyFrameContext, type StudyFrameApi } from "../studyFrameContext";

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
