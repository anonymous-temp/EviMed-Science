import { WorkbenchTabs, type WorkbenchTab } from "@/components/layout/WorkbenchTabs";
import { MemoryPage } from "./MemoryPage";
import { CapsulesPage } from "./CapsulesPage";

/**
 * Memory: what EviMed remembers, and the method packages built out of it.
 *
 * 「科研记忆」 and 「记忆胶囊」 were two sibling navigation rows whose names
 * differ by one word, and nothing on either page said which one a given thing
 * belonged in (2026-09-15 walk, C1). The design spec's §23.1 had already
 * decided this — capsules replace `/memory` and it carries sub-pages — and the
 * implementation kept them side by side instead. This is that decision.
 */
const TABS: readonly WorkbenchTab[] = [
  { key: "notes", label: "记忆", render: () => <MemoryPage embedded /> },
  { key: "capsules", label: "方法胶囊", render: () => <CapsulesPage embedded /> },
];

export function MemoryHubPage() {
  return (
    <WorkbenchTabs
      title="记忆"
      description="长期有效的研究背景与偏好，以及可复用、可分享的方法胶囊。"
      tabs={TABS}
    />
  );
}
