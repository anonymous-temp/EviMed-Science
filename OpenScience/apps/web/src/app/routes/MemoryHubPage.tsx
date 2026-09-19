import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router";
import { WorkbenchTabs, type WorkbenchTab } from "@/components/layout/WorkbenchTabs";
import { useMemoryWritePrompt } from "@/components/memory/useMemoryWritePrompt";
import { CapsuleMethodsSection } from "@/components/capsule/CapsuleMethodsSection";
import { CapsuleOverview } from "@/components/capsule/CapsuleOverview";
import { CapsuleTimeline } from "@/components/capsule/CapsuleTimeline";
import { LibrarySection } from "@/components/capsule/LibrarySection";
import { ProjectDossierSection } from "@/components/capsule/ProjectDossierSection";
import { ReceivedShelf } from "@/components/capsule/ReceivedShelf";
import { UnderstandingSection } from "@/components/capsule/UnderstandingSection";
import { announceMemoryChanged, ensureMyCapsule } from "@/lib/memoryClient";
import type { CapsuleRecord } from "@/lib/productClient";
import { MemoryPage } from "./MemoryPage";
import { CapsulesPage } from "./CapsulesPage";
import { CapsuleTransferPanel } from "./CapsuleTransferPanel";
import { MethodsPage } from "./MethodsPage";

/** Sharing is of the researcher's one capsule, made on first use. */
function ShareOwnCapsule() {
  const [capsule, setCapsule] = useState<CapsuleRecord | null>(null);
  useEffect(() => {
    let active = true;
    void ensureMyCapsule().then((own) => { if (active) setCapsule(own); }, () => { /* export waits; import still works */ });
    return () => { active = false; };
  }, []);
  return <CapsuleTransferPanel capsule={capsule} onImported={() => announceMemoryChanged()} />;
}

/**
 * 「记忆胶囊」: one capsule per person, in six sections (proposal §4.2, owner
 * ruling 2026-09-19).
 *
 * It used to be three tabs named after the implementation — 记忆, 方法胶囊,
 * 学习方法 — over one thing the researcher calls their capsule, with a
 * 「新建胶囊」 button that invited a second one nobody needed. The sections now
 * follow what the capsule is for: who you are (总览, 对你的理解), what this
 * project knows (项目档案), how you work (方法), what you have read (资料), and
 * how all of it grew (时间轴). Managing capsules one by one is still there,
 * folded away under 方法.
 */
const TABS: readonly WorkbenchTab[] = [
  { key: "overview", label: "总览", render: () => <CapsuleOverview /> },
  { key: "understanding", label: "对你的理解", render: () => <UnderstandingSection notes={<MemoryPage embedded />} /> },
  { key: "project", label: "项目档案", render: () => <ProjectDossierSection /> },
  {
    key: "methods",
    label: "方法",
    render: () => (
      <CapsuleMethodsSection
        learned={<MethodsPage embedded />}
        received={<ReceivedShelf />}
        share={<ShareOwnCapsule />}
        manage={<CapsulesPage embedded />}
      />
    ),
  },
  { key: "library", label: "资料", render: () => <LibrarySection /> },
  { key: "timeline", label: "时间轴", render: () => <CapsuleTimeline /> },
];

/** Addresses people kept from before the six sections, and where each now lives. */
const TAB_ALIASES: Record<string, string> = { notes: "understanding", capsules: "methods" };

export function MemoryHubPage() {
  const location = useLocation();
  // 「刚记住了 … 撤销」 for what changed by itself since the last visit.
  useMemoryWritePrompt();
  const params = new URLSearchParams(location.search);
  const tab = params.get("tab");
  if (tab && TAB_ALIASES[tab]) {
    params.set("tab", TAB_ALIASES[tab]);
    return <Navigate to={{ pathname: location.pathname, search: `?${params.toString()}` }} replace />;
  }
  // An inbox notice names a memory (`?record=`); it lives in 对你的理解, which
  // points on to 项目档案 when the memory is the project's.
  if (!tab && params.get("record")) {
    params.set("tab", "understanding");
    return <Navigate to={{ pathname: location.pathname, search: `?${params.toString()}` }} replace />;
  }
  return (
    <WorkbenchTabs
      title="记忆胶囊"
      description="EviMed 对你的理解、这个项目的档案、你的方法和资料，都在这一个胶囊里。它随每次任务自动更新，每处改动都能撤销。"
      tabs={TABS}
    />
  );
}
