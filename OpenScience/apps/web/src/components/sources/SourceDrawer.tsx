import { lazy, Suspense, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { IconButton } from "@/components/ui/IconButton";
import { Menu } from "@/components/ui/Menu";
import { Tabs } from "@/components/ui/Tabs";
import { downloadArtifact } from "@/lib/artifactFile";
import { extOf, extToKind } from "@/lib/artifacts";
import { parseFailureMessage } from "@/lib/errorText";
import type { SourceRecord } from "@/lib/sourceClient";
import { toast } from "@/lib/toast";
import { NoteEditor } from "./NoteEditor";
import { SourceContent } from "./SourceContent";
import { sourceMenuItems } from "./SourceRow";
import { drawerMeta, fileNameOf, isUsable } from "./sourceView";

const FilePreviewInspector = lazy(() => import("@/components/inspector/FilePreviewInspector").then((module) => ({ default: module.FilePreviewInspector })));

type DrawerTab = "content" | "source";

/**
 * Where a document's original is read from: its own file, or — for a document that lives in the cloud drive, whose
 * original is not in the project — the text that was read from it.
 */
export function originalPathOf(source: SourceRecord): string | null {
  if (source.display.origin === "drive") return source.payload.outputs?.artifactPath ?? null;
  return source.payload.paths[0] ?? null;
}

/**
 * One document, opened from its row: what it says (「内容」) and its original (「原文」), the two things a researcher
 * opens a document for; under them, the two things to do with it — use it in a conversation, take it away. A note's
 * original is its editor. Everything else one can do to a document is in 「⋯」, the same four as on the row.
 */
export function SourceDrawer({ source, busy, duplicate, onClose, onUse, onRetry, onShare, onDuplicates, onDelete, onNoteSaved }: {
  source: SourceRecord;
  busy: boolean;
  duplicate: boolean;
  onClose: () => void;
  onUse: () => void;
  onRetry: () => void;
  onShare: () => void;
  onDuplicates: () => void;
  onDelete: () => void;
  onNoteSaved: (source: SourceRecord) => void;
}) {
  const note = source.display.kind === "note" && source.display.origin === "note";
  const [tab, setTab] = useState<DrawerTab>(note ? "source" : "content");
  const [page, setPage] = useState<number | undefined>(undefined);
  const path = originalPathOf(source);
  const filename = path ? path.slice(path.lastIndexOf("/") + 1) : fileNameOf(source);
  const menu = sourceMenuItems(source, { duplicate, busy, onRetry, onShare, onDuplicates, onDelete });
  const download = async () => {
    if (!path) return;
    try { await downloadArtifact(path, "base", filename, source.projectId); }
    catch (failure) { toast.error(`无法下载 ${filename}：${parseFailureMessage(failure, "该文件")}`); }
  };
  return (
    <Drawer title={source.display.title} onClose={onClose} bare widthClassName="max-w-xl">
      <div className="flex h-full flex-col">
        <header className="shrink-0 px-6 pt-5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-caption text-text-3">{drawerMeta(source)}</p>
              <h2 className="mt-1 break-words text-title font-semibold text-text">{source.display.title}</h2>
            </div>
            <Menu label={`“${source.display.title}”的操作`} items={menu} />
            <IconButton icon={X} label="关闭" onClick={onClose} />
          </div>
          <Tabs className="mt-4" label="资料视图" panelId="source-drawer-panel" value={tab} onChange={setTab}
            items={[{ value: "content", label: "内容" }, { value: "source", label: "原文" }]} />
        </header>
        <div id="source-drawer-panel" role="tabpanel" aria-labelledby={`source-drawer-panel-tab-${tab}`}
          className={tab === "source" && !note ? "min-h-0 flex-1" : "min-h-0 flex-1 overflow-y-auto px-6 py-6"}>
          {tab === "content" && <SourceContent source={source} busy={busy} onRetry={onRetry}
            onShowPage={(next) => { setPage(next); setTab("source"); }} />}
          {tab === "source" && (note ? <NoteEditor source={source} onSaved={onNoteSaved} />
            : path ? (
              <Suspense fallback={<p role="status" className="p-6 text-ui text-text-3">正在打开预览</p>}>
                <FilePreviewInspector embedded onClose={onClose} page={page}
                  data={{ variant: "file", path, filename, artifact: extToKind(extOf(filename)), root: "base", projectId: source.projectId }} />
              </Suspense>
            ) : <p className="text-ui text-text-3">这份资料的原文暂时看不到。</p>)}
        </div>
        <footer className="flex shrink-0 items-center gap-2 border-t border-border px-6 py-4">
          <Button className="min-w-0 flex-1" disabled={!isUsable(source)} onClick={onUse}>
            <MessageSquare size={16} aria-hidden="true" />在对话中使用
          </Button>
          <Button variant="secondary" disabled={!path} onClick={() => void download()}>下载</Button>
        </footer>
      </div>
    </Drawer>
  );
}
