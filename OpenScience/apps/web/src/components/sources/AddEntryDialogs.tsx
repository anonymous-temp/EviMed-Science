import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Input, Textarea } from "@/components/ui/Input";
import { productErrorMessage } from "@/lib/productClient";
import { addSourceLink, addSourceNote, type SourceRecord } from "@/lib/sourceClient";

/**
 * 「添加网页链接」: one address. The control plane reads the page (a site's robots.txt is honoured, a page drawn in
 * script is rendered, a PDF goes through the parser) and keeps a snapshot; a page it cannot read is said in a
 * sentence here, in the dialog, where the address was typed.
 */
export function AddLinkDialog({ projectId, onClose, onAdded }: {
  projectId: string;
  onClose: () => void;
  onAdded: (source: SourceRecord) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const added = await addSourceLink(projectId, url.trim());
      onAdded(added.source);
    } catch (failure) {
      setError(productErrorMessage(failure));
      setBusy(false);
    }
  };
  return (
    <FormDialog title="添加网页链接" onClose={onClose} busy={busy}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (url.trim() && !busy) void submit(); }}>
        <Input label="网址" type="url" inputMode="url" placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)}
          error={error} disabled={busy} autoComplete="off" />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" loading={busy} disabled={!url.trim()}>添加</Button>
        </div>
      </form>
    </FormDialog>
  );
}

/** 「新建笔记」: a title and the text. The note opens in its drawer once it is written. */
export function NewNoteDialog({ projectId, onClose, onAdded }: {
  projectId: string;
  onClose: () => void;
  onAdded: (source: SourceRecord) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const added = await addSourceNote(projectId, { title: title.trim(), body });
      onAdded(added.source);
    } catch (failure) {
      setError(productErrorMessage(failure));
      setBusy(false);
    }
  };
  return (
    <FormDialog title="新建笔记" onClose={onClose} busy={busy}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (title.trim() && !busy) void submit(); }}>
        <Input label="标题" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} disabled={busy} autoComplete="off" />
        <Textarea label="正文" value={body} rows={8} onChange={(event) => setBody(event.target.value)} disabled={busy} error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" loading={busy} disabled={!title.trim()}>保存</Button>
        </div>
      </form>
    </FormDialog>
  );
}
