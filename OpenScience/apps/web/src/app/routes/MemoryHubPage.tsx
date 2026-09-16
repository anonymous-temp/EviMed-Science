import { WorkbenchTabs, type WorkbenchTab } from "@/components/layout/WorkbenchTabs";
import { MemoryPage } from "./MemoryPage";
import { CapsulesPage } from "./CapsulesPage";
import { MethodsPage } from "./MethodsPage";

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
  // What the learning loop distilled, and what a researcher wrote themselves,
  // with what each candidate still lacks (2026-09-16 review, P2 #15).
  { key: "methods", label: "学习方法", render: () => <MethodsPage /> },
];

export function MemoryHubPage() {
  return (
    <WorkbenchTabs
      title="记忆"
      description="长期有效的研究背景与偏好、可复用可分享的方法胶囊，以及 EviMed 从任务中学到的方法。"
      tabs={TABS}
    />
  );
}
