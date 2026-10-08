import { lazy, Suspense } from "react";
import { ExternalLink } from "lucide-react";
import { buttonClasses } from "@/components/ui/Button";
import { extOf, extToKind } from "@/lib/artifacts";
import { formatDay } from "@/lib/format";
import type { SourceRecord } from "@/lib/sourceClient";
import { NoteEditor } from "./NoteEditor";
import { isEditableNote, originalPathOf } from "./sourceView";

const FilePreviewInspector = lazy(() => import("@/components/inspector/FilePreviewInspector").then((module) => ({ default: module.FilePreviewInspector })));

const noop = () => undefined;

/**
 * A document's original, in the left column of its page — what the document itself is, by its type (design reference
 * §13.1):
 *
 *  - a paper, a guideline, a Word or PDF document: the file itself, which the browser's own PDF viewer opens at the page
 *    asked for (`page`; the viewer cannot mark a sentence — that waits for a renderer of our own);
 *  - a document in the cloud drive, whose original is not in the project: the text that was read from it;
 *  - a saved web page: the snapshot that was taken, with the address it was taken from;
 *  - a note: its editor, and saving it makes the next version;
 *  - a table: a preview of the table; a picture: the picture.
 *
 * The file viewer decides how a file is drawn; this decides which file, and what to say when there is none. A document
 * whose reading failed still has its original, so it is still shown; one whose original was removed says so.
 */
export function SourceOriginal({ source, page, onNoteSaved }: {
  source: SourceRecord;
  page?: number;
  onNoteSaved: (source: SourceRecord) => void;
}) {
  if (isEditableNote(source)) {
    return <div className="h-full overflow-y-auto bg-surface p-6"><NoteEditor source={source} onSaved={onNoteSaved} /></div>;
  }
  if (source.payload.status === "missing") return <Unavailable>原件已移除，这份资料的原文看不到了。</Unavailable>;
  const path = originalPathOf(source);
  if (!path) return <Unavailable>这份资料的原文暂时看不到。</Unavailable>;
  const filename = path.slice(path.lastIndexOf("/") + 1);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Provenance source={source} />
      <div className="min-h-0 flex-1">
        <Suspense fallback={<p role="status" className="p-6 text-ui text-text-3">正在打开预览</p>}>
          <FilePreviewInspector embedded onClose={noop} page={page}
            data={{ variant: "file", path, filename, artifact: extToKind(extOf(filename)), root: "base", projectId: source.projectId }} />
        </Suspense>
      </div>
    </div>
  );
}

/** What the text in the column is, when it is not the file the researcher gave: a snapshot of a page, or a drive document read as text. */
function Provenance({ source }: { source: SourceRecord }) {
  const { display } = source;
  if (display.origin === "link") {
    const fetchedAt = source.payload.link?.fetchedAt;
    const taken = fetchedAt ? `，抓取于 ${formatDay(fetchedAt)}` : "";
    return (
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-4 py-2 text-caption text-text-3">
        <span className="min-w-0">{`这是网页的快照${taken}`}</span>
        {display.url && (
          <a href={display.url} target="_blank" rel="noopener noreferrer" className={buttonClasses({ variant: "text", size: "sm", className: "px-1.5" })}>
            打开原网页<ExternalLink size={16} aria-hidden="true" />
          </a>
        )}
      </p>
    );
  }
  if (display.origin === "drive") {
    return <p className="border-b border-border bg-surface px-4 py-2 text-caption text-text-3">原件在网盘里，这里是从它读出的文本。</p>;
  }
  return null;
}

function Unavailable({ children }: { children: string }) {
  return <p className="p-6 text-ui text-text-3">{children}</p>;
}
