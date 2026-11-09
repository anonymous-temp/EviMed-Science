import type { ComponentProps, ReactNode } from "react";
import { PageShell } from "@/components/layout/PageShell";
import type { HeadlineProps } from "@/components/ui/Headline";
import type { ToolbarProps } from "@/components/ui/Toolbar";
import { MemoryControls } from "./MemoryControls";
import { MEMORY_TAB_NAMES, type MemoryPageTab } from "./memoryTabs";

/** What the frame takes: the capsule's own controls, which the pages answer — a drawer to open, or the page to read again. */
export type MemoryFrameControls = Omit<ComponentProps<typeof MemoryControls>, "children">;

/**
 * 「记忆胶囊」's frame: the lists and the overview are two routes and read as one page. Where the researcher is among them is the global
 * sidebar's nested directory (`MemoryWorkspaceNav`, 2026-11-08), so the page keeps no navigation of its own: each section is a page whose
 * heading is the section's name, with the capsule's controls (记住这一条, the menu, the 「记忆」 switch) in the header, the section's one
 * toolbar row in the sticky band and the overview's sentence over the body.
 *
 * Anatomy: the section's heading with the capsule controls, and the selected page.
 * Variants: overview (wide measure) and the three lists.
 * States: the capsule controls and child page own their loading and error states.
 * Hit area: shared capsule controls own their targets.
 * Keyboard: native controls retain their document order.
 * Long content: page content owns its reading width.
 * Theme: semantic page, border and text roles.
 * Responsive: PageShell owns the header's wrapping; the sidebar overlay holds the directory on a narrow screen.
 * Verification: MemoryHubPage and MemoryOverviewPage tests and browser reflow.
 */
export function MemoryFrame({ tab, controls, toolbar, headline, children }: {
  tab: MemoryPageTab;
  controls: MemoryFrameControls;
  /** The section's row of controls: the lists' search, 收到的's one action, the overview's range, filters and search. */
  toolbar: ToolbarProps;
  /** The overview's one sentence. */
  headline?: HeadlineProps;
  children: ReactNode;
}) {
  const name = MEMORY_TAB_NAMES[tab];
  return (
    <div data-memory-frame={tab === "overview" ? "overview" : "list"} className="h-full min-h-0 bg-bg">
      <MemoryControls {...controls}>
        {({ remember, memorySwitch, menu }) => (
          <PageShell title={tab === "overview" ? "记忆胶囊" : name} documentTitle={`记忆胶囊 · ${name}`} width={tab === "overview" ? "wide" : undefined} toolbar={toolbar} headline={headline}
            actions={<div className="flex flex-wrap items-center justify-end gap-2">{remember}{menu}{memorySwitch}</div>}>
            {children}
          </PageShell>
        )}
      </MemoryControls>
    </div>
  );
}
