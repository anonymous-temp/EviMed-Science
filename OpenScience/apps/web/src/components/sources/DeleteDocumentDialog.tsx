import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { SourceRecord } from "@/lib/sourceClient";
import { documentDeletionNote } from "./deletionNotes";

/**
 * 「删除这份资料？」: the confirmation of deleting a document from the knowledge base, on the list and in the reader. The knowledge base
 * lists a file once, so deleting it takes every copy the account holds of it; the dialog says which projects hold it and which others
 * lose it with it (`documentDeletionNote`), rather than promising only that it is no longer used to answer.
 */
export function DeleteDocumentDialog({ source, labels, onCancel, onConfirm }: {
  source: SourceRecord;
  labels: ReadonlyMap<string, string>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const note = documentDeletionNote(source, labels);
  return (
    <ConfirmDialog title="删除这份资料？" subject={`“${source.display.title}”`} body={note.body} consequences={note.consequences}
      confirmLabel="删除" onCancel={onCancel} onConfirm={onConfirm} />
  );
}
