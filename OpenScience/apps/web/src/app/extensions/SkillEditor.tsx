import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import type { SkillWrite } from "@/lib/skillLibraryClient";

export function SkillEditor({ initial, busy, onSave, onCancel }: {
  initial: SkillWrite; busy: boolean; onSave: (value: SkillWrite) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); onSave(value); }}>
    <Input label="名称" value={value.title} maxLength={80} required disabled={busy} onChange={event => setValue({ ...value, title: event.target.value })} />
    <Textarea label="用途" value={value.description} maxLength={1024} disabled={busy} onChange={event => setValue({ ...value, description: event.target.value })} />
    <Textarea label="技能说明" value={value.instructions} className="min-h-64 font-mono" required disabled={busy} onChange={event => setValue({ ...value, instructions: event.target.value })} />
    <div className="flex gap-2"><Button type="submit" loading={busy}>保存</Button><Button type="button" variant="text" disabled={busy} onClick={onCancel}>取消</Button></div>
  </form>;
}
