import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import type { SkillWrite } from "@/lib/skillLibraryClient";

/** What the two prose fields are for, said under each: they are the skill's real shape, not a guess (the purpose is what the model reads to decide whether to load the skill, the text is what it follows once it has). */
const PURPOSE_HINT = "写清什么时候该用它。对话里 EviMed 靠这一句决定要不要用到这个技能。";
const INSTRUCTIONS_HINT = "写清怎么做：需要什么输入、分几步、产出什么、哪些事不能做。";
const TITLE_EXAMPLE = "例如：随访资料整理";
const PURPOSE_EXAMPLE = "例如：我给出一批随访记录，需要按时间整理成可核对的表格时使用。";
const INSTRUCTIONS_EXAMPLE = "适用情况：…\n需要的输入：…\n步骤：\n1. …\n2. …\n产出：…\n不要做：…";

/**
 * The form a skill is written and edited in: a name, the purpose, the text.
 *
 * Creating (`create`) shows an example in each field and a switch — on by default — that selects the new skill for the
 * current project as it is saved, because a skill nobody has switched on is used nowhere and nothing else in the form says
 * so. Editing keeps the same captions and none of that. A name, purpose or text that is empty or only spaces is named in place and
 * sends nothing: the server would refuse it with a toast that names no field.
 */
export function SkillEditor({ initial, busy, onSave, onCancel, create }: {
  initial: SkillWrite; busy: boolean;
  /** `useInProject` is the create form's switch; an edit never turns it on. */
  onSave: (value: SkillWrite, useInProject: boolean) => void; onCancel: () => void;
  create?: { projectName: string };
}) {
  const [value, setValue] = useState(initial);
  const [useInProject, setUseInProject] = useState(true);
  const [errors, setErrors] = useState<{ title?: string; description?: string; instructions?: string }>({});
  const titleField = useRef<HTMLInputElement>(null), instructionsField = useRef<HTMLTextAreaElement>(null), purposeField = useRef<HTMLTextAreaElement>(null);
  const base = useId();
  const purposeHint = `${base}-purpose-hint`, instructionsHint = `${base}-instructions-hint`;

  const submit = () => {
    const found = {
      ...(value.title.trim() ? {} : { title: "请填写名称" }),
      ...(value.description.trim() ? {} : { description: "请写出什么时候使用这个技能" }),
      ...(value.instructions.trim() ? {} : { instructions: "请写出这个技能怎么做" }),
    };
    setErrors(found);
    if (found.title) { titleField.current?.focus(); return; }
    if (found.description) { purposeField.current?.focus(); return; }
    if (found.instructions) { instructionsField.current?.focus(); return; }
    onSave({ ...value, title: value.title.trim(), description: value.description.trim() }, !!create && useInProject);
  };
  const change = (next: Partial<SkillWrite>) => {
    setValue({ ...value, ...next });
    // The sentence goes as soon as the field is being fixed, not at the next save.
    if (next.title !== undefined && errors.title) setErrors({ ...errors, title: undefined });
    if (next.description !== undefined && errors.description) setErrors({ ...errors, description: undefined });
    if (next.instructions !== undefined && errors.instructions) setErrors({ ...errors, instructions: undefined });
  };

  return <form className="flex flex-col gap-4" noValidate onSubmit={event => { event.preventDefault(); if (!busy) submit(); }}>
    <Input ref={titleField} label="名称" value={value.title} maxLength={80} aria-required="true" disabled={busy}
      placeholder={create ? TITLE_EXAMPLE : undefined} error={errors.title} onChange={event => change({ title: event.target.value })} />
    <div>
      <Textarea ref={purposeField} label="用途" aria-required="true" error={errors.description} value={value.description} maxLength={1024} disabled={busy} aria-describedby={purposeHint}
        placeholder={create ? PURPOSE_EXAMPLE : undefined} onChange={event => change({ description: event.target.value })} />
      <p id={purposeHint} className="mt-2 text-caption text-text-3">{PURPOSE_HINT}</p>
    </div>
    <div>
      <Textarea ref={instructionsField} label="技能说明" value={value.instructions} className={create ? "min-h-64" : "min-h-64 font-mono"} aria-required="true" disabled={busy}
        aria-describedby={instructionsHint} placeholder={create ? INSTRUCTIONS_EXAMPLE : undefined} error={errors.instructions}
        onChange={event => change({ instructions: event.target.value })} />
      <p id={instructionsHint} className="mt-2 text-caption text-text-3">{INSTRUCTIONS_HINT}</p>
    </div>
    {create && <Switch showLabel label={`保存后在“${create.projectName}”里使用`} checked={useInProject} disabled={busy} onChange={setUseInProject} />}
    <div className="flex gap-2"><Button type="submit" loading={busy}>保存</Button><Button type="button" variant="text" disabled={busy} onClick={onCancel}>取消</Button></div>
  </form>;
}
