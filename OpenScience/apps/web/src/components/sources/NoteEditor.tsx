import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { LoadError } from "@/components/cards/LoadError";
import { productErrorMessage } from "@/lib/productClient";
import { getSourceNote, saveSourceNote, type SourceRecord } from "@/lib/sourceClient";
import { toast } from "@/lib/toast";

/**
 * A note's own text, editable: a title and the text under it. 「保存」 writes the note's next version and it is read
 * again; the page then follows the document that now stands. A note nobody changed is saved as nothing.
 */
export function NoteEditor({ source, onSaved }: { source: SourceRecord; onSaved: (source: SourceRecord) => void }) {
  const [stored, setStored] = useState<{ title: string; body: string } | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setStored(null);
    setError(null);
    getSourceNote(source.id).then(
      (note) => { if (active) { setStored(note); setTitle(note.title); setBody(note.body); } },
      (failure) => { if (active) setError(`无法打开这篇笔记：${productErrorMessage(failure)}`); },
    );
    return () => { active = false; };
  }, [source.id, attempt]);
  if (error && !stored) return <LoadError message={error} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!stored) return <p role="status" className="text-ui text-text-3">正在打开</p>;
  const changed = title.trim() !== stored.title || body !== stored.body;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveSourceNote(source.id, { title: title.trim(), body });
      if (!live.current) return;
      toast.success(saved.changed ? "已保存，正在重新读取" : "没有改动");
      onSaved(saved.source);
    } catch (failure) {
      if (live.current) setError(productErrorMessage(failure));
    } finally {
      if (live.current) setSaving(false);
    }
  };
  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (changed && title.trim() && !saving) void save(); }}>
      <Input label="标题" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} disabled={saving} autoComplete="off" />
      <Textarea label="正文" value={body} rows={14} onChange={(event) => setBody(event.target.value)} disabled={saving} error={error} />
      <div className="flex justify-end">
        <Button type="submit" loading={saving} disabled={!changed || !title.trim()}>保存</Button>
      </div>
    </form>
  );
}
